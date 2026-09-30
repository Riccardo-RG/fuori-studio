import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createConversationStore} from '../lib/conversations.mjs';

test('HTTP conversation tasks use saved sources, protect internals and retry durably without provider calls',{timeout:15000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'fuori-conversation-task-http-')),data=join(directory,'data'),binary=join(directory,'codex-fixture'),calls=join(directory,'calls');
  await writeFile(binary,`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}fs.appendFileSync(${JSON.stringify(calls)},'unexpected inference\\n');process.exit(1);\n`,{mode:0o700});
  const conversations=createConversationStore({directory:data}),conversation=await conversations.load('business');
  conversation.messages.push({id:'http-saved-message',role:'assistant',agentId:'forge',text:'Prepare a draft from this saved proposal.',createdAt:'2026-09-30T09:00:00.000Z',context:{scopeId:'business',memories:[],workflows:[],sources:[]}});await conversations.save(conversation);
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(done=>reserve.close(done));
  const children=[];let child;
  const stop=async instance=>{if(instance.exitCode===null&&instance.signalCode===null)instance.kill('SIGTERM');await instance.exited;};
  t.after(async()=>{await Promise.all(children.map(stop));await rm(directory,{recursive:true,force:true});});
  async function start(){
    child=spawn(process.execPath,['server.mjs'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),FUORI_STUDIO_DATA_DIR:data,FUORI_STUDIO_MODE:'local',FUORI_STUDIO_CODEX_BIN:binary},stdio:['ignore','pipe','pipe']});
    children.push(child);child.exited=once(child,'exit');let log='',errors='';child.stdout.on('data',value=>log+=value);child.stderr.on('data',value=>errors+=value);
    for(let i=0;i<250;i++){if(log.includes('Fuori Studio'))return;if(child.exitCode!==null)throw Error(errors);await new Promise(done=>setTimeout(done,20));}throw Error(`Server startup timed out: ${errors}`);
  }
  const base=`http://127.0.0.1:${port}`;
  async function request(path,payload,expected=200){const response=await fetch(base+path,payload===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify(payload)});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;}
  await start();
  const project=(await request('/api/operations',{action:'createProject',payload:{scopeId:'business',title:'HTTP owned project'}})).projects[0];
  const identity={scopeId:'business',conversationId:conversation.id,messageId:'http-saved-message'};
  const csrf=await fetch(base+'/api/conversation/task-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(identity)});assert.equal(csrf.status,403);
  await request('/api/conversation/task-preview',{...identity,messageId:conversation.messages[0].id},409);
  const draft=await request('/api/conversation/task-preview',identity);assert.equal(draft.agentId,'forge');
  assert.equal((await request('/api/operations')).tasks.length,0);
  const input={draftId:draft.id,projectId:project.id,title:'Reviewed HTTP task',brief:'Complete reviewed brief',agentId:draft.agentId};
  await request('/api/conversation/task',{...input,inputContext:{}},400);
  const created=await request('/api/conversation/task',input),task=created.operations.tasks[0];assert.equal(task.status,'queued');assert.equal(task.origin.messageId,identity.messageId);
  await request('/api/operations',{action:'createConversationTask',payload:{}},400);
  for(const field of ['origin','inputContext'])await request('/api/operations',{action:'createTask',payload:{projectId:project.id,title:'Forged metadata',[field]:task[field]}},400);
  await stop(child);await start();
  const retried=await request('/api/conversation/task',input);assert.equal(retried.taskId,created.taskId);assert.equal(retried.operations.tasks.length,1);
  await request('/api/conversation/task',{...input,title:'Altered retry'},409);
  const promptLog=await readFile(calls,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});assert.equal(promptLog,'');
});
