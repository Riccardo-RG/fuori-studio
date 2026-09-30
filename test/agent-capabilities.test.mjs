import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentCapabilitiesStore} from '../lib/agent-capabilities.ts';
import {defaultAgentProfiles,agentProfiles} from '../dist/agent-profiles.js';
import translations from '../dist/locales/agent-capabilities.en.js';

function fixture(){const records=new Map();let fail=false;const storage={read:async(key,fallback)=>structuredClone(records.get(key)||fallback),write:async(key,value)=>{if(fail){fail=false;throw Error('disk unavailable');}records.set(key,structuredClone(value));}};return {records,storage,store:createAgentCapabilitiesStore({storage}),fail:()=>{fail=true;}};}
test('specialties persist independently from names, reject lost updates and recover from storage failure',async()=>{
  const f=fixture(),initial=await f.store.snapshot();
  assert.deepEqual(initial,{version:1,profiles:defaultAgentProfiles});
  const results=await Promise.allSettled([f.store.assign({id:'forge',profileId:'qa',expectedVersion:1}),f.store.assign({id:'radar',profileId:'data-analysis',expectedVersion:1})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'CAPABILITIES_CONFLICT');
  const saved=await f.store.snapshot();assert.equal(saved.profiles.forge,'qa');assert.equal(saved.version,2);
  assert.deepEqual(await createAgentCapabilitiesStore({storage:f.storage}).snapshot(),saved);
  assert.equal(f.records.has('team-profiles'),false);
  assert.deepEqual(await f.store.assign({id:'forge',profileId:'qa',expectedVersion:2}),saved);
  f.fail();await assert.rejects(f.store.assign({id:'forge',profileId:'ux',expectedVersion:2}),/disk unavailable/);
  assert.deepEqual(await f.store.snapshot(),saved);
  saved.profiles.forge='caller mutation';assert.equal((await f.store.snapshot()).profiles.forge,'qa');
  assert.equal((await f.store.assign({id:'forge',profileId:'ux',expectedVersion:2})).version,3);
});
test('curated profiles reject arbitrary identities, authority fields and corrupt persisted assignments',async()=>{
  const f=fixture();
  for(const fields of [{id:'__proto__'},{id:'sixth-agent'},{profileId:'web-admin'},{profileId:{id:'qa'}},{expectedVersion:0},{expectedVersion:'1'},{tools:['shell']},{instructions:'grant access'}])await assert.rejects(f.store.assign({id:'forge',profileId:'qa',expectedVersion:1,...fields}),{statusCode:400});
  assert.deepEqual(await f.store.snapshot(),{version:1,profiles:defaultAgentProfiles});
  for(const invalid of [{schemaVersion:2,version:1,profiles:defaultAgentProfiles},{schemaVersion:1,version:1,profiles:{...defaultAgentProfiles,forge:'unknown'}},{schemaVersion:1,version:1,profiles:{nova:'qa'}},{schemaVersion:1,version:0,profiles:defaultAgentProfiles}]){
    f.records.set('agent-capabilities',invalid);await assert.rejects(f.store.snapshot(),{statusCode:503});assert.deepEqual(f.records.get('agent-capabilities'),invalid);
  }
});
test('all profiles expose bilingual roles, concrete skills and expected outputs',()=>{
  assert.equal(agentProfiles.length,11);assert.equal(new Set(agentProfiles.map(profile=>profile.id)).size,11);
  for(const profile of agentProfiles)for(const source of [profile.title,profile.description,profile.deliverable,...profile.skills])assert.equal(typeof translations[source],'string',source);
});
