import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

test('source HTTP import is scoped, documents enter bounded context, and deletion withdraws derived history',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'fuori-sources-http-')),bin=join(directory,'codex-stub'),prompts=join(directory,'prompts.jsonl');
 await writeFile(bin,`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('app-server'))process.exit(1);if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify(input)+'\\n');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({message:'The special limit is seventeen.',projectId:'portfolio',needsInput:false,assignments:[],memoryCandidates:[]})}}));});\n`,{mode:0o700});
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(done=>reserve.close(done));
 const child=spawn(process.execPath,['server.mjs'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),FUORI_STUDIO_DATA_DIR:join(directory,'data'),FUORI_STUDIO_CODEX_BIN:bin,FUORI_STUDIO_MODE:'local'},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}await rm(directory,{recursive:true,force:true});});
 await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timeout')),10000);let errors='';child.stderr.on('data',d=>errors+=d);child.stdout.on('data',d=>{if(String(d).includes('Fuori Studio')){clearTimeout(timer);done();}});child.on('exit',code=>{clearTimeout(timer);if(code)reject(Error(errors));});});
 const base=`http://127.0.0.1:${port}`;
 async function request(path,body,status=200){if(path==='/api/chat'&&status===200){const receipt=await request('/api/execution/preview',{kind:'chat',...body});body={...body,previewId:receipt.previewId};}const response=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify(body)}:{});const result=response.headers.get('content-type')?.includes('text/event-stream')?await response.text():await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;}
 const imported=await request('/api/sources',{action:'importText',payload:{scopeId:'business',title:'Limits specification',text:'The special limit is seventeen.'}});
 assert.equal(imported.source.untrusted,true);assert.equal(imported.segments[0].lineStart,1);
 await request('/api/sources',{action:'importText',payload:{scopeId:'personal',title:'Private limits',text:'Unrelated personal material must stay private.'}});
 assert.equal((await request('/api/sources?scopeId=business')).sources.length,1);
 await request('/api/sources/detail?scopeId=personal&id='+imported.source.id,undefined,404);
 await request('/api/sources',{action:'importUrl',payload:{scopeId:'business',url:'https://127.0.0.1/secret'}},403);
 await request('/api/sources',{action:'importFolder',payload:{scopeId:'business',path:directory}},403);
 await request('/api/chat',{scopeId:'business',message:'Which limits apply?'});
 let calls=(await readFile(prompts,'utf8')).trim().split('\n').map(JSON.parse);assert.match(calls[0],/special limit is seventeen/);assert.doesNotMatch(calls[0],/Unrelated personal material/);
 const studio=await request('/api/studio');assert.equal(studio.messages.find(m=>m.role==='assistant'&&!m.welcome).context.sources[0].id,imported.source.id);
 await request('/api/sources',{action:'remove',payload:{scopeId:'business',id:imported.source.id,version:2}},409);
 await request('/api/sources',{action:'remove',payload:{scopeId:'business',id:imported.source.id,version:1}});
 await request('/api/chat',{scopeId:'business',message:'Can you recap the available information?'});
 calls=(await readFile(prompts,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);assert.doesNotMatch(calls[1],/special limit is seventeen/i,'deleted document cannot return through old derived answer');
 const governance=await request('/api/governance');assert.equal(governance.daily.calls,2);
 assert.equal((await request('/api/workspace')).memories.length,0,'importing sources never confirms memories');
});
