import test from 'node:test';
import assert from 'node:assert/strict';
import {executionBudgetBlocks} from '../dist/execution-preview.js';

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
