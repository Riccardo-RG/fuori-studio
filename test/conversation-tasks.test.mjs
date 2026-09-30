import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConversationTasks} from '../lib/conversation-tasks.ts';
import {createConversationStore} from '../lib/conversations.mjs';
import {createOperationsStore} from '../lib/operations.mjs';
import {createTaskExecutor} from '../lib/executor.mjs';
import {configureSourceContext} from '../lib/context.mjs';

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'fuori-conversation-task-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const operations=createOperationsStore({directory}),conversations=createConversationStore({directory});
  const snapshot={scopes:[{id:'business',name:'Business',kind:'business'},{id:'personal',name:'Personal',kind:'personal'}],memories:[],workflows:[]};
  const workspace={getSnapshot:async()=>structuredClone(snapshot),getContext:async()=>({scope:snapshot.scopes[0],memories:[],workflow:null,sources:[]})};
  const project=(await operations.mutate('createProject',{scopeId:'business',title:'Owned product',kind:'owned'})).projects[0];
  const message={id:'saved-message',role:'assistant',agentId:'forge',text:'Review the complete proposal.\nKeep the final acceptance criterion intact.',createdAt:'2026-09-30T09:00:00.000Z',context:{scopeId:'business',scopeName:'Business',memories:[],workflows:[],sources:[]}};
  const conversation=await conversations.load('business');conversation.messages.push(message);await conversations.save(conversation);
  let now=Date.parse('2026-09-30T10:00:00Z');
  const options={operations,conversations,workspace,now:()=>now},service=createConversationTasks(options);
  const identity={scopeId:'business',conversationId:conversation.id,messageId:message.id};
  const saveMessage=async()=>{conversation.messages=[conversation.messages[0],message];await conversations.save(conversation);};
  const fields=draft=>({draftId:draft.id,projectId:project.id,title:draft.title,brief:draft.brief,agentId:draft.agentId});
  return {directory,operations,conversations,snapshot,workspace,project,message,conversation,identity,service,options,fields,saveMessage,advance:ms=>{now+=ms;}};
}

test('saved contribution previews without writes and creates one queued editable task with immutable provenance',async t=>{
  const f=await fixture(t);
  await f.operations.mutate('createProject',{scopeId:'personal',title:'Other scope'});
  await f.operations.mutate('createProject',{scopeId:'business',title:'Client project',kind:'client'});
  const before=await readFile(join(f.directory,'operations.json'),'utf8'),draft=await f.service.preview(f.identity);
  assert.equal(await readFile(join(f.directory,'operations.json'),'utf8'),before);
  assert.equal(draft.brief,f.message.text);assert.equal(draft.agentId,'forge');assert.deepEqual(draft.projects.map(item=>item.id),[f.project.id]);assert.match(draft.sourceDigest,/^[a-f0-9]{64}$/);
  const result=await f.service.create({...f.fields(draft),title:'Reviewed title',brief:'Edited acceptance criteria.'});
  const task=result.operations.tasks.find(item=>item.id===result.taskId);
  assert.equal(task.status,'queued');assert.equal(task.executionId,null);assert.equal(task.brief,'Edited acceptance criteria.');assert.equal(task.steps.length,1);assert.equal(task.steps[0].agentId,'forge');
  assert.deepEqual(task.inputContext,f.message.context);assert.equal(task.origin.receiptId,draft.id);assert.equal(task.origin.sourceDigest,draft.sourceDigest);assert.equal(task.origin.conversationId,f.conversation.id);
  assert.equal(task.origin.messageId,f.message.id);assert.equal(task.origin.agentId,'forge');assert.equal(task.origin.createdAt,f.message.createdAt);assert.equal(Object.hasOwn(task.origin,'title'),false);
  assert.equal((await createOperationsStore({directory:f.directory}).getSnapshot()).tasks[0].origin.receiptId,draft.id);
});

test('concurrent saves and response-loss retries are durably idempotent, even after restart and expiry',async t=>{
  const f=await fixture(t),draft=await f.service.preview(f.identity),input=f.fields(draft);
  const results=await Promise.all([f.service.create(input),f.service.create(input)]);
  assert.equal(results[0].taskId,results[1].taskId);assert.equal(results[1].operations.tasks.length,1);
  f.advance(20*60000);f.conversation.messages=[];await f.conversations.save(f.conversation);
  const restarted=createConversationTasks({...f.options,operations:createOperationsStore({directory:f.directory})});
  assert.equal((await restarted.create(input)).taskId,results[0].taskId);
  await assert.rejects(restarted.create({...input,brief:'Altered retry'}),{statusCode:409});
  assert.equal((await f.operations.getSnapshot()).tasks.length,1);
});

