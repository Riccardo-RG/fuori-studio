import test from 'node:test';
import assert from 'node:assert/strict';
import {executionBudgetBlocks,executionPreviewDefaults,executionPreviewIdentity} from '../dist/execution-preview.js';

test('budget recovery routes daily limits to routines and lifetime limits to budgets',()=>{
  const resetAt='2026-10-01T00:00:00.000Z';
  const blocks=executionBudgetBlocks({allowed:false,blocking:['DAILY_CALL_LIMIT','PROJECT_CALL_LIMIT','ASSIGNMENT_CALL_LIMIT'],daily:{remaining:1,resetAt},project:{remaining:2},assignment:{remaining:0}},3);
  assert.deepEqual(blocks.map(({code,section,remaining,requiredCalls,resetAt})=>({code,section,remaining,requiredCalls,resetAt})),[
    {code:'DAILY_CALL_LIMIT',section:'routines',remaining:1,requiredCalls:3,resetAt},
    {code:'PROJECT_CALL_LIMIT',section:'budgets',remaining:2,requiredCalls:3,resetAt:null},
    {code:'ASSIGNMENT_CALL_LIMIT',section:'budgets',remaining:0,requiredCalls:3,resetAt:null},
  ]);
});

test('budget recovery does not invent resets or directions for unknown blockers',()=>{
  assert.deepEqual(executionBudgetBlocks({allowed:true,blocking:['DAILY_CALL_LIMIT']},1),[]);
  assert.deepEqual(executionBudgetBlocks({allowed:false,blocking:['UNKNOWN','toString']},1),[]);
  assert.deepEqual(executionBudgetBlocks(null,1),[]);
  const blocks=executionBudgetBlocks({allowed:false,blocking:['DAILY_CALL_LIMIT','DAILY_CALL_LIMIT'],daily:{remaining:0,resetAt:'invalid'}},1);
  assert.equal(blocks.length,1);
  assert.equal(blocks[0].resetAt,null);
});

test('repository analysis previews default to the fixed review team and exclude prior history',()=>{
  const input={kind:'chat',scopeId:'business',repositoryAnalysisId:'analysis-1',agentIds:['muse']};
  const defaults=executionPreviewDefaults(input);
  assert.deepEqual(defaults,{selection:{includeHistory:false},agentIds:['forge','growth','nova']});
  const restored={selection:{includeHistory:true,excludeMemoryIds:['memory-1']},agentIds:['radar']};
  const resumed=executionPreviewDefaults(input,restored);
  assert.deepEqual(resumed,{selection:restored.selection,agentIds:['forge','growth','nova']});
  resumed.selection.excludeMemoryIds.push('memory-2');
  assert.deepEqual(restored.selection.excludeMemoryIds,['memory-1']);
  assert.deepEqual(executionPreviewDefaults({kind:'chat',agentIds:['nova','muse']}),{selection:{},agentIds:['nova','muse']});
});

test('preview draft identities cannot carry choices across distinct prepared analyses',()=>{
  const input={kind:'chat',scopeId:'business',message:'Compare',repositoryAnalysisId:'analysis-1'};
  assert.notEqual(executionPreviewIdentity(input),executionPreviewIdentity({...input,repositoryAnalysisId:'analysis-2'}));
  assert.notEqual(executionPreviewIdentity(input),executionPreviewIdentity({...input,repositoryAnalysisId:undefined}));
  assert.notEqual(executionPreviewIdentity(input),executionPreviewIdentity({...input,scopeId:'personal'}));
  assert.equal(executionPreviewIdentity(input),executionPreviewIdentity({...input}));
});
