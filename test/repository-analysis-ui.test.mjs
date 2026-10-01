import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryAnalysisChoices,repositoryAnalysisInput,repositoryAnalysisPreviewHTML,readRepositoryAnalysis,repositoryAnalysisDraftMatches} from '../dist/repository-analysis.js';
import {setLanguage} from '../dist/i18n.js';

const snapshot={connections:[
  {id:'github-1',name:'Personal',tokenConfigured:true,scopeIds:['business'],repositories:['owner/api','owner/web'],token:'must-not-leak'},
  {id:'other',name:'Other scope',tokenConfigured:true,scopeIds:['personal'],repositories:['other/private']},
  {id:'unconfigured',tokenConfigured:false,scopeIds:['business'],repositories:['owner/missing']},
]};
const makeInput=()=>({scopeId:'business',goal:'Compare product opportunities',targets:[{connectionId:'github-1',repository:'owner/api'}]});
const prepared=()=>({id:'analysis-1',...makeInput(),repositories:[{repository:'owner/api',ref:'main',commit:'a'.repeat(40),url:'https://github.com/owner/api',coverage:{treeEntries:10,eligibleFiles:6,readFiles:2,omittedFiles:4,treeTruncated:true},files:[{path:'src/index.ts',blobSha:'b'.repeat(40),startLine:1,endLine:20,truncated:true,url:'https://github.com/owner/api/blob/'+('a'.repeat(40))+'/src/index.ts'}],source:{id:'source-1',scopeId:'business',title:'Snapshot',version:1,digest:'digest'}}]});

test('repository choices expose only configured current-scope targets, never connection secrets',()=>{
  const choices=repositoryAnalysisChoices(snapshot,'business');
  assert.equal(choices.length,2);
  assert.deepEqual(choices.map(choice=>choice.repository),['owner/api','owner/web']);
  assert.doesNotMatch(JSON.stringify(choices),/must-not-leak|other\/private|missing/);
  assert.deepEqual(repositoryAnalysisChoices(null,'business'),[]);
  assert.deepEqual(repositoryAnalysisChoices(snapshot,'unknown'),[]);
  assert.deepEqual(repositoryAnalysisChoices({connections:[{id:'unsafe',tokenConfigured:true,scopeIds:['business'],repositories:['../private','owner/..','owner/repo.git','https://github.com/owner/repo']}]},'business'),[]);
});

test('prepare input binds scope, selected allowlisted repositories and optional refs',()=>{
  const choices=repositoryAnalysisChoices(snapshot,'business');
  const input=repositoryAnalysisInput({scopeId:'business',goal:'  Compare  ',selected:[{key:choices[0].key,ref:' release/v1 '},{key:choices[1].key,ref:''}]},choices,'business');
  assert.deepEqual(input,{scopeId:'business',goal:'Compare',targets:[{connectionId:'github-1',repository:'owner/api',ref:'release/v1'},{connectionId:'github-1',repository:'owner/web'}]});
  assert.throws(()=>repositoryAnalysisInput({scopeId:'business',goal:'Compare',selected:[{key:choices[0].key}]},choices,'personal'),/ambito/);
  assert.throws(()=>repositoryAnalysisInput({scopeId:'business',goal:'Compare',selected:[{key:'injected'}]},choices,'business'),/non autorizzati/);
  assert.throws(()=>repositoryAnalysisInput({scopeId:'business',goal:'Compare',selected:[]},choices,'business'),/cinque/);
  assert.throws(()=>repositoryAnalysisInput({scopeId:'business',goal:'Compare',selected:Array(6).fill({key:choices[0].key})},choices,'business'),/cinque/);
  assert.throws(()=>repositoryAnalysisInput({scopeId:'business',goal:'Compare',selected:[{key:choices[0].key},{key:choices[0].key}]},choices,'business'),/duplicati/);
  assert.throws(()=>repositoryAnalysisInput({scopeId:'business',goal:'x'.repeat(6001),selected:[{key:choices[0].key}]},choices,'business'),/6.000/);
  assert.throws(()=>repositoryAnalysisInput({scopeId:'business',goal:'Compare',selected:[{key:choices[0].key,ref:'main\nnext'}]},choices,'business'),/riferimento/);
  for(const ref of ['branch name','../main','-main','/main','main/','main\\next'])assert.throws(()=>repositoryAnalysisInput({scopeId:'business',goal:'Compare',selected:[{key:choices[0].key,ref}]},choices,'business'),/riferimento/);
});

