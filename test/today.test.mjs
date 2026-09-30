import test from 'node:test';
import assert from 'node:assert/strict';
import {buildToday,createTodayService} from '../lib/today.ts';
const now=Date.parse('2026-09-30T12:00:00Z');
const workspace={scopes:[{id:'business',name:'Business'},{id:'personal',name:'Personal'}]};
const task=(id,status='queued',more={})=>({id,title:id,projectId:'product',scopeId:'business',status,version:1,createdAt:'2026-09-29T12:00:00Z',steps:[{title:'Saved analysis',status:'completed'},{title:'Draft',status:'pending'}],...more});
const operations=()=>({projects:[{id:'product',scopeId:'business',title:'My product'},{id:'private',scopeId:'personal',title:'PRIVATE_PROJECT'}],tasks:[],routines:[]});

test('Today orders decisions that unblock work, retains saved progress and excludes superseded repository attempts',()=>{
 const work=operations();work.tasks=[task('isolated','review'),task('brief','review'),task('next','queued',{dependencies:['brief']}),task('resume','paused'),task('active','running')];
 const runs=[{...task('old','review'),decision:{status:'changes_requested'}},{...task('new','queued'),parentRunId:'old'}];
 const result=buildToday(workspace,work,runs,[],{scopeId:'business'},now);
 assert.deepEqual(result.groups.review.items.map(item=>item.id),['brief','isolated']);
 assert.equal(result.groups.review.items[0].unblocks,1);assert.equal(result.groups.waiting.items[0].dependencies[0].title,'brief');
 assert.deepEqual(result.groups.interrupted.items[0].progress,{completed:1,total:2,next:'Draft'});
 assert.equal(result.counts.running,1);assert.equal(result.counts.ready,1);assert.equal(result.groups.ready.items[0].id,'new');
 work.tasks[1]={...work.tasks[1],status:'completed',artifacts:[{decision:'approved'}]};
 assert.equal(buildToday(workspace,work,runs,[],{scopeId:'business'},now).counts.waiting,0);
});

test('scope and project filters cannot expose private or foreign dependency titles',()=>{
 const work=operations();work.tasks=[task('private-task','review',{projectId:'private',scopeId:'personal',title:'PRIVATE_TASK'}),task('blocked','queued',{dependencies:['private-task']}),task('forged','queued',{scopeId:'personal'})];
 const result=buildToday(workspace,work,[],[{scopeId:'personal',status:'stale'}],{scopeId:'business'},now);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_TASK|PRIVATE_PROJECT|forged/);assert.equal(result.groups.waiting.items[0].dependencies[0].available,false);assert.equal(result.staleSources,0);
 assert.throws(()=>buildToday(workspace,work,[],[],{scopeId:'business',projectId:'private'},now),{statusCode:404});
 assert.throws(()=>buildToday(workspace,work,[],[],{scopeId:undefined},now),{statusCode:404});
 assert.equal(buildToday(workspace,work,[],[],{scopeId:'*'},now).counts.review,1);
});

test('routine window, bounded groups and read-only aggregation are deterministic without provider access',async()=>{
 const work=operations();work.tasks=Array.from({length:15},(_,index)=>task('task-'+index));
 work.routines=[{id:'due',title:'Due',projectId:'product',enabled:true,nextRunAt:'2026-09-30T10:00:00Z'},{id:'soon',title:'Soon',projectId:'product',enabled:true,nextRunAt:'2026-10-01T12:00:00Z'},{id:'later',title:'Later',projectId:'product',enabled:true,nextRunAt:'2026-10-01T12:00:01Z'},{id:'disabled',title:'Off',projectId:'product',enabled:false,nextRunAt:'2026-09-30T10:00:00Z'}];
 const original=JSON.stringify(work);
 const service=createTodayService({workspace:{getSnapshot:async()=>workspace},operations:{getSnapshot:async()=>work},repositories:{snapshot:async()=>({runs:[]})},sources:{allMetadata:async()=>[]},now:()=>now});
 const result=await service.snapshot({scopeId:'business'});
 assert.equal(result.groups.ready.total,15);assert.equal(result.groups.ready.items.length,12);assert.deepEqual(result.routines.items.map(item=>item.id),['due','soon']);assert.equal(result.routines.items[0].overdue,true);
 assert.equal(JSON.stringify(work),original);assert.equal(result.noAiCalls,true);
});
