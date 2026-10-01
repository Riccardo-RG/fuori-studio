import test from 'node:test';
import assert from 'node:assert/strict';
import {systemAwarenessHTML} from '../dist/execution-preview.js';
import {setLanguage} from '../dist/i18n.js';

const sample=()=>({
  knowledge:{
    identity:{name:'Fuori Studio',version:'0.6.0',commit:'abc123',capturedAt:'2026-10-01T10:00:00.000Z',sourceDigest:'sha256:startup',dirtyAtStart:false},
    sourceChanged:false,topics:['providers','usage'],facts:['A studio dispatch counts as one call.'],
    evidence:[{path:'lib/providers.mjs',startLine:12,endLine:15,digest:'sha256:excerpt',text:'const tokenCount = null;'}],
    limitations:['Provider billing is unavailable.'],
  },
  runtime:{
    mode:'local',provider:{type:'codex',model:'local-default',modelKnown:false,executionTarget:'local',authentication:'chatgpt_login'},
    budget:{daily:{remaining:7,callLimit:10,resetAt:'2026-10-02T00:00:00.000Z'},project:{remaining:8,callLimit:20},assignment:{remaining:2,callLimit:4}},
    availability:{appCallsRemaining:2,appLimitReached:false,providerQuotaKnown:false},
    capabilities:[{id:'supplied_materials',available:true,description:'Analisi dei materiali selezionati e preparazione di testi o piani'},{id:'repository_edit',available:false,description:'Accesso diretto e modifica dei file del repository'}],
    usage:{calls:3,inputTokens:100,outputTokens:40,unknownInputCount:1,unknownOutputCount:1,complete:false,period:'retained_history',projectScoped:false},
    context:{memoryCount:2,sourceCount:1,historyMessages:4},
    recentResponses:[{agentId:'nova',provider:{type:'codex',model:'local-default'},usage:{inputTokens:null,outputTokens:null},durationMs:1600}],
  },
});
const measuredQuota=()=>({source:'codex_app_server',observedAt:'2026-10-01T10:00:00.000Z',ordinaryUsageAllowed:true,limits:[
  {id:'codex',primary:{usedPercent:25,remainingPercent:75,windowDurationMins:300,resetsAt:'2026-10-01T15:00:00.000Z'},secondary:{usedPercent:60,remainingPercent:40,windowDurationMins:10080,resetsAt:'2026-10-08T10:00:00.000Z'}},
  {id:'review',primary:{usedPercent:10,remainingPercent:90,windowDurationMins:30,resetsAt:null},secondary:null},
]});

test('operational availability is optional, collapsed and puts remaining capacity ahead of technical usage',()=>{
  setLanguage('it',{persist:false});
  assert.equal(systemAwarenessHTML(undefined),'');
  assert.equal(systemAwarenessHTML(null),'');
  const html=systemAwarenessHTML(sample());
  assert.match(html,/^<details class="preview-system-awareness"><summary>Disponibilità operativa<\/summary>/);
  assert.match(html,/<dt>Quota residua dell’account AI<\/dt><dd>Non disponibile<\/dd>/);
  assert.match(html,/<dt>Chiamate ancora consentite dall’app per questo lavoro<\/dt><dd>2<\/dd>/);
  assert.match(html,/non garantiscono disponibilità sul servizio AI/);
  const technicalStart=html.indexOf('<details class="preview-system-detail preview-system-usage">');
  assert.ok(technicalStart>html.indexOf('Chiamate disponibili: 7 · limite: 10'));
  assert.ok(technicalStart>html.indexOf('Capacità autorizzate per questa esecuzione'));
  assert.ok(technicalStart<html.indexOf('Token riportati dal servizio'));
  assert.match(html,/<details class="preview-system-detail preview-system-usage"><summary>Dettagli tecnici del consumo<\/summary>/);
  assert.match(html,/<dt>Versione<\/dt><dd>0\.6\.0<\/dd>/);
  assert.match(html,/abc123/);
  assert.match(html,/Modello effettivo non comunicato dal servizio/);
  assert.match(html,/<dt>Tipo di accesso<\/dt><dd>Accesso ChatGPT<\/dd>/);
  assert.match(html,/limite giornaliero è condiviso da tutta l’installazione/);
  assert.doesNotMatch(html,/local-default/);
  assert.match(html,/Utilizzo registrato per questo agente nell’ambito attivo/);
  assert.match(html,/Input: 100 · output: 40/);
  assert.match(html,/Input: Non disponibile · output: Non disponibile/);
  assert.match(html,/valori mancanti non equivalgono a zero/);
  assert.match(html,/non indicano le quote dell’account/);
  assert.match(html,/Chiamate disponibili: 7 · limite: 10/);
  assert.match(html,/lib\/providers\.mjs:12–15/);
  assert.doesNotMatch(html,/<(?:input|button|select)\b/);
});