test('cancelled analysis drafts can resume only in the same scope and conversation with the same objective',()=>{
  const draft={id:'analysis-1',scopeId:'business',conversationId:'chat-1',goal:'Compare'};
  const current={scopeId:'business',conversationId:'chat-1',message:'Compare'};
  assert.equal(repositoryAnalysisDraftMatches(draft,current),true);
  assert.equal(repositoryAnalysisDraftMatches(draft,{...current,message:'Changed objective'}),false);
  assert.equal(repositoryAnalysisDraftMatches(draft,{...current,scopeId:'personal'}),false);
  assert.equal(repositoryAnalysisDraftMatches(draft,{...current,conversationId:'chat-2'}),false);
  assert.equal(repositoryAnalysisDraftMatches(null,current),false);
  assert.equal(repositoryAnalysisDraftMatches(draft,{scopeId:'business',conversationId:'chat-1'}),true);
});

test('preparation transport calls only read preparation and rejects scope drift, aborts and malformed responses',async()=>{
  const requests=[],payload=makeInput();
  const fetchImpl=async(path,options)=>{requests.push({path,options});return {ok:true,json:async()=>prepared()};};
  const result=await readRepositoryAnalysis(payload,{fetchImpl});
  assert.equal(result.id,'analysis-1');
  assert.equal(requests.length,1);
  assert.equal(requests[0].path,'/api/repository-analysis/prepare');
  assert.equal(requests[0].options.method,'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body),payload);
  assert.doesNotMatch(JSON.stringify(requests),/api\/chat|api\/providers|must-not-leak/);
  await assert.rejects(readRepositoryAnalysis(payload,{fetchImpl,getScopeId:()=> 'personal'}),/ambito/);
  assert.equal(requests.length,1);
  let scope='business';
  await assert.rejects(readRepositoryAnalysis(payload,{getScopeId:()=>scope,fetchImpl:async()=>{scope='personal';return {ok:true,json:async()=>prepared()};}}),/ambito/);
  const controller=new AbortController();
  await assert.rejects(readRepositoryAnalysis(payload,{signal:controller.signal,fetchImpl:async()=>{controller.abort();return {ok:true,json:async()=>prepared()};}}),{name:'AbortError'});
  await assert.rejects(readRepositoryAnalysis(payload,{fetchImpl:async()=>({ok:true,json:async()=>({...prepared(),goal:'unexpected goal'})})}),/non è leggibile/);
  await assert.rejects(readRepositoryAnalysis(payload,{fetchImpl:async()=>({ok:false,json:async()=>({error:'Read denied'})})}),/Read denied/);
});

test('analysis evidence reports sampling and immutable references without claims of tests or secret content',()=>{
  const value=prepared();
  value.repositories[0].token='must-not-render';
  value.repositories[0].files[0].content='must-not-render-content';
  const html=repositoryAnalysisPreviewHTML(value);
  assert.match(html,/Nessun test o comando è stato eseguito/);
  assert.match(html,/restano nell’archivio anche annullando o revocando/);
  assert.match(html,/File letti: 2 · idonei: 6 · omessi: 4 · voci nell’albero: 10/);
  assert.match(html,/albero incompleto/);
  assert.match(html,/src\/index.ts:1–20/);
  assert.match(html,/a{40}/);
  assert.match(html,/Estratto parziale/);
  assert.doesNotMatch(html,/must-not-render|<input|<button/);
  assert.equal(repositoryAnalysisPreviewHTML(null),'');
});

test('analysis evidence escapes metadata and rejects executable or off-site citation links',()=>{
  const value=prepared(),attack='<img src=x onerror="alert(1)">';
  const repository=value.repositories[0];
  repository.repository=attack;repository.ref=attack;repository.commit=attack;repository.url='javascript:alert(1)';
  repository.files[0]={path:attack,startLine:attack,endLine:attack,url:'https://github.com.evil.example/x'};
  const html=repositoryAnalysisPreviewHTML(value);
  assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html,/<img\b|onerror="|href=/);
  repository.url='https://user:password@github.com/owner/api';
  assert.doesNotMatch(repositoryAnalysisPreviewHTML(value),/href=/);
});

test('analysis evidence localizes labels but preserves repository identifiers',()=>{
  setLanguage('en',{persist:false});
  try{const value=prepared();value.repositories[0].repository='owner/Memoria';const html=repositoryAnalysisPreviewHTML(value);assert.match(html,/Repositories acquired for analysis/);assert.match(html,/No tests or commands were executed/);assert.match(html,/Files read: 2 · eligible: 6/);assert.match(html,/owner\/Memoria/);}finally{setLanguage('it',{persist:false});}
});