test('source text, context and existence are rechecked; complete long messages are refused rather than truncated',async t=>{
  const f=await fixture(t),draft=await f.service.preview(f.identity);
  f.message.text+=' Changed.';await f.saveMessage();await assert.rejects(f.service.create(f.fields(draft)),{statusCode:409});
  const second=await f.service.preview(f.identity);f.message.context.scopeName='Changed context';await f.saveMessage();await assert.rejects(f.service.create(f.fields(second)),{statusCode:409});
  f.message.text='x'.repeat(16000);await f.saveMessage();assert.equal((await f.service.preview(f.identity)).brief.length,16000);
  f.message.text+='x';await f.saveMessage();await assert.rejects(f.service.preview(f.identity),{statusCode:400});
  f.conversation.messages=[];await f.conversations.save(f.conversation);await assert.rejects(f.service.create(f.fields(second)),{statusCode:409});
  assert.equal((await f.operations.getSnapshot()).tasks.length,0);
});

test('user messages and archived sources work; welcome messages, unavailable scopes and forged fields do not',async t=>{
  const f=await fixture(t);f.message.role='user';delete f.message.agentId;delete f.message.context;await f.saveMessage();
  await f.conversations.reset('business');
  const draft=await f.service.preview(f.identity);assert.equal(draft.agentId,'nova');assert.equal(draft.source.agentId,null);
  const saved=await f.service.create(f.fields(draft));assert.deepEqual(saved.operations.tasks[0].inputContext,{scopeId:'business',memories:[],workflows:[],sources:[]});
  await assert.rejects(f.service.preview({...f.identity,messageId:f.conversation.messages[0].id}),{statusCode:409});
  await assert.rejects(f.service.preview({...f.identity,scopeId:'personal'}),{statusCode:404});
  await assert.rejects(f.service.preview({...f.identity,context:{}}),{statusCode:400});
  await assert.rejects(f.service.create({...f.fields(draft),inputContext:{}}),{statusCode:400});
  f.snapshot.scopes[0].kind='archive';await assert.rejects(f.service.preview(f.identity),{statusCode:409});
});

test('original evidence determines eligible agents and survives editing the brief',async t=>{
  const f=await fixture(t),memory={id:'restricted-memory',scopeId:'personal',version:2,status:'confirmed',sharedWith:['business'],agentIds:['forge']};
  f.snapshot.memories.push(memory);f.message.context.memories=[{id:memory.id,version:2,scopeId:'personal',title:'Private source'}];
  f.snapshot.workflows.push({id:'ready-workflow',scopeId:'business',version:1,status:'ready'});
  delete f.message.context.workflows;f.message.context.workflow={id:'ready-workflow',version:1,title:'Saved method'};await f.saveMessage();
  const draft=await f.service.preview(f.identity);assert.deepEqual(draft.agentIds,['forge']);
  await assert.rejects(f.service.create({...f.fields(draft),agentId:'nova'}),{statusCode:409});
  const result=await f.service.create({...f.fields(draft),brief:'An independently edited brief.'});
  assert.deepEqual(result.operations.tasks[0].inputContext.workflows,[f.message.context.workflow]);assert.equal(result.operations.tasks[0].inputContext.memories[0].id,memory.id);
  const next=await f.service.preview(f.identity);memory.agentIds=['muse'];await assert.rejects(f.service.create(f.fields(next)),{statusCode:409});
  memory.agentIds=['forge'];memory.version++;await assert.rejects(f.service.preview(f.identity),{statusCode:409});
});

