import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

// The fake is deliberately process-local and never used by the production app.
// Git snapshots and the configured Node test are real; no paid inference occurs.
test('HTTP repository workflow preserves dirty source, captures real checks and patch, gates approval and memory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-repository-http-'));
  const repo = join(directory, 'source'), data = join(directory, 'data'), bin = join(directory, 'fake-codex.cjs');
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: directory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
  git('init', '-q', repo);
  await writeFile(join(repo, 'value.mjs'), 'export const value = 1;\n');
  await writeFile(join(repo, 'value.test.mjs'), "import assert from 'node:assert/strict'; import {value} from './value.mjs'; assert.equal(value, 2);\n");
  git('-C', repo, 'add', '.'); git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  await writeFile(join(repo, 'value.mjs'), 'export const value = 999; // owner uncommitted edit\n');
  await writeFile(bin, `#!${process.execPath}\nconst fs=require('node:fs'), cp=require('node:child_process'), path=require('node:path');
const args=process.argv.slice(2), at=args.indexOf('-C'), cwd=at>=0?args[at+1]:process.cwd();
if(args.includes('app-server'))process.exit(1);
if(args.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
if(args[0]==='sandbox'){const split=args.indexOf('--');const child=cp.spawnSync(args[split+1],args.slice(split+2),{cwd,env:process.env,encoding:'utf8'});process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');process.exit(child.status??1);}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{if(fs.existsSync(path.join(cwd,'value.mjs')))fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value = 2;\\n');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Modifica preparata; verificare i risultati registrati.'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));});\n`, { mode: 0o700 });
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), FUORI_STUDIO_DATA_DIR: data, FUORI_STUDIO_CODEX_BIN: bin, FUORI_STUDIO_MODE: 'local' }, stdio: ['ignore','pipe','pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(directory, { recursive: true, force: true }); });
  await new Promise((done, reject) => { const timer = setTimeout(() => reject(Error('Server startup timed out')), 10000); let errors=''; child.stderr.on('data', d=>errors+=d); child.stdout.on('data',d=>{if(String(d).includes('Fuori Studio')){clearTimeout(timer);done();}}); child.on('exit',code=>{clearTimeout(timer);if(code)reject(Error(errors));}); });
  const origin = `http://127.0.0.1:${port}`;
  async function request(url, payload, status = 200) {
    const response = await fetch(origin + url, payload ? { method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify(payload) } : {});
    const body = await response.json(); assert.equal(response.status,status,JSON.stringify(body)); return body;
  }
  const before = await request('/api/repositories'); assert.equal(before.available,true); assert.equal(before.runs.length,0);
  const project = (await request('/api/operations',{action:'createProject',payload:{title:'Repository fixture',scopeId:'development'}})).projects[0];
  const registered = await request('/api/repositories',{action:'register',payload:{projectId:project.id,scopeId:project.scopeId,path:repo,checks:[{label:'Value test',program:'node',args:['--test','value.test.mjs']}]}});
  assert.equal(registered.repositories[0].dirty,true);
  await request('/api/repositories',{action:'register',payload:{projectId:project.id,scopeId:'personal',path:repo,checks:[]}},403);
  let snapshot = await request('/api/repositories',{action:'create',payload:{repositoryId:registered.repositories[0].id,title:'Correct value',brief:'Set value to 2.'}});
  let run = snapshot.runs[0];
  await request('/api/repositories',{action:'approve',payload:{id:run.id,expectedVersion:run.version}},409);
  const preview=await request('/api/execution/preview',{kind:'repository',id:run.id,expectedVersion:run.version});
  assert.equal(preview.budget.allowed,true); assert.equal(preview.id,run.id);
  snapshot=await request('/api/repositories',{action:'start',payload:{id:run.id,expectedVersion:run.version,previewId:preview.previewId}});
  for(let attempt=0;attempt<150;attempt++){snapshot=await request('/api/repositories');run=snapshot.runs[0];if(run.status!=='running')break;await new Promise(done=>setTimeout(done,40));}
  assert.equal(run.status,'review',JSON.stringify(run)); assert.equal(run.checks[0].status,'passed'); assert.equal(run.checks[0].exitCode,0); assert.match(run.checks[0].output,/pass 1|tests 1/);
  assert.equal(Object.hasOwn(run,'patch'),false); assert.equal(Object.hasOwn(run,'cwd'),false);
  assert.match(await readFile(join(repo,'value.mjs'),'utf8'),/999/);
  const patch=await fetch(origin+'/api/repositories/patch?id='+run.id);assert.equal(patch.status,200);assert.match(patch.headers.get('content-disposition'),/attachment/);assert.match(await patch.text(),/\+export const value = 2/);
  await request('/api/repositories',{action:'proposeMemory',payload:{id:run.id,title:'Decision',content:'Approved value.'}},409);
  snapshot=await request('/api/repositories',{action:'approve',payload:{id:run.id,expectedVersion:run.version}});run=snapshot.runs[0];assert.equal(run.status,'completed');
  const memory=await request('/api/repositories',{action:'proposeMemory',payload:{id:run.id,expectedVersion:run.version,title:'Value convention',content:'Use the agreed value in this project.',type:'decision'}});
  assert.equal(memory.workspace.memories[0].status,'proposed'); assert.equal(memory.workspace.memories[0].scopeId,'development');
  await request('/api/execution/preview',{kind:'repository',id:run.id,expectedVersion:run.version},409);
  await request('/api/repositories',{action:'start',payload:{id:run.id,expectedVersion:run.version,previewId:preview.previewId}},409);
});
