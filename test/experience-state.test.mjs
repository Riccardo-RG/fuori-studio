import test from 'node:test';
import assert from 'node:assert/strict';
import { daylightMode, isNight, deriveActivity, scopeIdentity } from '../dist/experience-state.js';

test('daylight follows local boundaries with explicit overrides and safe stored defaults', () => {
  assert.equal(daylightMode('invalid'), 'auto');
  for (const [hour, expected] of [[6,true],[7,false],[18,false],[19,true],[23,true]]) {
    const date = new Date(2026, 8, 27, hour, 0);
    assert.equal(isNight('auto', date), expected);
    assert.equal(isNight('day', date), false);
    assert.equal(isNight('night', date), true);
  }
});
test('reviews, queued and paused work are calm and do not send idle agents to meetings', () => {
  const tasks = ['review','queued','paused','completed'].map((status,id) => ({id,status,steps:[{agentId:'nova'},{agentId:'forge'}]}));
  const state = deriveActivity({tasks});
  assert.equal(state.load, 0);
  assert.equal(state.problemKey, null);
  assert.deepEqual(state.collaboratingIds, []);
});
test('a running shared assignment seats its team while identifying the actual active stage', () => {
  const state = deriveActivity({tasks:[{id:'t1',title:'Product brief',status:'running',steps:[{agentId:'nova',status:'completed'},{agentId:'forge',status:'running',title:'Prototype'},{agentId:'nova',status:'pending'}]}]});
  assert.deepEqual(state.collaboratingIds, ['nova','forge']);
  assert.deepEqual(state.activeAgentIds, ['forge']);
  assert.equal(state.meeting.taskId, 't1');
  assert.equal(state.meeting.stage, 'Prototype');
  assert.ok(state.load > 0 && state.load <= 1);
});
test('unrelated single-agent assignments do not pretend to be a collaboration', () => {
  const tasks = ['nova','forge'].map((agentId,id) => ({id,status:'running',steps:[{agentId,status:'running'}]}));
  assert.deepEqual(deriveActivity({tasks}).collaboratingIds, []);
});
test('chat participants collaborate only for the current live turn', () => {
  const chat = {running:true,participantIds:['nova','forge','forge'],activeAgentIds:['forge']};
  assert.deepEqual(deriveActivity({chat}).collaboratingIds, ['nova','forge']);
  assert.deepEqual(deriveActivity({chat:{...chat,running:false}}).collaboratingIds, []);
});
test('failure keys remain stable across polls and clear after a retry', () => {
  const task = {id:'t1',status:'failed',version:3,updatedAt:'2026-09-27T12:00:00Z'};
  const first = deriveActivity({tasks:[task]});
  assert.equal(first.problemKey, deriveActivity({tasks:[structuredClone(task)]}).problemKey);
  assert.equal(first.load, 0);
  assert.equal(deriveActivity({tasks:[{...task,status:'running'}]}).problemKey, null);
});
test('elapsed work uses the start event rather than a freshly saved stage timestamp', () => {
  const now = Date.parse('2026-09-27T12:05:00Z');
  const task = {id:'t1',status:'running',updatedAt:'2026-09-27T12:04:59Z',events:[{type:'started',createdAt:'2026-09-27T12:00:00Z'}],steps:[{agentId:'nova',status:'running'}]};
  const older = deriveActivity({tasks:[task],now});
  const fresh = deriveActivity({tasks:[{...task,events:[{type:'started',createdAt:'2026-09-27T12:04:59Z'}]}],now});
  assert.ok(older.load > fresh.load);
  assert.equal(older.load,deriveActivity({tasks:[{...task,updatedAt:'2026-09-27T12:05:00Z'}],now}).load);
});
test('workload is bounded and project identities are stable without sharing context', () => {
  const state = deriveActivity({chat:{running:true,activeAgentIds:Array.from({length:50},(_,i)=>String(i)),startedAt:0},now:1e10});
  assert.equal(state.load, 1);
  assert.deepEqual(scopeIdentity({id:'product-a',kind:'project',name:'Product A'}), scopeIdentity({id:'product-a',kind:'project',name:'Product A'}));
  assert.notEqual(scopeIdentity({id:'personal'}).icon, scopeIdentity({id:'business'}).icon);
});

test('repository execution drives the active coding role and switches to review without inventing parallel work', async () => {
  const {repositoryActivityTasks}=await import('../dist/experience-state.js');
  const run={id:'repo-run',status:'running',stage:'editing',title:'Fix a bug'};
  assert.deepEqual(deriveActivity({tasks:repositoryActivityTasks([run])}).activeAgentIds,['forge']);
  assert.deepEqual(deriveActivity({tasks:repositoryActivityTasks([{...run,stage:'reviewing'}])}).activeAgentIds,['nova']);
  assert.equal(deriveActivity({tasks:repositoryActivityTasks([{...run,status:'review'}])}).load,0);
});
