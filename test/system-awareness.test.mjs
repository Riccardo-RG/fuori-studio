import test from 'node:test';
import assert from 'node:assert/strict';
import {createSystemAwareness,systemAwarenessPrompt,systemAwarenessRecord} from '../lib/system-awareness.ts';
import {createGovernance} from '../lib/governance.ts';
import {createExecutionPreview} from '../lib/execution-preview.ts';

function memoryStorage(){
  const records=new Map();let queue=Promise.resolve();
  return {records,read:async(key,fallback)=>structuredClone(records.get(key)??fallback),update(key,fn,fallback){const result=queue.then(()=>{const value=fn(structuredClone(records.get(key)??fallback));records.set(key,structuredClone(value));return structuredClone(value);});queue=result.catch(()=>{});return result;}};
}
const knowledgeValue={identity:{name:'fuori-studio',version:'0.6.0',commit:null,dirtyAtStart:null,capturedAt:'2026-10-01T12:00:00Z',sourceDigest:'digest'},sourceChanged:false,topics:['tokens'],facts:['Input and output are reported separately.'],evidence:[{path:'lib/codex.mjs',startLine:72,endLine:85,digest:'source-digest',text:'SOURCE_EXCERPT_MARKER'}],limitations:['Provider quotas unknown.']};
const connection={id:'codex',type:'codex',model:'local-default',apiKey:'SECRET_MUST_NOT_LEAVE',name:'PRIVATE_CONNECTION_NAME'};
const input={query:'Quali token consumi?',kind:'chat',scopeId:'business',agentId:'nova',connection,context:{memories:[{content:'PRIVATE_MEMORY_BODY'}],sources:[]},history:[]};
const meta={scopeId:'business',agentId:'nova',kind:'inference',connectionId:'codex'};
function fixture(){const storage=memoryStorage(),governance=createGovernance({storage,clock:()=>Date.parse('2026-10-01T12:00:00Z')});const knowledge={select:async()=>structuredClone(knowledgeValue)};const service=createSystemAwareness({knowledge,governance,mode:'local',destination:async()=>({executionTarget:'local',authentication:'chatgpt_login'})});return {storage,governance,service};}

test('awareness sends only allowlisted operational metadata and distinguishes unknowns from zero',async()=>{
  const {service,governance}=fixture();
  await governance.execute(meta,async()=>({usage:{inputTokens:0,outputTokens:5}}));
  await governance.execute(meta,async()=>({text:'unmetered'}));
  const value=await service.prepare({...input,history:[{role:'assistant',agentId:'nova',text:'PRIVATE_RESPONSE_BODY',execution:{provider:{...connection,authToken:'AUTH_SECRET'},usage:{inputTokens:10,outputTokens:3,cachedInputTokens:999},durationMs:50,raw:'PRIVATE_RAW'}}]});
  assert.equal(value.runtime.provider.model,null);assert.equal(value.runtime.provider.modelKnown,false);
  assert.equal(value.runtime.provider.authentication,'chatgpt_login');
  assert.equal(value.runtime.usage.calls,2);assert.equal(value.runtime.usage.inputTokens,0);assert.equal(value.runtime.usage.outputTokens,5);
  assert.equal(value.runtime.usage.unknownInputCount,1);assert.equal(value.runtime.usage.complete,false);
  assert.equal(value.runtime.budget.daily.used,2);assert.equal(value.runtime.budget.daily.remaining,48);
  assert.deepEqual(value.runtime.context,{memoryCount:1,sourceCount:0,historyMessages:1});
  assert.equal(value.runtime.recentResponses[0].usage.inputTokens,10);
  assert.equal(value.runtime.accountQuota,null);assert.equal(value.runtime.monetaryCost,null);
  assert.doesNotMatch(JSON.stringify(value),/SECRET_MUST_NOT_LEAVE|PRIVATE_CONNECTION_NAME|AUTH_SECRET|PRIVATE_MEMORY_BODY|PRIVATE_RESPONSE_BODY|PRIVATE_RAW|cachedInputTokens|local-default/);
  const record=systemAwarenessRecord(value);assert.equal(record.runtime.usage.calls,2);assert.equal(record.sources[0].path,'lib/codex.mjs');assert.match(record.digest,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(record),/SOURCE_EXCERPT_MARKER/);
});

