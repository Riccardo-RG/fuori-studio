import test from 'node:test';
import assert from 'node:assert/strict';
import {configureSourceContext,augmentContextSources,contextEvidence,contextMessages,assertSourceEvidence,snapshotWithSources,contextPrompt} from '../lib/context.mjs';

test('document provenance is scope-bound, versioned and withdrawn from old conversations when stale', async t=>{
 const source={id:'s1',scopeId:'development',version:1,digest:'sha',title:'Specification',status:'current',url:'https://example.org/spec'};
 configureSourceContext({allMetadata:async()=>[source],retrieve:async()=>({sources:[source],passages:[{sourceId:'s1',sourceVersion:1,title:'Specification',page:2,text:'Reviewable requirement.'}],truncated:false})});
 t.after(()=>configureSourceContext(null));
 const context=await augmentContextSources({scope:{id:'development'},memories:[],workflow:null},'requirement');
 const evidence=contextEvidence(context);assert.equal(evidence.sources[0].digest,'sha');assert.match(contextPrompt(context),/Reviewable requirement/);
 const messages=[{role:'assistant',text:'Answer',context:evidence}];
 assert.equal(contextMessages(messages,{scopeId:'development',agentId:'forge',snapshot:await snapshotWithSources({memories:[],workflows:[]})}).length,1);
 await assertSourceEvidence(evidence,'development');await assert.rejects(assertSourceEvidence(evidence,'personal'));
 source.status='stale';await assert.rejects(assertSourceEvidence(evidence,'development'));
 assert.equal(contextMessages(messages,{scopeId:'development',agentId:'forge',snapshot:await snapshotWithSources({memories:[],workflows:[]})}).length,0);
 source.status='current';source.version=2;await assert.rejects(assertSourceEvidence(evidence,'development'));
});
