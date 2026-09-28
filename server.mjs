import { createExecutionPreview } from './lib/execution-preview.ts';
import { createStudioSearch } from './lib/studio-search.ts';
import { prepareWorkflowTask } from './lib/workflow-inputs.mjs';
import { createWorkflowLearning } from './lib/workflow-learning.ts';
import { createTeamStore } from './lib/team.ts';
import { applyAgentNames } from './dist/data.js';
import { createServer } from 'node:http';
import { readFile, stat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep, extname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getState, newConversation, selectScope, providerStatus, chatTurn, shutdownChat, rememberMessage, previewChat, conversations } from './lib/chat.mjs';
import { workspaceStore } from './lib/workspace.mjs';
import { operationsStore } from './lib/operations.mjs';
import { providerStore, configureCodexExecution, configureExecutionGovernor } from './lib/providers.mjs';
import { taskExecutor } from './lib/executor.mjs';
import { acquireInstanceLock } from './lib/instance-lock.mjs';
import { productBriefSteps } from './lib/task-templates.mjs';

import { defaultArchive } from './lib/archive.mjs';
import { createIdentity } from './lib/identity.mjs';
import { createDeviceHub } from './lib/devices.mjs';
import { createSyncService } from './lib/sync.mjs';
import { runCodex } from './lib/codex.mjs';
import { createPortability } from './lib/portability.mjs';
import { createRepositoryWork } from './lib/repository-work.mjs';
import { createPlanService } from './lib/plans.ts';
import { createGovernance, aggregateOperations } from './lib/governance.ts';
import { createSourceStore } from './lib/sources.ts';
import { configureSourceContext } from './lib/context.mjs';
import { createRepositoryDeviceHub } from './lib/repository-devices.ts';
import { createMaintenance } from './lib/maintenance.ts';
import { deploymentSnapshot } from './lib/deployment.ts';
import { createGitHub } from './lib/github.ts';
import { createMemoryEvaluations } from './lib/memory-evaluations.ts';

const appRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(appRoot, 'dist');
const port = Number(process.env.PORT || 4386);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT non valida.');
const mode = process.env.FUORI_STUDIO_MODE || 'local';
const identity = createIdentity({ storage: defaultArchive });
const publicOrigin = identity.publicOrigin || `http://127.0.0.1:${port}`;
const allowedHosts = new Set(mode === 'local' ? [`127.0.0.1:${port}`, `localhost:${port}`] : [new URL(publicOrigin).host]);
const allowedOrigins = new Set(mode === 'local' ? [...allowedHosts].map(host => `http://${host}`) : [publicOrigin]);
const bindHost = mode === 'local' ? '127.0.0.1' : (process.env.FUORI_STUDIO_BIND || '127.0.0.1');
const devices = createDeviceHub({ storage: defaultArchive, publicUrl: mode === 'local' ? null : publicOrigin, allowLocalExecution: mode === 'local' });
const repositoryDevices = createRepositoryDeviceHub({ storage: defaultArchive, devices });
const maintenance = createMaintenance({ archive: defaultArchive, directory: resolve(process.env.FUORI_STUDIO_DATA_DIR || resolve(appRoot, '.local')) });
const sync = createSyncService({ storage: defaultArchive, workspace: workspaceStore, devices });
const portability = createPortability({storage:defaultArchive,workspace:workspaceStore});
const plans = createPlanService();
const governance = createGovernance({ storage: defaultArchive });
configureExecutionGovernor((...args) => governance.execute(...args));
const repositoryWork = createRepositoryWork({
  storage: defaultArchive, workspace: workspaceStore, operations: operationsStore, providers: providerStore, mode, projectRoot: appRoot, remote: repositoryDevices,
  executeEditor: (...args) => governance.execute(...args),
  authorizeExecution: async () => {
    if (mode !== 'local') {
      throw fail('Il lavoro sul repository locale richiede questa installazione locale. Per lo studio online scegli un computer repository autorizzato.', 409);
    }
  },
});
const github = createGitHub({ storage: defaultArchive, workspace: workspaceStore, approvedRun: input => repositoryWork.approvedPublication(input) });
const workflowLearning = createWorkflowLearning({operations:operationsStore,workspace:workspaceStore});
const team = createTeamStore({storage:defaultArchive});
const evaluations = createMemoryEvaluations({ storage: defaultArchive, workspace: workspaceStore });
const sources = createSourceStore({
  storage: defaultArchive, workspace: workspaceStore, mode,
  allowedRoots: async () => [appRoot, ...(await repositoryWork.snapshot()).repositories.filter(repository => !repository.executionTarget || repository.executionTarget === 'local').map(repository => repository.path), ...(process.env.FUORI_STUDIO_SOURCE_ROOTS || '').split(delimiter).filter(Boolean)],
  search: input => providerStore.research(input),
  github: input => github.readFile(input),
});
configureSourceContext(sources);
const studioSearch=createStudioSearch({workspace:workspaceStore,conversations,sources,operations:operationsStore,repositories:repositoryWork});
const executionPreviews=createExecutionPreview({
  prepare:{plan:input=>plans.preview(input),task:input=>taskExecutor.preview(input.id,input.expectedVersion,input.selection),repository:({id,expectedVersion,selection})=>repositoryWork.preview({id,expectedVersion,selection}),chat:input=>previewChat(input)},
  budget:plan=>governance.preflight({scopeId:plan.scopeId,...(plan.projectId?{projectId:plan.projectId}:{}),...(plan.kind==='task'?{taskId:plan.id}:plan.kind==='repository'?{runId:plan.id,budgetRunId:plan.budgetTarget.budgetRunId}:{}),requiredCalls:plan.kind==='chat'?Math.min(4,plan.steps.length):plan.steps.length}),
  destinations:async plan=>{
    const deviceState=await devices.snapshot();
    for(const step of plan.steps){
      if(step.connection?.type!=='codex'){step.destination={name:step.connection?.name||'',type:'api'};continue;}
      const target=plan.kind==='repository'&&step.agentId==='forge'?plan.configuration.executionTarget:deviceState.executionTarget;
      const worker=deviceState.devices.find(item=>item.id===target);
      step.destination={id:target||'local',name:target&&target!=='local'?(plan.configuration?.workerName||worker?.name||target):'Codex · questo computer',type:target&&target!=='local'?'paired':'local'};
    }
    return plan;
  },
});
configureCodexExecution({ authorize: scopeId => devices.authorize(scopeId), run: async (prompt, options) => { const result = await devices.run(prompt, options); return result === null ? runCodex(prompt, options) : result; } });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
async function body(req, limit = 120000) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw fail('Richiesta troppo lunga.', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { throw fail('Messaggio non valido.'); }
}
let changing = false, closing = false, routineError = null;
const releaseLock = await acquireInstanceLock(resolve(process.env.FUORI_STUDIO_DATA_DIR || resolve(appRoot, '.local')));
try { await defaultArchive.init(); applyAgentNames((await team.snapshot()).names); await identity.init(); await devices.recover(); await repositoryDevices.recover(); await getState(); await operationsStore.recoverInterrupted(); await providerStore.getSnapshot(); await repositoryWork.recoverInterrupted(); await governance.recoverInterrupted(); await github.recover(); await sources.allMetadata(); }
catch (error) { await releaseLock(); throw error; }
const isBusy = async () => taskExecutor.busy || repositoryWork.busy || (await getState()).busy;
const requireIdle = async () => { if (await isBusy()) throw fail('Attendi la risposta del team o metti in pausa l’incarico prima di modificare il contesto o i servizi.', 409); };
async function requireScope(scopeId) {
  const scope = (await workspaceStore.getSnapshot()).scopes.find(item => item.id === scopeId);
  if (!scope || ['shared', 'archive'].includes(scope.kind)) throw fail('Scegli un ambito operativo valido.');
  return scope;
}
async function operationsMutation(action, payload = {}) {
  const actions = ['createProject', 'saveProject', 'createTask', 'approveTask', 'requestChanges', 'restartTask', 'createRoutine', 'updateRoutine'];
  if (!actions.includes(action)) throw fail('Azione non disponibile.');
  if (['createProject', 'saveProject'].includes(action)) {
    await requireIdle();
    if (action === 'createProject') {
      await requireScope(payload.scopeId);
      if (Object.keys(payload).some(key => !['title', 'description', 'scopeId', 'kind', 'createScope'].includes(key)) || (payload.createScope !== undefined && typeof payload.createScope !== 'boolean') || (payload.kind !== undefined && !['owned', 'client'].includes(payload.kind)) || (payload.description !== undefined && (typeof payload.description !== 'string' || payload.description.length > 8000))) throw fail('Progetto non valido.');
      const { createScope, ...fields } = payload;
      if (createScope) {
        if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 100) throw fail('Nome progetto: usa 1–100 caratteri.');
        const before = await workspaceStore.getSnapshot();
        const after = await workspaceStore.mutate('createScope', { name: payload.title, kind: 'project', parentId: payload.scopeId });
        fields.scopeId = after.scopes.find(item => !before.scopes.some(old => old.id === item.id)).id;
      }
      return operationsStore.mutate(action, fields);
    }
    // A project's scope is immutable once tasks exist; the store enforces this too.
    if (payload.scopeId) await requireScope(payload.scopeId);
  }
  if (['createTask', 'createRoutine', 'updateRoutine'].includes(action)) {
    if(Object.hasOwn(payload,'workflowInputs'))throw fail('I valori compilati devono essere preparati dal server.');
    const state = await operationsStore.getSnapshot();
    const routine = action === 'updateRoutine' ? state.routines.find(item => item.id === payload.id) : null;
    const project = state.projects.find(item => item.id === (payload.projectId || routine?.projectId));
    if (!project) throw fail('Progetto non trovato.', 404);
    await requireScope(project.scopeId);
    const workflowId = Object.hasOwn(payload, 'workflowId') ? payload.workflowId : routine?.workflowId;
    if (action === 'createTask' && payload.template) {
      if (payload.template !== 'product-brief' || workflowId || payload.steps) throw fail('Modello di incarico non valido.');
      const { template, ...fields } = payload;
      payload = { ...fields, steps: productBriefSteps() };
    } else if (workflowId) {
      const selected = await workspaceStore.getContext({ scopeId: project.scopeId, query: '', agentId: payload.agentId || routine?.agentId || 'nova', workflowId });
      const workflow=(await workspaceStore.getSnapshot()).workflows.find(item=>item.id===workflowId);
      const prepared=prepareWorkflowTask(workflow,{brief:payload.brief??routine?.workflowInputs?.originalBrief??routine?.brief??payload.title??routine?.title??'',inputValues:payload.inputValues??routine?.workflowInputs?.values??{},expectedWorkflowVersion:payload.expectedWorkflowVersion??routine?.workflowInputs?.workflowVersion});
      const {inputValues,expectedWorkflowVersion,...fields}=payload;
      payload={...fields,brief:prepared.brief,...(prepared.workflowInputs?{workflowInputs:prepared.workflowInputs}:{}),...(action==='createTask'?{steps:prepared.steps}:{})};
    } else if (action === 'createTask' && payload.steps) throw fail('Scegli una procedura pronta per definire più passaggi.');
  }
  if(Object.hasOwn(payload,'inputValues')||Object.hasOwn(payload,'expectedWorkflowVersion'))throw fail('Scegli una procedura per compilare i suoi campi.');
  return operationsStore.mutate(action, payload);
}
async function effectiveProviderStatus() {
  const current = await getState();
  try {
    const connection = await providerStore.assertAllowed({agentId:'nova',scopeId:current.scopeId});
    if (connection.id === 'codex') {
      const state = await devices.snapshot();
      if (state.executionTarget !== 'local') { const device = state.devices.find(item=>item.id===state.executionTarget); return { ready:true,provider:`Codex · ${device.name}`,auth:'Dispositivo collegato',reason:device.online?null:'Il lavoro attenderà il computer collegato.',waiting:!device.online }; }
    }
    return providerStatus();
  } catch(error) { return {ready:false,provider:'Servizi AI',reason:error.message}; }
}
async function governanceSnapshot() {
  return { ...await governance.snapshot(), metrics: aggregateOperations(await operationsStore.getSnapshot(), await repositoryWork.snapshot()) };
}
async function setupSnapshot(req) {
  return deploymentSnapshot({ storage: defaultArchive.info(), authenticated: Boolean(await identity.getSession(req)), workers: (await repositoryDevices.catalog()).workers, maintenance: await maintenance.snapshot() });
}
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (!allowedHosts.has(req.headers.host)) { json(res, 403, { error: 'Host non consentito.' }); return; }
  const origin = req.headers.origin;
  const callback = req.method === 'GET' && req.url.split('?')[0] === '/auth/callback';
  if (origin && !allowedOrigins.has(origin) && !callback) { json(res, 403, { error: 'Origine non consentita.' }); return; }
  if (req.headers['sec-fetch-site'] === 'cross-site' && !callback) { json(res, 403, { error: 'Richiesta esterna non consentita.' }); return; }
  try {
    const url = new URL(req.url, publicOrigin);
    const pathname = decodeURIComponent(url.pathname);
    if (mode !== 'local') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (pathname === '/healthz' && req.method === 'GET') {
      if (closing) { json(res, 503, { ok: false }); return; }
      try { const sentinel = await defaultArchive.read('system/key-check'); json(res, sentinel?.marker === 'fuori-studio-v1' ? 200 : 503, { ok: sentinel?.marker === 'fuori-studio-v1' }); }
      catch { json(res, 503, { ok: false }); }
      return;
    }
    if (await identity.handle(req, res, url)) return;
    if (pathname === '/api/session' && req.method === 'GET') { json(res, 200, await identity.getPublicStatus(req)); return; }
    if (pathname.startsWith('/api/device/')) {
      if (mode === 'local') throw fail('Il collegamento remoto richiede una modalità autenticata e HTTPS.', 403);
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) throw fail('Richiesta dispositivo non valida.', 403);
      const capability = { '/api/device/pair': null, '/api/device/disconnect': null, '/api/device/claim': 'execute', '/api/device/heartbeat': 'execute', '/api/device/result': 'execute', '/api/device/sync': 'sync', '/api/device/repositories/announce': 'repository', '/api/device/repositories/claim': 'repository', '/api/device/repositories/heartbeat': 'repository', '/api/device/repositories/result': 'repository' };
      if (!Object.hasOwn(capability, pathname)) throw fail('Comando dispositivo non trovato.',404);
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
      if (pathname !== '/api/device/pair') await devices.authenticate(token, capability[pathname]);
      const payload = await body(req, pathname === '/api/device/pair' ? 1024 : pathname.endsWith('/sync') || pathname === '/api/device/repositories/result' ? 8 * 1024 * 1024 : 600000);
      if (pathname === '/api/device/pair') { json(res, 200, await devices.pair(payload)); return; }
      if (pathname === '/api/device/disconnect') { const device = await devices.authenticate(token); await devices.mutate('revoke', {id:device.id}); await repositoryDevices.cancelDevice(device.id); json(res, 200, {ok:true}); return; }
      if (pathname.startsWith('/api/device/repositories/')) {
        if (closing) throw fail('Il server si sta arrestando. Il lavoro non verrà riavviato automaticamente.', 503);
        const action = { announce: 'announce', claim: 'claim', heartbeat: 'heartbeat', result: 'finish' }[pathname.split('/').at(-1)];
        json(res, 200, await repositoryDevices[action](token, payload)); return;
      }
      if (pathname === '/api/device/claim') { json(res, 200, await devices.claim(token)); return; }
      if (pathname === '/api/device/heartbeat') { json(res, 200, await devices.finish(token, payload, true)); return; }
      if (pathname === '/api/device/result') { json(res, 200, await devices.finish(token, payload)); return; }
      if (pathname === '/api/device/sync') {
        if (changing || closing) throw fail('Studio occupato. Sincronizzazione rimandata.', 409);
        changing = true; try { await requireIdle(); json(res, 200, await sync.exchange(token, payload)); } finally { changing = false; } return;
      }
      throw fail('Comando dispositivo non trovato.', 404);
    }
    if (pathname.startsWith('/api/')) {
      const session = await identity.getSession(req);
      if (!session) throw fail('Accedi per continuare.', 401);
      if(req.method==='GET'&&pathname==='/api/search'){json(res,200,await studioSearch.search({scopeId:url.searchParams.get('scopeId'),query:url.searchParams.get('q')||'',...(url.searchParams.has('kinds')?{kinds:url.searchParams.get('kinds').split(',').filter(Boolean)}:{}),offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||30)}));return;}
      if(req.method==='GET'&&pathname==='/api/search/original'){json(res,200,await studioSearch.original(Object.fromEntries(['scopeId','kind','id','conversationId','sourceScopeId'].filter(key=>url.searchParams.has(key)).map(key=>[key,url.searchParams.get(key)]))));return;}
      if(req.method==='GET'&&pathname==='/api/budgets'){json(res,200,await governance.budgets());return;}
      if (req.method === 'GET' && pathname === '/api/team') { json(res, 200, await team.snapshot()); return; }
      if (req.method === 'GET' && pathname === '/api/setup') { json(res, 200, await setupSnapshot(req)); return; }
      if (req.method === 'GET' && pathname === '/api/github') { json(res, 200, await github.snapshot()); return; }
      if (req.method === 'GET' && pathname === '/api/evaluations') { json(res, 200, await evaluations.snapshot({ scopeId: url.searchParams.get('scopeId') })); return; }
      if (req.method === 'GET' && pathname === '/api/maintenance/backup') {
        const file = await maintenance.backupFile({ id: url.searchParams.get('id') });
        const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes;
        try { bytes = await handle.readFile(); } finally { await handle.close(); }
        if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw fail('Il backup è cambiato. Download rifiutato.', 409);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${file.filename}"`, 'Cache-Control': 'no-store' });
        res.end(bytes); return;
      }
      if (req.method === 'GET' && pathname === '/api/access') { json(res, 200, { ...(await identity.getPublicStatus(req)), storage: defaultArchive.info(), ...(await devices.snapshot()), sync: await sync.snapshot() }); return; }
      if (req.method === 'GET' && pathname === '/api/studio') { json(res, 200, { ...(await getState()), provider: await effectiveProviderStatus() }); return; }
      if (req.method === 'GET' && pathname === '/api/workspace') { json(res, 200, await workspaceStore.getSnapshot()); return; }
      if (req.method === 'GET' && pathname === '/api/operations') { json(res, 200, { ...(await operationsStore.getSnapshot()), scheduler: { intervalSeconds: 30, error: routineError } }); return; }
      if (req.method === 'GET' && pathname === '/api/providers') { json(res, 200, await providerStore.getSnapshot()); return; }
      if (req.method === 'GET' && pathname === '/api/governance') { json(res, 200, await governanceSnapshot()); return; }
      if (req.method === 'GET' && pathname === '/api/sources') { json(res, 200, await sources.snapshot({ scopeId: url.searchParams.get('scopeId') })); return; }
      if (req.method === 'GET' && pathname === '/api/sources/detail') { json(res, 200, await sources.detail({ id: url.searchParams.get('id'), scopeId: url.searchParams.get('scopeId') })); return; }
      if (req.method === 'GET' && pathname === '/api/repositories') { json(res, 200, await repositoryWork.snapshot()); return; }
      if (req.method === 'GET' && pathname === '/api/repositories/patch') {
        const artifact = await repositoryWork.patch({ id: url.searchParams.get('id') });
        const filename = artifact.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
        res.end(artifact.patch); return;
      }
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: 'Richiesta non consentita.' }); return; }
      identity.authorizeMutation(req, session);
      const payload = await body(req, pathname === '/api/memory/preview-import' ? 16 * 1024 * 1024 : pathname === '/api/sources' ? 12 * 1024 * 1024 : 120000);
      if (pathname === '/api/devices' && payload.action === 'revoke') { const result = await devices.mutate(payload.action, payload.payload); await repositoryDevices.cancelDevice(payload.payload.id); json(res, 200, result); return; }
      if (changing || closing) throw fail('Lo studio sta completando un’altra operazione. Riprova tra poco.', 409);
      if (pathname === '/api/chat') {
        changing = true;
        try {
        if (await isBusy()) throw fail('Lo studio è occupato. Attendi o metti in pausa l’incarico.', 409);
        if (typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 12000) throw fail('Scrivi un messaggio tra 1 e 12.000 caratteri.');
        const current = await getState();
        if (payload.scopeId !== current.scopeId) throw fail('L’ambito è cambiato in un’altra scheda. Ricarica la pagina prima di inviare.', 409);
        if (payload.workflowId != null && typeof payload.workflowId !== 'string') throw fail('Procedura non valida.');
        if (payload.workflowId) await workspaceStore.getContext({ scopeId: payload.scopeId, query: payload.message, agentId: 'nova', workflowId: payload.workflowId });
        await providerStore.assertAllowed({ agentId: 'nova', scopeId: payload.scopeId });
        const previewPlan=await executionPreviews.consume(payload.previewId,{kind:'chat',message:payload.message,scopeId:payload.scopeId,workflowId:payload.workflowId||null});
        // Reserve the chat before any other mutation can change its authorization snapshot.
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); res.flushHeaders();
        const controller = new AbortController(); let complete = false;
        res.on('close', () => { if (!complete) controller.abort(); });
        if (res.destroyed) controller.abort();
        const emit = (type, data) => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': waiting\n\n'); }, 15000);
        try { await chatTurn(payload.message, emit, controller.signal, { scopeId: payload.scopeId, workflowId: payload.workflowId || null, previewPlan }); }
        catch (error) { emit('error', { message: error.message }); }
        finally { complete = true; clearInterval(heartbeat); res.end(); }
        } finally { changing = false; }
        return;
      }
      changing = true;
      try {
        if(pathname==='/api/execution/preview'){await requireIdle();json(res,200,await executionPreviews.preview(payload));return;}
        if(pathname==='/api/budgets'){
          await requireIdle();
          if(payload.action!=='configureBudget'||!payload.payload||Object.keys(payload.payload).some(key=>!['projectId','taskId','runId','callLimit','expectedVersion'].includes(key)))throw fail('Impostazione del budget non valida.');
          const input=payload.payload,state=await operationsStore.getSnapshot(),project=state.projects.find(item=>item.id===input.projectId);
          if(!project||input.taskId&&input.runId)throw fail('Progetto o incarico non valido.');
          let target={scopeId:project.scopeId,projectId:project.id};
          if(input.taskId){const task=state.tasks.find(item=>item.id===input.taskId&&item.projectId===project.id);if(!task)throw fail('Incarico non trovato.',404);target={...target,taskId:task.id};}
          if(input.runId){target=await repositoryWork.budgetTarget({id:input.runId});if(target.projectId!==project.id)throw fail('Il lavoro appartiene a un altro progetto.');}
          json(res,200,await governance.configureBudget({...target,callLimit:input.callLimit,expectedVersion:input.expectedVersion}));return;
        }
        if (pathname === '/api/evaluations') {
          await requireIdle();
          if (!['saveCase', 'removeCase', 'runCase', 'feedback'].includes(payload.action) || !payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) throw fail('Azione valutazione non disponibile.');
          json(res, 200, await evaluations[payload.action](payload.payload)); return;
        }
        if (pathname === '/api/github') {
          await requireIdle();
          if (!['save', 'disconnect', 'inspect', 'preview', 'publish', 'reconcile', 'checks'].includes(payload.action) || !payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) throw fail('Azione GitHub non disponibile.');
          const result = await github[payload.action](payload.payload);
          json(res, 200, { result, snapshot: await github.snapshot() }); return;
        }
        if (pathname === '/api/workflows/learn') {
          await requireIdle();
          if (!['preview','save'].includes(payload.action)) throw fail('Azione procedura non disponibile.');
          json(res,200,await workflowLearning[payload.action](payload.payload)); return;
        }
        if (pathname === '/api/team') { await requireIdle(); const value=await team.rename(payload); applyAgentNames(value.names); json(res,200,value); return; }
        if (pathname === '/api/maintenance') {
          await requireIdle();
          if (payload.action === 'backup') await maintenance.createBackup();
          else if (payload.action === 'verify') await maintenance.verify();
          else throw fail('Azione manutenzione non disponibile.');
          json(res, 200, await setupSnapshot(req)); return;
        }
        if (pathname === '/api/sources') {
          await requireIdle();
          if (!['importText', 'importDocument', 'importUrl', 'importGitHub', 'importFolder', 'refresh', 'remove', 'searchWeb'].includes(payload.action) || !payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) throw fail('Azione fonti non disponibile.');
          const controller = new AbortController(); let complete = false;
          res.on('close', () => { if (!complete) controller.abort(); });
          if (res.destroyed) controller.abort();
          try { const result = await sources[payload.action]({ ...payload.payload, signal: controller.signal }); complete = true; json(res, 200, result); }
          finally { complete = true; }
          return;
        }
        if (pathname === '/api/governance') {
          await requireIdle();
          if (payload.action === 'configure') await governance.configure(payload.payload);
          else if (payload.action === 'saveOutcome') {
            const input = payload.payload;
            const record = input?.taskId ? (await operationsStore.getSnapshot()).tasks.find(task => task.id === input.taskId) : (await repositoryWork.snapshot()).runs.find(run => run.id === input?.runId);
            if (!record || record.status !== 'completed') throw fail('Puoi valutare una consegna approvata e presente nello studio.', 409);
            await governance.saveOutcome(input);
          } else throw fail('Azione risultati non disponibile.');
          json(res, 200, await governanceSnapshot()); return;
        }
        if (pathname === '/api/plans') {
          await requireIdle();
          if (!['draft', 'commit'].includes(payload.action)) throw fail('Azione piano non disponibile.');
          const controller = new AbortController(); let complete = false;
          res.on('close', () => { if (!complete) controller.abort(); });
          if (res.destroyed) controller.abort();
          try { const plan=payload.action==='draft'?await executionPreviews.consume(payload.payload?.previewId,{kind:'plan',projectId:payload.payload?.projectId,brief:payload.payload?.brief}):null;const result = await plans[payload.action](payload.payload, controller.signal,plan); complete = true; json(res, 200, result); }
          finally { complete = true; }
          return;
        }
        if (pathname === '/api/repositories') {
          if (Object.keys(payload).some(key => !['action', 'payload'].includes(key)) || !['register', 'refresh', 'create', 'start', 'pause', 'approve', 'requestChanges', 'proposeMemory'].includes(payload.action)) throw fail('Azione repository non disponibile.');
          if (payload.action !== 'pause') await requireIdle();
          const fields={...payload.payload};if(Object.hasOwn(fields,'previewPlan')||Object.hasOwn(fields,'contextSelection')||Object.hasOwn(fields,'selection'))throw fail('Rivedi il contesto attraverso l’anteprima.');if(payload.action==='start'){fields.previewPlan=await executionPreviews.consume(fields.previewId,{kind:'repository',id:fields.id});delete fields.previewId;}
          const result = await repositoryWork[payload.action](fields);
          json(res, 200, payload.action === 'proposeMemory' ? { workspace: result, ...await repositoryWork.snapshot() } : result); return;
        }
        if (pathname === '/api/memory/export') { await requireIdle(); json(res,200,await portability.export(payload)); return; }
        if (pathname === '/api/memory/preview-import') { await requireIdle(); json(res,200,await portability.preview(payload)); return; }
        if (pathname === '/api/memory/import') { await requireIdle(); json(res,200,await portability.commit(payload)); return; }
        if (pathname === '/api/memory/remember') { await requireIdle(); json(res, 200, await rememberMessage(payload)); return; }
        if (pathname === '/api/devices') {
          await requireIdle();
          if (payload.action === 'pair') {
            if (mode === 'local') throw fail('Genera il codice dallo studio online, protetto da HTTPS e account.', 409);
            const scopes = (await workspaceStore.getSnapshot()).scopes;
            if (!Array.isArray(payload.payload?.scopeIds) || payload.payload.scopeIds.some(id => !scopes.some(scope => scope.id === id))) throw fail('Ambiti del dispositivo non validi.');
          }
          json(res, 200, await devices.mutate(payload.action, payload.payload)); return;
        }
        if (pathname === '/api/sync') { await requireIdle(); json(res, 200, await sync.mutate(payload.action, payload.payload)); return; }
        if (pathname === '/api/conversation/new') { await requireIdle(); json(res, 200, await newConversation()); return; }
        if (pathname === '/api/conversation/scope') { await requireIdle(); json(res, 200, await selectScope(payload.scopeId)); return; }
        if (pathname === '/api/workspace') { await requireIdle(); json(res, 200, await workspaceStore.mutate(payload.action, payload.payload)); return; }
        if (pathname === '/api/operations') { json(res, 200, await operationsMutation(payload.action, payload.payload)); return; }
        if (pathname === '/api/providers') {
          await requireIdle();
          if (payload.action === 'setScopePolicy') {
            if (!(await workspaceStore.getSnapshot()).scopes.some(scope => scope.id === payload.payload?.scopeId)) throw fail('Ambito non trovato.');
          }
          json(res, 200, await providerStore.mutate(payload.action, payload.payload)); return;
        }
        if (pathname === '/api/providers/test') {
          await requireIdle();
          const controller = new AbortController(); let complete = false;
          res.on('close', () => { if (!complete) controller.abort(); });
          if (res.destroyed) controller.abort();
          try {
            const result = await providerStore.testConnection({ id: payload.id, scopeId: (await getState()).scopeId, signal: controller.signal });
            complete = true; json(res, 200, result);
          } finally { complete = true; }
          return;
        }
        if (pathname === '/api/tasks/run') { await requireIdle(); json(res, 200, await taskExecutor.start(payload.id, payload.expectedVersion,await executionPreviews.consume(payload.previewId,{kind:'task',id:payload.id}))); return; }
        if (pathname === '/api/tasks/pause') { json(res, 200, await taskExecutor.pause(payload.id, payload.expectedVersion)); return; }
        if (pathname === '/api/tasks/memory') { await requireIdle(); json(res, 200, await taskExecutor.proposeMemory(payload)); return; }
        json(res, 404, { error: 'Comando non trovato.' }); return;
      } finally { changing = false; }
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const file = await realpath(resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)));
    if (!file.startsWith(root + sep)) { res.writeHead(403); res.end('Accesso negato'); return; }
    const info = await stat(file); if (!info.isFile()) { res.writeHead(404); res.end('Non trovato'); return; }
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch (error) {
    if (!res.headersSent) json(res, req.url.startsWith('/api/') ? (error.statusCode || error.status || 400) : 404, { error: req.url.startsWith('/api/') ? error.message : 'Non trovato' });
    else res.end();
  }
});
let ticking = false;
async function tick() {
  if (closing || changing || ticking) return;
  ticking = true;
  try {
    await taskExecutor.tick(); routineError = null;
    const limits = await governance.snapshot();
    if (limits.settings.autonomousRoutines && limits.settings.autonomousEnabledAt && !changing && !await isBusy() && limits.daily.remaining > 0 && limits.daily.autonomousRemaining > 0) {
      const state = await operationsStore.getSnapshot();
      const candidates = state.tasks.filter(task => task.status === 'queued' && task.routineId && task.createdAt >= limits.settings.autonomousEnabledAt && state.routines.some(routine => routine.id === task.routineId && routine.enabled));
      if (candidates.length && !changing) {
        changing = true;
        try {
          for (const next of candidates) {
            const currentLimits = await governance.snapshot();
            if (currentLimits.daily.remaining <= 0 || currentLimits.daily.autonomousRemaining <= 0) break;
            const claim = await governance.claimRoutine({ routineId: next.routineId, scopeId: next.scopeId, occurrenceId: next.id });
            if (!claim.claimed) continue;
            try { await taskExecutor.start(next.id, next.version); }
            catch { await operationsStore.mutate('pauseTask', { id: next.id, expectedVersion: next.version, message: 'Avvio automatico non riuscito. Rivedi contesto, servizi e limiti prima di riprendere manualmente.' }); }
            break;
          }
        } finally { changing = false; }
      }
    }
  }
  catch { routineError = 'Una routine non è stata accodata. Controlla l’archivio e le routine prima di riprovare.'; }
  finally { ticking = false; }
}
const scheduler = setInterval(tick, 30000); scheduler.unref();
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.on('error', async error => { clearInterval(scheduler); await releaseLock(); console.error(error.code === 'EADDRINUSE' ? `La porta ${port} è già occupata. Prova PORT=4387 npm start.` : error.message); process.exitCode = 1; });
server.listen(port, bindHost, () => { console.log(`Fuori Studio è pronto: ${publicOrigin}/ (${mode})`); void tick(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  closing = true; clearInterval(scheduler); shutdownChat(); server.close();
  try { await Promise.allSettled([taskExecutor.shutdown(), repositoryWork.shutdown()]); await defaultArchive.close(); await releaseLock(); } finally { process.exit(0); }
});