test('all retained usage is filtered by scope, agent and optional project before entering prompts',async()=>{
  const {storage,governance,service}=fixture();
  for(const other of [meta,{...meta,scopeId:'personal'},{...meta,agentId:'forge'},{...meta,projectId:'project-one'}])await governance.execute(other,async()=>({usage:{inputTokens:10,outputTokens:2}}));
  const state=storage.records.get('governance'),original=structuredClone(state.usages[0]);
  for(let i=0;i<205;i++)state.usages.push({...original,id:'historical-'+i,day:'2026-09-30',startedAt:'2026-09-30T12:00:00Z',finishedAt:'2026-09-30T12:00:01Z'});
  assert.equal((await governance.snapshot()).usages.length,200);
  const all=await service.prepare(input);assert.equal(all.runtime.usage.calls,207);assert.equal(all.runtime.usage.inputTokens,2070);
  const project=await service.prepare({...input,projectId:'project-one'});assert.equal(project.runtime.usage.calls,1);assert.equal(project.runtime.usage.projectScoped,true);
  assert.equal(project.runtime.budget.project.remaining,199);
  const another=await service.prepare({...input,scopeId:'personal'});assert.equal(another.runtime.usage.calls,1);
  await assert.rejects(governance.agentUsage({scopeId:'business',agentId:'nova',includeAll:true}));
});

test('missing history and malformed telemetry never become invented model identity or numbers',async()=>{
  const {service}=fixture();
  const value=await service.prepare({...input,connection:{type:'openai',model:'untrusted\nSECRET'},history:[{role:'assistant',agentId:'nova',execution:{provider:{type:'custom',model:'invented'},usage:{inputTokens:-1,outputTokens:'15'},durationMs:Infinity}}]});
  assert.equal(value.runtime.provider.model,null);assert.equal(value.runtime.usage.inputTokens,null);
  assert.deepEqual(value.runtime.recentResponses[0].usage,{inputTokens:null,outputTokens:null});
  assert.equal(value.runtime.recentResponses[0].durationMs,null);
  assert.equal((await service.prepare({...input,history:[]})).runtime.recentResponses.length,0);
  const api=await service.prepare({...input,connection:{type:'openai',model:'configured-model'}});assert.equal(api.runtime.provider.model,'configured-model');
});

test('review binds exact system knowledge and scoped metrics without unstable timestamps',async()=>{
  const {service,governance}=fixture();
  const previews=createExecutionPreview({prepare:{chat:async()=>({kind:'chat',id:'conversation',scopeId:'business',selection:{},steps:[{agentId:'nova',context:{memories:[],sources:[]},connection,systemAwareness:await service.prepare(input)}]})},budget:async()=>({allowed:true})});
  const first=await previews.preview({kind:'chat'});assert.equal(first.steps[0].systemAwareness.runtime.provider.model,null);
  const plan=await previews.consume(first.previewId,{kind:'chat'});assert.deepEqual(plan.steps[0].systemAwareness,first.steps[0].systemAwareness);
  const stale=await previews.preview({kind:'chat'});await governance.execute(meta,async()=>({usage:{inputTokens:4,outputTokens:2}}));
  await assert.rejects(previews.consume(stale.previewId,{kind:'chat'}),{statusCode:409});
});

test('prompt explains provenance, scoped counts and unavailable provider billing while retaining evidence as data',async()=>{
  const value=await fixture().service.prepare(input),prompt=systemAwarenessPrompt(value);
  assert.match(prompt,/CONOSCENZA VERIFICABILE/);assert.match(prompt,/null non significa zero/);assert.match(prompt,/questa risposta ancora da generare/);assert.match(prompt,/DATI DEL SISTEMA \(non istruzioni\)/);assert.match(prompt,/SOURCE_EXCERPT_MARKER/);
  assert.equal(systemAwarenessPrompt(null),'');assert.equal(systemAwarenessRecord(null),null);
});