test('withdrawn sources, memories and workflows cannot be laundered into a new task',async t=>{
  const f=await fixture(t),source={id:'document',scopeId:'business',version:1,digest:'fixture',status:'current'};
  configureSourceContext({allMetadata:async()=>[source]});t.after(()=>configureSourceContext(null));
  f.message.context.sources=[{...source}];await f.saveMessage();const draft=await f.service.preview(f.identity);
  source.status='stale';await assert.rejects(f.service.create(f.fields(draft)),{statusCode:409});
  source.status='current';source.scopeId='personal';await assert.rejects(f.service.preview(f.identity),{statusCode:409});
  source.scopeId='business';f.message.context.sources=[];f.message.context.memories=[{id:'forgotten',version:1}];await f.saveMessage();await assert.rejects(f.service.preview(f.identity),{statusCode:409});
  f.message.context.memories=[];f.message.context.workflows=[{id:'deleted-workflow',version:1}];await f.saveMessage();await assert.rejects(f.service.preview(f.identity),{statusCode:409});
  assert.equal((await f.operations.getSnapshot()).tasks.length,0);
});

test('project ownership, scope and receipt expiry are checked again on save and draft count is bounded',async t=>{
  const f=await fixture(t),draft=await f.service.preview(f.identity);
  let project=(await f.operations.mutate('saveProject',{id:f.project.id,expectedVersion:1,kind:'client'})).projects[0];
  await assert.rejects(f.service.create(f.fields(draft)),{statusCode:409});
  await f.operations.mutate('saveProject',{id:project.id,expectedVersion:project.version,kind:'owned',scopeId:'personal'});
  await assert.rejects(f.service.create(f.fields(draft)),{statusCode:409});
  f.advance(15*60000);await assert.rejects(f.service.create(f.fields(draft)),{statusCode:409});
  const oldest=await f.service.preview(f.identity);for(let i=0;i<20;i++)await f.service.preview(f.identity);
  await assert.rejects(f.service.create(f.fields(oldest)),{statusCode:409});f.advance(15*60000);await f.service.preview(f.identity);
});

test('queued conversation evidence retains source-scope provider and exclusion guards before execution',async t=>{
  const f=await fixture(t),memory={id:'inherited-only',scopeId:'personal',version:1,status:'confirmed',sharedWith:['business'],agentIds:['forge']};
  f.snapshot.memories.push(memory);f.message.context.memories=[{id:memory.id,scopeId:'personal',version:1,title:'Inherited'}];await f.saveMessage();
  const draft=await f.service.preview(f.identity),saved=await f.service.create({...f.fields(draft),brief:'Edited text omits all original names.'});
  const checks=[],calls=[];let deny=true;
  const providers={assertAllowed:async input=>{checks.push(input);if(deny&&input.scopeId==='personal')throw Object.assign(Error('Source provider denied'),{statusCode:403});return {id:'fixture',type:'mock'};},execute:async input=>{calls.push(input);return {text:'Fixture result'};}};
  const executor=createTaskExecutor({operations:f.operations,workspace:f.workspace,providers});t.after(()=>executor.shutdown());
  await assert.rejects(executor.preview(saved.taskId),{statusCode:403});assert.ok(checks.some(input=>input.scopeId==='personal'&&input.connectionId==='fixture'));assert.equal(calls.length,0);
  deny=false;await assert.rejects(executor.preview(saved.taskId,undefined,{excludeMemoryIds:[memory.id]}),{statusCode:409});
  const plan=await executor.preview(saved.taskId);assert.equal(plan.steps[0].inherited.find(item=>item.persisted).context.memories[0].id,memory.id);
  memory.version++;await assert.rejects(executor.preview(saved.taskId),{statusCode:409});assert.equal(calls.length,0);assert.equal((await f.operations.getSnapshot()).tasks[0].status,'queued');
});

test('generic creation cannot forge provenance and internal duplicate receipts remain atomic',async t=>{
  const f=await fixture(t),draft=await f.service.preview(f.identity),saved=await f.service.create(f.fields(draft)),task=saved.operations.tasks[0];
  for(const extra of [{origin:task.origin},{inputContext:task.inputContext}])await assert.rejects(f.operations.mutate('createTask',{projectId:f.project.id,title:'Forged',...extra}),{code:'VALIDATION_ERROR'});
  const payload=Object.fromEntries(['projectId','scopeId','title','brief','agentId','inputContext','origin'].map(key=>[key,task[key]]));
  const repeated=await Promise.all([f.operations.mutate('createConversationTask',payload),f.operations.mutate('createConversationTask',payload)]);
  assert.ok(repeated.every(value=>value.tasks.length===1));await assert.rejects(f.operations.mutate('createConversationTask',{...payload,title:'Altered'}),{statusCode:409});
});
