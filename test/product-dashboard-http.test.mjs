import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createArchive } from '../lib/archive.mjs';
import { createWorkspaceStore } from '../lib/workspace.mjs';
import { createOperationsStore } from '../lib/operations.mjs';

test('product dashboard HTTP reads scoped work, memory review and result insights without AI or durable changes', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-dashboard-http-')), dataDirectory = join(directory, 'data');
  const archive = createArchive({ directory:dataDirectory });
  let child, exited;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exited) await exited;
    await archive.close();
    await rm(directory, {recursive:true,force:true});
  });
  const workspace = createWorkspaceStore({directory:dataDirectory,storage:archive});
  const operations = createOperationsStore({directory:dataDirectory,storage:archive});
  const saveMemory = fields => workspace.mutate('saveMemory', {scopeId:'business',type:'fact',title:'Release runtime',content:'Use Node 24.',status:'confirmed',source:'Owner review',sharedWith:[],agentIds:[],...fields});
  const first = (await saveMemory({})).memories.at(-1);
  const second = (await saveMemory({title:'Runtime copy',content:'Use  Node 24.',agentIds:['forge']})).memories.at(-1);
  await saveMemory({scopeId:'personal',title:'PRIVATE_MEMORY_MARKER',content:'Use Node 24.',source:'PRIVATE_SOURCE_MARKER',sharedWith:['business']});
  await saveMemory({scopeId:'shared',title:'SHARED_MEMORY_MARKER',content:'Use Node 24.'});
  const procedure = (await workspace.mutate('saveWorkflow', {scopeId:'business',title:'Reviewed release procedure',input:'Brief',output:'Draft',status:'ready',steps:[{title:'Prepare draft',agentId:'forge',output:'Prepare a draft.'}]})).workflows.at(-1);
  const project = (await operations.mutate('createProject', {title:'Release project',scopeId:'business'})).projects.at(-1);
  const privateProject = (await operations.mutate('createProject', {title:'PRIVATE_PROJECT_MARKER',scopeId:'personal'})).projects.at(-1);
  const parent = (await operations.mutate('createTask', {projectId:project.id,title:'Approve release brief',workflowId:procedure.id})).tasks.at(-1);
  const dependent = (await operations.mutate('createTask', {projectId:project.id,title:'Prepare release',dependencies:[parent.id]})).tasks.at(-1);
  await operations.mutate('createTask', {projectId:privateProject.id,title:'PRIVATE_TASK_MARKER'});
  const originalWorkspace = await workspace.getSnapshot(), originalOperations = await operations.getSnapshot();
  await archive.close();

  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  child = spawn(process.execPath, ['server.mjs'], {cwd:resolve('.'),env:{...process.env,PORT:String(port),FUORI_STUDIO_DATA_DIR:dataDirectory,FUORI_STUDIO_CODEX_BIN:join(directory,'no-ai-executable'),FUORI_STUDIO_MODE:'local'},stdio:['ignore','pipe','pipe']});
  exited = once(child, 'exit');
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(Error('Server startup timeout')), 10000); let errors = '';
    child.stderr.on('data', chunk => errors += chunk);
    child.stdout.on('data', chunk => { if (String(chunk).includes('Fuori Studio')) { clearTimeout(timer); done(); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${errors}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function request(path, status = 200, headers) {
    const response = await fetch(base + path, {headers}); const value = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`); return value;
  }
  function durableRecords() {
    const db = new DatabaseSync(join(dataDirectory,'studio.sqlite'), {readOnly:true});
    try { return db.prepare('SELECT key,revision,hex(value) AS ciphertext,updated_at FROM records ORDER BY key').all(); }
    finally { db.close(); }
  }
  const before = durableRecords();
  const today = await request('/api/today?scopeId=business');
  assert.equal(today.readOnly, true); assert.equal(today.noAiCalls, true);
  assert.deepEqual(today.projects.map(item => item.id), [project.id]);
  assert.equal(today.counts.ready, 1); assert.equal(today.counts.waiting, 1);
  assert.deepEqual(today.groups.ready.items.map(item => item.id), [parent.id]);
  assert.equal(today.groups.ready.items[0].unblocks, 1);
  assert.equal(today.groups.waiting.items[0].id, dependent.id);
  assert.deepEqual(today.groups.waiting.items[0].dependencies, [{id:parent.id,title:parent.title,available:true}]);
  assert.doesNotMatch(JSON.stringify(today), /PRIVATE_|SHARED_MEMORY_MARKER/);
  assert.equal((await request(`/api/today?scopeId=business&projectId=${project.id}`)).counts.ready, 1);

  const review = await request('/api/memory/review?scopeId=business');
  assert.equal(review.readOnly, true); assert.equal(review.noAiCalls, true);
  assert.deepEqual(review.summary, {total:2,duplicateGroups:1,duplicateMemories:2,agingMemories:0,reviewMemories:2});
  assert.deepEqual(review.duplicates[0].memories.map(item => item.id).sort(), [first.id,second.id].sort());
  assert.doesNotMatch(JSON.stringify(review), /PRIVATE_|SHARED_MEMORY_MARKER/);

  const governance = await request('/api/governance?scopeId=business');
  assert.equal(governance.daily.calls, 0); assert.deepEqual(governance.usages, []);
  assert.equal(governance.insights.scopeId, 'business');
  assert.deepEqual(governance.insights.projects.map(item => item.id), [project.id]);
  assert.equal(governance.insights.projects[0].assignments, 2);
  assert.equal(governance.insights.projects[0].calls.total, 0);
  assert.equal(governance.insights.projects[0].deliveries.approvalRatio, null);
  assert.deepEqual(governance.insights.procedures.map(item => item.id), [procedure.id]);
  assert.equal(governance.insights.procedures[0].assignments, 1);
  assert.doesNotMatch(JSON.stringify(governance.insights), /PRIVATE_/);

  await request('/api/today?scopeId=missing', 404);
  await request(`/api/today?scopeId=business&projectId=${privateProject.id}`, 404);
  await request('/api/governance?scopeId=missing', 404);
  await request('/api/memory/review?scopeId=missing', 403);
  await request('/api/memory/review?scopeId=*', 400);
  for (const path of ['/api/today?scopeId=business','/api/memory/review?scopeId=business','/api/governance?scopeId=business']) await request(path, 403, {Origin:'https://evil.example'});
  assert.deepEqual(await request('/api/workspace'), originalWorkspace);
  const {scheduler, ...currentOperations} = await request('/api/operations');
  assert.deepEqual(currentOperations, originalOperations);
  assert.deepEqual(durableRecords(), before, 'Dashboard reads must not rewrite any encrypted archive record.');
});