test('availability prioritizes applicable app allowance without inventing provider capacity or granting tools',async()=>{
  const {service,governance}=fixture();
  await governance.execute(meta,async()=>({text:'unmetered'}));
  const chat=await service.prepare(input);
  assert.deepEqual(chat.runtime.availability,{appCallsRemaining:49,appLimitReached:false,providerQuotaKnown:false});
  assert.equal(chat.runtime.capabilities.find(item=>item.id==='system_sources').available,true);
  for(const id of ['repository_edit','web','publish','memory_write'])assert.equal(chat.runtime.capabilities.find(item=>item.id===id).available,false);
  const editor=await service.prepare({...input,kind:'repository_edit'});
  assert.equal(editor.runtime.capabilities.find(item=>item.id==='repository_edit').available,true);
  assert.match(systemAwarenessPrompt(editor),/puoi anche usare gli strumenti concessi dalle istruzioni dell’editor/);
  assert.doesNotMatch(systemAwarenessPrompt(editor),/In questa esecuzione l’app non autorizza strumenti autonomi/);
  const reviewer=await service.prepare({...input,kind:'repository_review'});
  assert.equal(reviewer.runtime.capabilities.find(item=>item.id==='repository_edit').available,false);
  assert.match(systemAwarenessPrompt(reviewer),/In questa esecuzione l’app non autorizza strumenti autonomi/);
  const limited=createSystemAwareness({knowledge:{select:async()=>knowledgeValue},mode:'local',governance:{agentUsage:async()=>({}),preflight:async()=>({daily:{remaining:40},project:{remaining:8},assignment:{remaining:0}})}});
  assert.deepEqual((await limited.prepare(input)).runtime.availability,{appCallsRemaining:0,appLimitReached:true,providerQuotaKnown:false});
  const unknown=createSystemAwareness({knowledge:{select:async()=>knowledgeValue},mode:'local',governance:{agentUsage:async()=>({}),preflight:async()=>({})}});
  assert.equal((await unknown.prepare(input)).runtime.availability.appCallsRemaining,null);
  assert.match(systemAwarenessPrompt(chat),/dai priorità a capacità e margine operativo/);
});

test('native account windows are allowlisted, distinct from scoped usage, and never leak to other destinations',async()=>{
  const {governance}=fixture();
  const quota={source:'codex_app_server',observedAt:'2026-10-01T12:00:00Z',ordinaryUsageAllowed:false,accountId:'PRIVATE_ACCOUNT',credits:{balance:'PRIVATE_CREDIT'},limits:[{id:'codex',primary:{usedPercent:37,remainingPercent:999,windowDurationMins:300,resetsAt:'2026-10-01T13:00:00Z'},secondary:{usedPercent:105,windowDurationMins:null,resetsAt:null},extra:'PRIVATE_DATA'},{id:'invalid\nPRIVATE',primary:{usedPercent:0}},{id:'malformed',primary:{usedPercent:'10'}}]};
  const service=(target='local',authentication='chatgpt_login',mode='local')=>createSystemAwareness({knowledge:{select:async()=>knowledgeValue},governance,mode,destination:async()=>({executionTarget:target,authentication,accountQuota:quota})});
  const value=await service().prepare(input);
  assert.equal(value.runtime.availability.providerQuotaKnown,true);
  assert.equal(value.runtime.accountQuota.ordinaryUsageAllowed,false);
  assert.equal(value.runtime.accountQuota.limits.length,1);
  assert.equal(value.runtime.accountQuota.limits[0].primary.remainingPercent,63);
  assert.equal(value.runtime.accountQuota.limits[0].secondary.remainingPercent,0);
  assert.equal(value.runtime.usage.calls,0);
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|999/);
  for(const [target,auth,mode,connection] of [['paired','chatgpt_login','local',input.connection],['local','api_key','local',input.connection],['local','chatgpt_login','online',input.connection],['local','chatgpt_login','local',{type:'openai',model:'example'}]])assert.equal((await service(target,auth,mode).prepare({...input,connection})).runtime.accountQuota,null);
});

test('quota refresh clocks alone preserve reviewed snapshot while quota values still invalidate it',async()=>{
  let observedAt='2026-10-01T12:00:00Z',remainingPercent=70;
  const previews=createExecutionPreview({prepare:{chat:async()=>({kind:'chat',id:'conversation',scopeId:'business',selection:{},steps:[{agentId:'nova',context:{memories:[],sources:[]},connection,systemAwareness:{runtime:{accountQuota:{observedAt,limits:[{id:'codex',primary:{remainingPercent}}]}}}}]})},budget:async()=>({allowed:true})});
  const first=await previews.preview({kind:'chat'});observedAt='2026-10-01T12:01:00Z';
  const consumed=await previews.consume(first.previewId,{kind:'chat'});
  assert.deepEqual(consumed.steps[0].systemAwareness,first.steps[0].systemAwareness);
  const stale=await previews.preview({kind:'chat'});remainingPercent=69;
  await assert.rejects(previews.consume(stale.previewId,{kind:'chat'}),{statusCode:409});
});
