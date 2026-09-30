import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateResultInsights } from '../lib/result-insights.ts';
import { createGovernance } from '../lib/governance.ts';

const projects = [{id:'project-a',title:'Client A',scopeId:'scope-a'},{id:'project-b',title:'Client B',scopeId:'scope-b'}];
const workflows = [{id:'shared-method',title:'Shared method',scopeId:'shared'}];
const task = (id, projectId = 'project-a', scopeId = 'scope-a', decisions = ['approved']) => ({id,projectId,scopeId,workflowId:'shared-method',status:'completed',artifacts:decisions.map(decision=>({decision}))});
const usage = (taskId, status = 'succeeded', scopeId = 'scope-a', projectId = 'project-a') => ({taskId,projectId,scopeId,status});
const outcome = (taskId, helpful, minutesSaved = null) => ({taskId,helpful,minutesSaved});

test('separates delivery versions, assignments, actual AI attempts and explicit feedback', () => {
  const tasks = [task('revised','project-a','scope-a',['changes_requested','approved']),task('unrated'),{...task('pending','project-a','scope-a',['pending']),status:'review'}];
  const statuses = ['succeeded','failed','cancelled','timed_out','interrupted','running'];
  const result = aggregateResultInsights({operations:{projects,tasks},workflows},{usages:statuses.map(status=>usage('revised',status)),outcomes:[outcome('revised',false,0)]});
  const group = result.projects[0];
  assert.equal(group.assignments,3);
  assert.deepEqual(group.deliveries,{approved:2,revised:1,pending:1,reviewed:3,approvalRatio:2/3});
  assert.deepEqual(group.calls,{total:6,succeeded:1,failed:1,cancelled:1,timedOut:1,interrupted:1,running:1});
  assert.deepEqual(group.feedback,{eligible:2,responses:1,helpful:0,unhelpful:1,missing:1,minutesSaved:0,minutesSavedEntries:1,selfReported:true});
  assert.equal(result.procedures[0].title,'Shared method');
  assert.deepEqual(result.procedures[0].calls,group.calls);
});

test('scope filtering follows actual assignments, not a shared procedure owning scope', () => {
  const tasks = [task('a'),task('b','project-b','scope-b')];
  const context = {operations:{projects,tasks},workflows};
  const ledger = {usages:[usage('a'),usage('b','failed','scope-b','project-b')],outcomes:[outcome('a',true,12),outcome('b',false,4)]};
  const scoped = aggregateResultInsights({...context,scopeId:'scope-b'},ledger);
  assert.deepEqual(scoped.projects.map(item=>item.id),['project-b']);
  assert.deepEqual(scoped.procedures[0].scopeIds,['scope-b']);
  assert.equal(scoped.procedures[0].feedback.helpful,0);
  assert.equal(scoped.procedures[0].feedback.minutesSaved,4);
  assert.equal(scoped.procedures[0].calls.failed,1);
  const all = aggregateResultInsights(context,ledger);
  assert.equal(all.procedures.length,1);
  assert.deepEqual(all.procedures[0].scopeIds,['scope-a','scope-b']);
  assert.equal(all.procedures[0].feedback.minutesSaved,16);
});

test('project totals include repository revisions and planning calls without guessing a procedure', () => {
  const runs = [{id:'first',projectId:'project-a',scopeId:'scope-a',status:'completed',patchHash:'hash',decision:{status:'changes_requested'}},{id:'second',parentRunId:'first',projectId:'project-a',scopeId:'scope-a',status:'completed',patchHash:'hash',decision:{status:'approved'}},{id:'failed',projectId:'project-a',scopeId:'scope-a',status:'failed',patchHash:null}];
  const result = aggregateResultInsights({operations:{projects},repositoryState:{runs}},{usages:[{scopeId:'scope-a',projectId:'project-a',runId:'first',status:'succeeded'},{scopeId:'scope-a',projectId:'project-a',runId:'second',status:'succeeded'},{scopeId:'scope-a',projectId:'project-a',status:'failed'}],outcomes:[{runId:'second',helpful:true,minutesSaved:null}]});
  assert.deepEqual(result.projects[0].deliveries,{approved:1,revised:1,pending:0,reviewed:2,approvalRatio:0.5});
  assert.equal(result.projects[0].assignments,3);
  assert.equal(result.projects[0].calls.total,3);
  assert.equal(result.projects[0].feedback.minutesSaved,null);
  assert.equal(result.projects[0].feedback.minutesSavedEntries,0);
  assert.equal(result.procedures.length,0);
  assert.equal(result.coverage.callsWithoutProcedure,3);
});

