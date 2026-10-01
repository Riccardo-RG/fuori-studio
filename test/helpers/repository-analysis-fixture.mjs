import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {createArchive} from '../../lib/archive.mjs';
import {createDeviceHub} from '../../lib/devices.mjs';

export async function repositoryAnalysisFixture(t,{pairedDevice=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'fuori-repository-analysis-http-'));
  let deviceId=null;
  if(pairedDevice){
    const storage=createArchive({directory:join(directory,'data'),mode:'local'}),hub=createDeviceHub({storage});
    try{const invitation=await hub.mutate('pair',{name:'Fixture worker',scopeIds:['business'],capabilities:['execute']});deviceId=(await hub.pair({code:invitation.code})).deviceId;}
    finally{await storage.close();}
  }
  const binary=join(directory,'fake-codex'),log=join(directory,'ai.jsonl'),githubLog=join(directory,'github.jsonl'),control=join(directory,'control.json');
  await writeFile(control,'{}');
  await writeFile(binary,`#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('app-server'))process.exit(1);
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
let prompt='';process.stdin.on('data',value=>prompt+=value);process.stdin.on('end',()=>{
  const stage=prompt.includes('PASSAGGIO DI ANALISI: 1.')?'technical':prompt.includes('PASSAGGIO DI ANALISI: 2.')?'strategy':prompt.includes('PASSAGGIO DI ANALISI: 3.')?'synthesis':'chat';
  fs.appendFileSync(process.env.TEST_AI_LOG,JSON.stringify({prompt,stage})+'\\n');
  const control=JSON.parse(fs.readFileSync(process.env.TEST_ANALYSIS_CONTROL,'utf8'));
  if(control.failStage===stage){process.stderr.write('PRIVATE_RUNTIME_ERROR');process.exit(1);}
  if(control.hangStage===stage){setInterval(()=>{},1000);return;}
  const text=control.responseText|| (stage==='technical'?'TECHNICAL_ANALYSIS_MARKER: comparison of supplied code.':stage==='strategy'?'STRATEGY_ANALYSIS_MARKER: commercial hypotheses need validation.':stage==='synthesis'?'FINAL_STRATEGY_MARKER: prioritize a scoped experiment with a 30/60/90-day plan.':JSON.stringify({message:'Ordinary chat response.',needsInput:false,assignments:[],memoryCandidates:[]}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:31,output_tokens:9}}));
});
`,{mode:0o700});
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(done=>probe.close(done));
  const child=spawn(process.execPath,['--import',resolve('test/helpers/github-analysis-transport.mjs'),'server.mjs'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),FUORI_STUDIO_MODE:'local',FUORI_STUDIO_DATA_DIR:join(directory,'data'),FUORI_STUDIO_CODEX_BIN:binary,TEST_REPOSITORY_ANALYSIS_FIXTURE:'1',TEST_GITHUB_LOG:githubLog,TEST_AI_LOG:log,TEST_ANALYSIS_CONTROL:control},stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);const exited=once(child,'exit');
  const stop=async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;await rm(directory,{recursive:true,force:true});};t.after(stop);
  for(let i=0;i<300&&!output.includes('Fuori Studio');i++){if(child.exitCode!==null)throw Error(error);await new Promise(done=>setTimeout(done,20));}
  assert.match(output,/Fuori Studio/,error);
  const base=`http://127.0.0.1:${port}`;
  async function request(path,payload,status=200,headers={}){
    const response=await fetch(base+path,payload===undefined?{headers}:{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local',...headers},body:JSON.stringify(payload)}),raw=await response.text();
    assert.equal(response.status,status,`${path}: ${raw.slice(0,2000)}`);
    if(response.headers.get('content-type')?.includes('text/event-stream'))return raw.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
    return JSON.parse(raw);
  }
  const lines=async path=>{try{return(await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return[];throw e;}};
  const connection=(await request('/api/github',{action:'save',payload:{name:'Analysis fixture',token:'fixture_readonly_token_1234567890',scopeIds:['business'],repositories:['studio/alpha','studio/beta'],allowPublish:false}})).result;
  const prepare=(goal='Compare these products and recommend a strategy.',targets=['studio/alpha','studio/beta'])=>request('/api/repository-analysis/prepare',{scopeId:'business',goal,targets:targets.map(repository=>({connectionId:connection.id,repository}))});
  const input=analysis=>({kind:'chat',scopeId:'business',message:analysis.goal,workflowId:null,repositoryAnalysisId:analysis.id});
  return {base,request,connection,deviceId,prepare,input,calls:()=>lines(log),githubCalls:()=>lines(githubLog),setControl:value=>writeFile(control,JSON.stringify(value)),stop};
}
