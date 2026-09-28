import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationsStore } from '../lib/operations.mjs';
import { validatePlan } from '../lib/plans.ts';

const nodes = [{key:'brief',title:'Define the problem',brief:'List requirements.',agentId:'nova',dependsOn:[]},{key:'review',title:'Review the proposal',brief:'Review the accepted requirements.',agentId:'radar',dependsOn:['brief']}];
test('plans reject cycles, duplicate nodes, unknown agents and model tool instructions', () => {
  assert.equal(validatePlan({title:'Plan',nodes}).nodes.length,2);
  assert.throws(()=>validatePlan({title:'Plan',nodes:[{...nodes[0],dependsOn:['review']},nodes[1]]}));
  assert.throws(()=>validatePlan({title:'Plan',nodes:[nodes[0],nodes[0]]}));
  assert.throws(()=>validatePlan({title:'Plan',nodes:[{...nodes[0],agentId:'shell'}]}));
});
test('an approved plan atomically creates queued dependencies and waits for human review', async t => {
  const directory=await mkdtemp(join(tmpdir(),'fuori-plan-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=createOperationsStore({directory});
  const project=(await store.mutate('createProject',{title:'Product',scopeId:'business'})).projects[0];
  await assert.rejects(store.mutate('createTaskGraph',{projectId:project.id,title:'Broken',nodes:[nodes[0],{...nodes[1],dependsOn:['missing']}]}));
  assert.equal((await store.getSnapshot()).tasks.length,0,'invalid graph leaves no partial tasks');
  let snapshot=await store.mutate('createTaskGraph',{projectId:project.id,title:'Plan',nodes,context:{memories:[],workflows:[]}});
  const first=snapshot.tasks[0],second=snapshot.tasks[1];assert.deepEqual(second.dependencies,[first.id]);assert.equal(first.planId,second.planId);
  await assert.rejects(store.mutate('startTask',{id:second.id}),{code:'DEPENDENCY_PENDING'});
  let task=(await store.mutate('startTask',{id:first.id})).tasks[0];const token=task.executionId;
  await store.mutate('startStep',{id:task.id,stepId:task.steps[0].id,executionId:token});
  await store.mutate('completeStep',{id:task.id,stepId:task.steps[0].id,executionId:token,output:'Requirements supplied.'});
  task=(await store.mutate('submitArtifact',{id:task.id,executionId:token,content:'Review these requirements.'})).tasks[0];
  await assert.rejects(store.mutate('startTask',{id:second.id}),{code:'DEPENDENCY_PENDING'});
  await store.mutate('approveTask',{id:task.id,expectedVersion:task.version});
  snapshot=await store.mutate('startTask',{id:second.id});assert.equal(snapshot.tasks[1].status,'running');
});