test('unlinked history and mismatching attribution cannot contaminate a procedure', () => {
  const result = aggregateResultInsights({operations:{projects,tasks:[task('a')]},workflows:[]},{usages:[{scopeId:'scope-a',status:'succeeded'},usage('missing'),usage('a','succeeded','scope-b','project-b')],outcomes:[outcome('deleted',true,500),outcome('a',true)]});
  assert.equal(result.coverage.callsWithoutProject,1);
  assert.equal(result.coverage.callsWithoutProcedure,3);
  assert.equal(result.coverage.unattributedFeedback,1);
  assert.equal(result.procedures[0].available,false);
  assert.equal(result.procedures[0].calls.total,0);
  assert.equal(result.procedures[0].feedback.minutesSaved,null);
  assert.equal(result.projects.find(item=>item.id==='project-b').calls.total,1);
  assert.equal(aggregateResultInsights().projects.length,0);
});

test('snapshot insights use the full retained ledger beyond the 200-item recent lists', async () => {
  let stored;
  const storage = {read:async (_key,fallback)=>structuredClone(stored??fallback),update:async (_key,update,fallback)=>{stored=update(structuredClone(stored??fallback));return structuredClone(stored);}};
  const governance = createGovernance({storage,clock:()=>Date.parse('2026-09-30T12:00:00Z')});
  await governance.snapshot();
  const tasks = Array.from({length:205},(_,i)=>task(`task-${i}`));
  stored.usages = tasks.map((item,i)=>({...usage(item.id),id:`call-${i}`,agentId:'nova',kind:'task',connectionId:'local',day:'2026-09-30',startedAt:'2026-09-30T11:00:00Z',finishedAt:'2026-09-30T11:00:01Z',durationMs:1000,inputTokens:null,outputTokens:null,errorCode:null}));
  stored.outcomes = tasks.map((item,i)=>({...outcome(item.id,true,i===0?0:null),id:`outcome-${i}`,note:'',version:1,createdAt:'2026-09-30T11:00:00Z',updatedAt:'2026-09-30T11:00:00Z'}));
  const snapshot = await governance.snapshot({operations:{projects,tasks},workflows,scopeId:'scope-a'});
  assert.equal(snapshot.usages.length,200);
  assert.equal(snapshot.outcomes.length,200);
  assert.equal(snapshot.insights.projects[0].calls.total,205);
  assert.equal(snapshot.insights.projects[0].feedback.responses,205);
  assert.equal(snapshot.insights.projects[0].feedback.minutesSaved,0);
  assert.equal(snapshot.insights.projects[0].feedback.minutesSavedEntries,1);
});

test('historical scope rows cannot borrow moved project titles or revoked workflow metadata', () => {
  const movedProject = {id:'moved',scopeId:'scope-b',title:'PRIVATE_PROJECT_TITLE'};
  const workflow = {id:'shared-method',scopeId:'scope-b',title:'PRIVATE_WORKFLOW_TITLE',sharedWith:[]};
  const context = {scopeId:'scope-a',operations:{projects:[...projects,movedProject],tasks:[task('valid'),task('foreign','moved','scope-a')]},repositoryState:{runs:[{id:'foreign-run',projectId:'moved',scopeId:'scope-a',status:'completed',patchHash:'hash',decision:{status:'approved'}}]},workflows:[workflow]};
  const ledger = {usages:[{projectId:'moved',scopeId:'scope-a',status:'succeeded'},usage('valid'),usage('foreign','succeeded','scope-a','moved')],outcomes:[outcome('foreign',true,500),{runId:'foreign-run',helpful:true,minutesSaved:500}]};
  const result = aggregateResultInsights(context,ledger);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROJECT_TITLE|PRIVATE_WORKFLOW_TITLE/);
  const moved = result.projects.find(item=>item.id==='moved');
  assert.equal(moved.title,'moved');
  assert.equal(moved.available,false);
  assert.equal(moved.calls.total,2,'retained attempts keep their original scope attribution');
  assert.equal(moved.assignments,0,'foreign current task and run references do not contribute outcomes');
  assert.equal(moved.feedback.minutesSaved,null);
  assert.equal(result.procedures[0].title,'shared-method');
  assert.equal(result.procedures[0].calls.total,1);
  const shared = aggregateResultInsights({...context,workflows:[{...workflow,sharedWith:['scope-a']}]},ledger);
  assert.equal(shared.procedures[0].title,'PRIVATE_WORKFLOW_TITLE','explicit current sharing permits the title');
});