test('system knowledge never promotes source text or metadata to active markup',()=>{
  const value=sample();
  const payload='</code></pre><img src=x onerror="alert(1)"><script>alert(2)</script>&\'';
  value.knowledge.identity.name=payload;
  value.knowledge.identity.version=payload;
  value.knowledge.identity.commit=payload;
  value.knowledge.identity.sourceDigest=payload;
  value.knowledge.facts=[payload];
  value.knowledge.topics=[payload];
  value.knowledge.limitations=[payload];
  value.knowledge.evidence=[{path:payload,startLine:payload,endLine:payload,digest:payload,text:payload}];
  value.runtime.provider={type:payload,model:payload,modelKnown:true,executionTarget:payload};
  value.runtime.recentResponses[0].agentId=payload;
  value.runtime.recentResponses[0].provider={type:payload,model:payload};
  value.runtime.capabilities=[{id:payload,available:true,description:payload}];
  const html=systemAwarenessHTML(value);
  assert.doesNotMatch(html,/<img\b|<script\b|onerror="/);
  assert.match(html,/&lt;\/code&gt;&lt;\/pre&gt;&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html,/<pre tabindex="0"><code>&lt;\/code&gt;/);
  assert.match(html,/&amp;&#39;/);
});

test('capabilities describe the current run without creating controls or inventing missing grants',()=>{
  const value=sample();
  let html=systemAwarenessHTML(value);
  assert.match(html,/<strong>Autorizzata<\/strong><span>Analisi dei materiali selezionati/);
  assert.match(html,/<strong>Non autorizzata in questa esecuzione<\/strong><span>Accesso diretto e modifica/);
  assert.doesNotMatch(html,/<(?:input|button|select)\b/);
  delete value.runtime.capabilities;
  delete value.runtime.availability;
  html=systemAwarenessHTML(value);
  assert.match(html,/Capacità operative non disponibili nell’anteprima/);
  assert.doesNotMatch(html,/Chiamate ancora consentite dall’app per questo lavoro/);
  assert.match(html,/Chiamate disponibili: 7 · limite: 10/);
  value.runtime.availability={appCallsRemaining:0,appLimitReached:true,providerQuotaKnown:false};
  html=systemAwarenessHTML(value);
  assert.match(html,/<dt>Chiamate ancora consentite dall’app per questo lavoro<\/dt><dd>0<\/dd>/);
  assert.match(html,/È stato raggiunto un limite dell’app per questo lavoro/);
  assert.match(html,/<dt>Quota residua dell’account AI<\/dt><dd>Non disponibile<\/dd>/);
});

test('measured account quotas display each window and observation separately from app allowances',()=>{
  const value=sample();
  value.runtime.accountQuota=measuredQuota();
  const html=systemAwarenessHTML(value);
  assert.match(html,/Quota residua dell’account Codex/);
  assert.match(html,/Residuo: 75% · durata: 5 ore/);
  assert.match(html,/Residuo: 40% · durata: 7 giorni/);
  assert.match(html,/Residuo: 90% · durata: 30 minuti/);
  assert.match(html,/Ultima osservazione: .*10:00 UTC/);
  assert.match(html,/Rinnovo indicato dal servizio: .*15:00 UTC/);
  assert.match(html,/Rinnovo indicato dal servizio: Non disponibile/);
  assert.match(html,/condivise dall’intero account, anche fuori da Fuori Studio/);
  assert.match(html,/non garantiscono una richiesta riuscita/);
  assert.match(html,/Il servizio consente l’utilizzo ordinario al momento dell’osservazione/);
  assert.match(html,/Chiamate disponibili: 7 · limite: 10/);
  assert.ok(html.indexOf('Residuo: 75%')<html.indexOf('Chiamate disponibili: 7'));
  assert.doesNotMatch(html,/Il servizio non comunica la quota residua dell’account/);
});

test('provider usage permission comes only from the explicit boolean, never remaining percent or reset',()=>{
  const value=sample();
  value.runtime.accountQuota=measuredQuota();
  value.runtime.accountQuota.ordinaryUsageAllowed=false;
  let html=systemAwarenessHTML(value);
  assert.match(html,/Residuo: 75%/);
  assert.match(html,/Il servizio segnala che l’utilizzo ordinario non è disponibile/);
  assert.doesNotMatch(html,/Il servizio consente l’utilizzo ordinario/);
  value.runtime.accountQuota.ordinaryUsageAllowed=true;
  value.runtime.accountQuota.limits[0].primary.remainingPercent=0;
  value.runtime.accountQuota.limits[0].primary.resetsAt='2020-01-01T00:00:00.000Z';
  html=systemAwarenessHTML(value);
  assert.match(html,/Residuo: 0%/);
  assert.match(html,/Il servizio consente l’utilizzo ordinario/);
  value.runtime.accountQuota.ordinaryUsageAllowed=null;
  html=systemAwarenessHTML(value);
  assert.match(html,/Disponibilità dell’utilizzo ordinario non comunicata dal servizio/);
  assert.doesNotMatch(html,/Il servizio consente l’utilizzo ordinario|Il servizio segnala che l’utilizzo ordinario/);
});

test('missing and partial account quotas keep unknown fields explicit and metadata inert',()=>{
  const value=sample();
  for(const quota of [null,{source:'unknown',limits:[]},{source:'codex_app_server'}]){
    value.runtime.accountQuota=quota;
    assert.match(systemAwarenessHTML(value),/<dt>Quota residua dell’account AI<\/dt><dd>Non disponibile<\/dd>/);
  }
  value.runtime.accountQuota=measuredQuota();
  value.runtime.accountQuota.observedAt='invalid';
  value.runtime.accountQuota.limits=[{id:'<img src=x onerror="alert(1)">',primary:{remainingPercent:Infinity,windowDurationMins:-1,resetsAt:'invalid'},secondary:null},{id:'other',primary:null,secondary:null}];
  value.runtime.accountQuota.accountId='private-account';
  value.runtime.accountQuota.credits='private-credit-value';
  const html=systemAwarenessHTML(value);
  assert.match(html,/Ultima osservazione: Non disponibile/);
  assert.match(html,/Residuo: Non disponibile · durata: Non disponibile/);
  assert.match(html,/Finestre di quota non comunicate/);
  assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html,/<img\b|onerror="|Infinity|Invalid Date|private-account|private-credit-value/);
});

test('unknown metadata and invalid counts stay unavailable instead of zero or invented models',()=>{
  const value=sample();
  value.knowledge.identity={capturedAt:'invalid date'};
  value.runtime.usage={calls:null,inputTokens:null,outputTokens:NaN,unknownInputCount:null,unknownOutputCount:-1};
  value.runtime.context={};
  value.runtime.budget={daily:{remaining:null,callLimit:Infinity,resetAt:'invalid'}};
  value.runtime.provider={type:'codex',model:'local-default',modelKnown:true};
  const html=systemAwarenessHTML(value);
  assert.match(html,/<dt>Chiamate registrate<\/dt><dd>Non disponibile<\/dd>/);
  assert.match(html,/Chiamate disponibili: Non disponibile · limite: Non disponibile/);
  assert.doesNotMatch(html,/NaN|Infinity|Invalid Date|local-default/);
  assert.match(html,/Modello effettivo non comunicato dal servizio/);
});

test('source drift, startup changes, project usage and complete reports have explicit display states',()=>{
  const value=sample();
  value.knowledge.sourceChanged=true;
  value.knowledge.evidence[0].truncated=true;
  value.knowledge.identity.dirtyAtStart=true;
  value.runtime.usage.projectScoped=true;
  value.runtime.usage.complete=true;
  value.runtime.usage.unknownInputCount=0;
  value.runtime.usage.unknownOutputCount=0;
  value.runtime.provider={type:'openai',model:'configured-model',modelKnown:true,executionTarget:'server'};
  const html=systemAwarenessHTML(value);
  assert.match(html,/file sono cambiati dopo l’avvio/i);
  assert.match(html,/modifiche locali non ancora registrate/);
  assert.match(html,/Estratto parziale/);
  assert.match(html,/nell’ambito e nel progetto selezionati/);
  assert.match(html,/<dt>Modello<\/dt><dd>configured-model<\/dd>/);
  assert.doesNotMatch(html,/Il totale dei token è incompleto/);
});

test('system knowledge UI localizes captions without translating evidence or server facts',()=>{
  setLanguage('en',{persist:false});
  try{
    const value=sample();
    value.knowledge.evidence[0].text='Conoscenza del sistema';
    value.knowledge.facts=['Memoria'];
    value.runtime.accountQuota=measuredQuota();
    const html=systemAwarenessHTML(value);
    assert.match(html,/<summary>Operational availability<\/summary>/);
    assert.match(html,/<summary>System knowledge and context<\/summary>/);
    assert.match(html,/<summary>Technical usage details<\/summary>/);
    assert.match(html,/Capabilities authorized for this execution/);
    assert.match(html,/Remaining Codex account allowance/);
    assert.match(html,/Remaining: 75% · duration: 5 hours/);
    assert.match(html,/Analysis of selected materials and preparation of text or plans/);
    assert.match(html,/Direct access to and editing of repository files/);
    assert.match(html,/Recorded usage for this agent in the active scope/);
    assert.match(html,/Actual model not reported by the service/);
    assert.match(html,/Code and documentation excerpts/);
    assert.match(html,/Included topics: providers, usage/);
    assert.match(html,/<code>Conoscenza del sistema<\/code>/);
    assert.match(html,/<li>Memoria<\/li>/);
  }finally{setLanguage('it',{persist:false});}
});
