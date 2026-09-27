import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getState, newConversation, selectScope, providerStatus, chatTurn, shutdownChat } from './lib/chat.mjs';
import { workspaceStore } from './lib/workspace.mjs';
import { operationsStore } from './lib/operations.mjs';
import { providerStore } from './lib/providers.mjs';
import { taskExecutor } from './lib/executor.mjs';
import { acquireInstanceLock } from './lib/instance-lock.mjs';
import { productBriefSteps } from './lib/task-templates.mjs';

const appRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(appRoot, 'dist');
const port = Number(process.env.PORT || 4386);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT non valida.');
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 120000) throw fail('Richiesta troppo lunga.', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { throw fail('Messaggio non valido.'); }
}
let changing = false, closing = false, routineError = null;
const releaseLock = await acquireInstanceLock(resolve(process.env.FUORI_STUDIO_DATA_DIR || resolve(appRoot, '.local')));
try { await getState(); await operationsStore.recoverInterrupted(); await providerStore.getSnapshot(); }
catch (error) { await releaseLock(); throw error; }
const isBusy = async () => taskExecutor.busy || (await getState()).busy;
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
      if (action === 'createTask') payload = { ...payload, steps: selected.workflow.steps.map(step => ({ title: step.title, agentId: step.agentId, instruction: step.output })) };
    } else if (action === 'createTask' && payload.steps) throw fail('Scegli una procedura pronta per definire più passaggi.');
  }
  return operationsStore.mutate(action, payload);
}
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (!allowedHosts.has(req.headers.host)) { json(res, 403, { error: 'Host non consentito.' }); return; }
  const origin = req.headers.origin;
  if (origin && !Array.from(allowedHosts).some(host => origin === `http://${host}`)) { json(res, 403, { error: 'Origine non consentita.' }); return; }
  if (req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { error: 'Richiesta esterna non consentita.' }); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (pathname.startsWith('/api/')) {
      if (req.method === 'GET' && pathname === '/api/studio') { json(res, 200, { ...(await getState()), provider: await providerStatus() }); return; }
      if (req.method === 'GET' && pathname === '/api/workspace') { json(res, 200, await workspaceStore.getSnapshot()); return; }
      if (req.method === 'GET' && pathname === '/api/operations') { json(res, 200, { ...(await operationsStore.getSnapshot()), scheduler: { intervalSeconds: 30, error: routineError } }); return; }
      if (req.method === 'GET' && pathname === '/api/providers') { json(res, 200, await providerStore.getSnapshot()); return; }
      if (req.method !== 'POST' || req.headers['x-fuori-studio'] !== 'local' || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: 'Richiesta non consentita.' }); return; }
      const payload = await body(req);
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
        // Reserve the chat before any other mutation can change its authorization snapshot.
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); res.flushHeaders();
        const controller = new AbortController(); let complete = false;
        res.on('close', () => { if (!complete) controller.abort(); });
        const emit = (type, data) => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': waiting\n\n'); }, 15000);
        try { await chatTurn(payload.message, emit, controller.signal, { scopeId: payload.scopeId, workflowId: payload.workflowId || null }); }
        catch (error) { emit('error', { message: error.message }); }
        finally { complete = true; clearInterval(heartbeat); res.end(); }
        } finally { changing = false; }
        return;
      }
      changing = true;
      try {
        if (pathname === '/api/conversation/new') { json(res, 200, await newConversation()); return; }
        if (pathname === '/api/conversation/scope') { json(res, 200, await selectScope(payload.scopeId)); return; }
        if (pathname === '/api/workspace') { await requireIdle(); json(res, 200, await workspaceStore.mutate(payload.action, payload.payload)); return; }
        if (pathname === '/api/operations') { json(res, 200, await operationsMutation(payload.action, payload.payload)); return; }
        if (pathname === '/api/providers') {
          await requireIdle();
          if (payload.action === 'setScopePolicy') {
            if (!(await workspaceStore.getSnapshot()).scopes.some(scope => scope.id === payload.payload?.scopeId)) throw fail('Ambito non trovato.');
          }
          json(res, 200, await providerStore.mutate(payload.action, payload.payload)); return;
        }
        if (pathname === '/api/providers/test') { await requireIdle(); json(res, 200, await providerStore.testConnection({ id: payload.id })); return; }
        if (pathname === '/api/tasks/run') { await requireIdle(); json(res, 200, await taskExecutor.start(payload.id, payload.expectedVersion)); return; }
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
  try { await taskExecutor.tick(); routineError = null; }
  catch { routineError = 'Una routine non è stata accodata. Controlla l’archivio e le routine prima di riprovare.'; }
  finally { ticking = false; }
}
const scheduler = setInterval(tick, 30000); scheduler.unref();
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.on('error', async error => { clearInterval(scheduler); await releaseLock(); console.error(error.code === 'EADDRINUSE' ? `La porta ${port} è già occupata. Prova PORT=4387 npm start.` : error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => { console.log(`Fuori Studio è pronto: http://127.0.0.1:${port}/`); void tick(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  closing = true; clearInterval(scheduler); shutdownChat(); server.close();
  try { await taskExecutor.shutdown(); await releaseLock(); } finally { process.exit(0); }
});
