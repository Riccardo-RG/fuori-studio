import {t,ui,locale,onLanguageChange} from './i18n.js';
import {workflowInputFormHTML,readWorkflowInputValues} from './workflow-fields.js';
import {agents} from './data.js';
import {findAgentProfile} from './agent-profiles.js';
import {repositoryAnalysisPreviewHTML} from './repository-analysis.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const name=id=>agents.find(agent=>agent.id===id)?.name||id;
const safeURL=value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}};

export function executionPreviewIdentity(input){
  return JSON.stringify([input.kind,input.id,input.expectedVersion,input.scopeId,input.projectId,input.brief,input.message,input.workflowId,input.expectedWorkflowVersion,input.workflow?.version,input.repositoryAnalysisId]);
}

export function executionPreviewDefaults(input,restored=null){
  return {selection:restored?structuredClone(restored.selection):input.repositoryAnalysisId?{includeHistory:false}:{},agentIds:input.repositoryAnalysisId?['forge','growth','nova']:[...(restored?.agentIds||input.agentIds||['nova'])]};
}

export function systemAwarenessHTML(awareness){
  if(!awareness)return '';
  const knowledge=awareness.knowledge||{},identity=knowledge.identity||{},runtime=awareness.runtime||{},provider=runtime.provider||{},usage=runtime.usage||{},context=runtime.context||{};
  const unknown=()=>t('Non disponibile');
  const count=value=>Number.isFinite(value)&&value>=0?String(value):unknown();
  const present=value=>typeof value==='string'&&value?value:unknown();
  const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat(locale(),{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(new Date(value))+' UTC':unknown();
  const row=(label,value)=>`<div><dt>${escape(t(label))}</dt><dd>${escape(value)}</dd></div>`;
  const list=values=>Array.isArray(values)?values.map(value=>`<li>${escape(value)}</li>`).join(''):'';
  const tokens=value=>t('Input: {input} · output: {output}',{input:count(value?.inputTokens),output:count(value?.outputTokens)});
  const model=provider.modelKnown===true&&provider.model&&provider.model!=='local-default'?provider.model:t('Modello effettivo non comunicato dal servizio');
  const authenticationLabels={chatgpt_login:'Accesso ChatGPT',codex_login:'Accesso Codex',api_key:'Chiave API',unknown:'Non disponibile'};
  const authentication=Object.hasOwn(authenticationLabels,provider.authentication)?t(authenticationLabels[provider.authentication]):unknown();
  const budget=runtime.budget||{};
  const budgetRows=[['daily','Limite giornaliero'],['project','Budget del progetto'],['assignment','Budget dell’incarico']].filter(([key])=>budget[key]).map(([key,label])=>row(label,t('Chiamate disponibili: {remaining} · limite: {limit}',{remaining:count(budget[key].remaining),limit:count(budget[key].callLimit)}))).join('');
  const evidence=Array.isArray(knowledge.evidence)?knowledge.evidence:[];
  const recent=Array.isArray(runtime.recentResponses)?runtime.recentResponses:[];
  const capabilities=Array.isArray(runtime.capabilities)?runtime.capabilities:[];
  const quota=runtime.accountQuota?.source==='codex_app_server'&&Array.isArray(runtime.accountQuota.limits)?runtime.accountQuota:null;
  const percent=value=>Number.isFinite(value)&&value>=0&&value<=100?`${new Intl.NumberFormat(locale(),{maximumFractionDigits:2}).format(value)}%`:unknown();
  const windowDuration=minutes=>{
    if(!Number.isSafeInteger(minutes)||minutes<=0)return unknown();
    if(minutes%1440===0)return t('{count} giorni',{count:minutes/1440});
    if(minutes%60===0)return t('{count} ore',{count:minutes/60});
    return t('{count} minuti',{count:minutes});
  };
  const quotaHTML=()=>{
    if(!quota)return ui`<dl class="preview-system-facts">${row('Quota residua dell’account AI',unknown())}</dl><p class="preview-note">Il servizio non comunica la quota residua dell’account. Le chiamate disponibili nell’app non garantiscono disponibilità sul servizio AI.</p>`;
    const status=quota.ordinaryUsageAllowed===true?'Il servizio consente l’utilizzo ordinario al momento dell’osservazione.':quota.ordinaryUsageAllowed===false?'Il servizio segnala che l’utilizzo ordinario non è disponibile.':'Disponibilità dell’utilizzo ordinario non comunicata dal servizio.';
    return ui`<section class="preview-account-quota"><h4>Quota residua dell’account Codex</h4><p>${escape(t(status))}</p><p>${escape(t('Ultima osservazione: {date}',{date:date(quota.observedAt)}))}</p>${quota.limits.map(limit=>{
      const windows=[['primary','Finestra principale'],['secondary','Finestra secondaria']].filter(([key])=>limit[key]);
      return ui`<div class="preview-account-limit"><strong>${escape(present(limit.id))}</strong>${windows.length?windows.map(([key,label])=>ui`<div class="preview-account-window"><span>${escape(t(label))}</span><p>${escape(t('Residuo: {remaining} · durata: {duration}',{remaining:percent(limit[key].remainingPercent),duration:windowDuration(limit[key].windowDurationMins)}))}</p><small>${escape(t('Rinnovo indicato dal servizio: {date}',{date:date(limit[key].resetsAt)}))}</small></div>`).join(''):ui`<p>Finestre di quota non comunicate.</p>`}</div>`;
    }).join('')}<p>Queste quote sono condivise dall’intero account, anche fuori da Fuori Studio.</p><p>Percentuali e rinnovi non garantiscono una richiesta riuscita e non stabiliscono da soli se il servizio consente l’utilizzo.</p></section>`;
  };
  return ui`<details class="preview-system-awareness"><summary>Disponibilità operativa</summary>
    <p>Disponibilità e capacità preparate per questo agente, prima dell’avvio.</p>
    <dl class="preview-system-facts">${row('Servizio AI',present(provider.type))}</dl>
    ${quotaHTML()}
    <dl class="preview-system-facts">${runtime.availability?row('Chiamate ancora consentite dall’app per questo lavoro',count(runtime.availability.appCallsRemaining)):''}${budgetRows}${budget.daily?row('Rinnovo del limite giornaliero',date(budget.daily.resetAt)):''}</dl>
    ${runtime.availability?.appLimitReached===true?ui`<p class="preview-note">È stato raggiunto un limite dell’app per questo lavoro. Rivedi i limiti prima di avviare.</p>`:''}
    <p>I limiti dell’app contano chiamate AI; non indicano le quote dell’account, il costo o tutti i passaggi interni del servizio.</p>
    <p>Il limite giornaliero è condiviso da tutta l’installazione.</p>
    <h4>Capacità autorizzate per questa esecuzione</h4>
    ${capabilities.length?ui`<ul class="preview-system-capabilities">${capabilities.map(item=>`<li><strong>${escape(t(item.available===true?'Autorizzata':'Non autorizzata in questa esecuzione'))}</strong><span>${escape(t(item.description))}</span></li>`).join('')}</ul>`:ui`<p>Capacità operative non disponibili nell’anteprima.</p>`}
    <details class="preview-system-detail"><summary>Conoscenza del sistema e contesto</summary>
      <p>Informazioni sul sistema incluse nel contesto di questo agente.</p>
      <dl class="preview-system-facts">${row('Applicazione',present(identity.name))}${row('Versione',present(identity.version))}${row('Commit all’avvio',present(identity.commit))}${row('Istantanea acquisita',date(identity.capturedAt))}${identity.sourceDigest?row('Impronta delle fonti',identity.sourceDigest):''}${row('Modalità',present(runtime.mode))}${row('Modello',model)}${provider.authentication?row('Tipo di accesso',authentication):''}${row('Destinazione di esecuzione',present(provider.executionTarget))}</dl>
      <p>La configurazione non certifica il modello effettivamente eseguito né il piano dell’account.</p>
      ${identity.dirtyAtStart===true?ui`<p class="preview-note">L’istantanea include modifiche locali non ancora registrate in un commit.</p>`:''}
      ${knowledge.sourceChanged===true?ui`<p class="preview-note">I file sono cambiati dopo l’avvio. L’agente riceve l’istantanea acquisita all’avvio del server; riavvialo per aggiornare la conoscenza del codice.</p>`:''}
      <h4>Contesto preparato</h4>
      <dl class="preview-system-facts">${row('Memorie selezionate',count(context.memoryCount))}${row('Fonti selezionate',count(context.sourceCount))}${row('Messaggi di cronologia',count(context.historyMessages))}</dl>
      ${knowledge.topics?.length?ui`<p>Argomenti inclusi: ${escape(knowledge.topics.join(', '))}</p>`:''}
      ${knowledge.facts?.length?ui`<h4>Informazioni di riferimento</h4><ul>${list(knowledge.facts)}</ul>`:''}
      ${evidence.length?ui`<h4>Estratti del codice e della documentazione</h4>${evidence.map(item=>ui`<details class="preview-system-evidence"><summary><code>${escape(item.path)}:${escape(item.startLine)}–${escape(item.endLine)}</code></summary><pre tabindex="0"><code>${escape(item.text)}</code></pre>${item.truncated?ui`<p>Estratto parziale.</p>`:''}${item.digest?ui`<small>Impronta: ${escape(item.digest)}</small>`:''}</details>`).join('')}`:''}
      ${knowledge.limitations?.length?ui`<h4>Limiti di conoscenza</h4><ul>${list(knowledge.limitations)}</ul>`:''}
    </details>
    <details class="preview-system-detail preview-system-usage"><summary>Dettagli tecnici del consumo</summary>
      <p>${escape(t(usage.projectScoped?'Utilizzo registrato per questo agente nell’ambito e nel progetto selezionati.':'Utilizzo registrato per questo agente nell’ambito attivo.'))}</p>
      <p>Conteggi della cronologia conservata, prima di questa esecuzione.</p>
      <dl class="preview-system-facts">${row('Chiamate registrate',count(usage.calls))}${row('Token riportati dal servizio',tokens(usage))}${row('Chiamate senza conteggio input',count(usage.unknownInputCount))}${row('Chiamate senza conteggio output',count(usage.unknownOutputCount))}</dl>
      ${usage.complete!==true?ui`<p class="preview-note">Il totale dei token è incompleto: i valori mancanti non equivalgono a zero.</p>`:''}
      ${recent.length?ui`<details class="preview-system-history"><summary>Risposte precedenti nel contesto autorizzato</summary>${recent.map(item=>ui`<article><strong>${escape(name(item.agentId))}</strong><p>${escape(item.provider?.type||unknown())} · ${escape(item.provider?.model&&item.provider.model!=='local-default'?item.provider.model:t('Modello effettivo non comunicato dal servizio'))}</p><p>${escape(tokens(item.usage))} · ${escape(t('Durata: {duration} ms',{duration:count(item.durationMs)}))}</p></article>`).join('')}</details>`:''}
    </details>
  </details>`;
}

export function executionBudgetBlocks(budget,requiredCalls){
  if(!budget||budget.allowed)return [];
  const definitions={DAILY_CALL_LIMIT:{key:'daily',label:'Limite giornaliero',section:'routines'},PROJECT_CALL_LIMIT:{key:'project',label:'Budget del progetto',section:'budgets'},ASSIGNMENT_CALL_LIMIT:{key:'assignment',label:'Budget dell’incarico',section:'budgets'}};
  return [...new Set(budget.blocking||[])].filter(code=>Object.hasOwn(definitions,code)).map(code=>{
    const definition=definitions[code],limit=budget[definition.key],resetAt=definition.key==='daily'?limit?.resetAt:null;
    return {...definition,code,remaining:limit?.remaining,requiredCalls,resetAt:resetAt&&Number.isFinite(Date.parse(resetAt))?resetAt:null};
  });
}

export function createExecutionPreviewDialog(){
  const dialog=document.createElement('dialog');dialog.id='execution-preview-dialog';dialog.className='execution-preview-dialog';dialog.setAttribute('aria-labelledby','execution-preview-title');document.body.append(dialog);
  let workflowMeta=null,target=null,value=null,selection={},agentIds=['nova'],projectId=null,dirty=false,loading=false,error='',resolveOpen=null,generation=0,draft=null,openKey='';
  const number=value=>Number.isFinite(value)?String(value):'—';
  const sourceLink=item=>{const url=safeURL(item.url);return url?`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(t('Apri origine'))} ↗</a>`:'';};
  function itemHTML(item,kind){
    const excluded=selection[kind==='memory'?'excludeMemoryIds':'excludeSourceIds']||[],checked=!excluded.includes(item.id);
    const requiredRepositorySource=kind==='source'&&value?.repositoryAnalysis?.repositories?.some(repository=>repository.source?.id===item.id);
    const lockedNote=requiredRepositorySource?'Fonte richiesta dal confronto selezionato. Per escluderla, seleziona di nuovo i repository.':'Già usato in un risultato precedente necessario.';
    return ui`<article class="preview-reference"><label><input type="checkbox" data-context-kind="${kind}" data-context-id="${escape(item.id)}"${checked?' checked':''}${item.locked?' disabled':''}><span><strong>${escape(item.title)}</strong><small>${escape(item.scopeId||value.scopeId)} · v${escape(item.version||1)}</small></span></label><details><summary>Leggi il contenuto e la provenienza</summary>${kind==='memory'?ui`<p class="preview-prewrap">${escape(item.content)}</p><p>Provenienza: ${escape(item.source||t('Annotazione manuale'))}</p>`:(item.passages||[]).map(passage=>ui`<p class="preview-prewrap">${escape(passage.text)}</p><small>${passage.page?t('Pagina {page}',{page:passage.page}):t('Righe {start}–{end}',{start:passage.lineStart||'?',end:passage.lineEnd||'?'})}</small>`).join('')}${sourceLink(item)}${item.truncated?ui`<p>Estratto parziale.</p>`:''}</details>${item.locked?ui`<small>${escape(t(lockedNote))}</small>`:''}</article>`;
  }
  function stepHTML(step,index){
    if(step.provider?.type==='codex')step={...step,provider:{...step.provider,model:t('Modello effettivo non comunicato dal servizio')}};
    const inheritedNote=value?.repositoryAnalysis?'I tre contributi useranno gli stessi snapshot dei repository selezionati. Per cambiare le fonti richieste, seleziona di nuovo i repository.':'Il lavoro riceve anche risultati precedenti che dipendono da contesto già utilizzato. Per escluderlo occorre un incarico indipendente.';
    return ui`<details class="preview-agent"${index===0?' open':''}><summary><strong>${escape(name(step.agentId))}</strong><span>${escape(step.provider?.name||step.provider?.type||'—')} · ${escape(step.provider?.model||'')}</span></summary><p>${escape(step.title||t('Contributo alla conversazione'))}</p>${step.capability?ui`<p>Specializzazione: <strong>${escape(t(findAgentProfile(step.capability.profileId)?.title||step.capability.profileId))}</strong> · v${escape(step.capability.version)}</p>`:''}<p>Destinazione: <strong>${escape(step.destination?.type==='local'?t('Codex · questo computer'):(step.destination?.name||step.provider?.name||'—'))}</strong></p>${systemAwarenessHTML(step.systemAwareness)}${step.memories.length||step.sources.length?ui`<div class="preview-references">${step.memories.map(item=>itemHTML(item,'memory')).join('')}${step.sources.map(item=>itemHTML(item,'source')).join('')}</div>`:ui`<p>Nessuna memoria o fonte aggiuntiva selezionata.</p>`}${step.workflow?ui`<p>Procedura: <strong>${escape(step.workflow.title)}</strong> · v${step.workflow.version}</p>`:''}${step.history.length?ui`<details><summary>Cronologia inclusa · ${step.history.length} messaggi</summary>${step.history.map(message=>ui`<article class="preview-history"><strong>${escape(message.role==='user'?t('Tu'):name(message.agentId))}</strong><p class="preview-prewrap">${escape(message.text)}</p></article>`).join('')}</details>`:''}${step.dependencies.length?ui`<details><summary>Consegne precedenti richieste · ${step.dependencies.length}</summary>${step.dependencies.map(item=>ui`<article><strong>${escape(item.title)}</strong> · v${item.version}<p class="preview-prewrap">${escape(item.content)}</p></article>`).join('')}</details>`:''}${step.requiredEvidence.memories.length||step.requiredEvidence.sources.length?ui`<p class="preview-note">${escape(t(inheritedNote))}</p>`:''}</details>`;
  }
  function budgetRecovery(){
    if(value?.budget.allowed)return '';
    const blocks=executionBudgetBlocks(value?.budget,value?.requiredCalls);
    return ui`<div class="preview-budget-blocks" role="status"><p class="preview-error">Il budget disponibile non copre le chiamate previste. Rivedi i limiti prima di avviare.</p>${blocks.map(block=>ui`<div class="preview-budget-block"><strong>${escape(t(block.label))}</strong><p>${escape(t('Disponibili: {remaining} · richieste: {required}',{remaining:number(block.remaining),required:number(block.requiredCalls)}))}</p>${block.resetAt?ui`<p>${escape(t('Si rinnova il {date}.',{date:new Intl.DateTimeFormat(locale(),{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(new Date(block.resetAt))+' UTC'}))}</p>`:block.key!=='daily'?ui`<p>Questo limite vale per tutta la durata del lavoro e non si rinnova ogni giorno.</p>`:''}<button type="button" data-preview-settings="${block.section}">${escape(t(block.section==='routines'?'Apri i limiti giornalieri in Routine':'Apri Budget'))}</button></div>`).join('')}<p>Puoi tornare a questo avvio dopo aver controllato i limiti. Le selezioni dell’anteprima restano conservate.</p></div>`;
  }
  function markDirty(){
    dirty=true;
    const start=dialog.querySelector('[data-preview-start]');start.disabled=true;start.title=t('Aggiorna l’anteprima dopo le modifiche.');
    dialog.querySelector('[data-preview-dirty]').textContent=t('Hai modificato la selezione. Aggiorna l’anteprima prima di avviare.');
  }
  function render(){
    const budget=value?.budget;
    dialog.innerHTML=ui`<div class="preview-heading"><div><div class="eyebrow">PRIMA DI AVVIARE</div><h2 id="execution-preview-title">Cosa sa questo agente?</h2></div><button type="button" data-preview-close aria-label="Chiudi finestra">✕</button></div><div class="preview-body">${workflowMeta?.inputFields?.length?`<form id="preview-workflow-form">${workflowInputFormHTML(workflowMeta,target.inputValues||{})}</form>`:''}<p>Controlla dati e servizi prima dell’invio. Escludere una voce vale per questo lavoro e non cancella la memoria.</p>${target?.kind==='chat'?ui`<fieldset class="preview-participants"><legend>Agenti autorizzati per questo messaggio</legend>${agents.map(agent=>ui`<label><input type="checkbox" data-preview-agent="${agent.id}"${agentIds.includes(agent.id)?' checked':''}${agent.id==='nova'?' disabled':''}>${escape(agent.name)}</label>`).join('')}<p>Il coordinatore può coinvolgere fino a tre degli specialisti selezionati. Ogni contributo può consumare una chiamata.</p></fieldset><label class="preview-history-choice"><input type="checkbox" data-preview-history${selection.includeHistory!==false?' checked':''}>Includi la cronologia autorizzata della conversazione</label>${value?.projects?.length?ui`<label>Progetto di riferimento<select data-preview-project><option value="">Nessun progetto · solo limite generale</option>${value.projects.map(project=>ui`<option value="${escape(project.id)}"${projectId===project.id?' selected':''}>${escape(project.title)}</option>`).join('')}</select></label><p>Il team riceverà titolo e descrizione del progetto. Le chiamate saranno conteggiate nel suo budget.</p>`:''}`:''}${error?ui`<p class="preview-error" role="alert">${escape(error)}</p>`:''}${loading?ui`<p role="status">Preparazione dell’anteprima…</p>`:''}${value?ui`<section class="preview-budget"><strong>${escape(value.title)}</strong><p>Chiamate previste al massimo: <b>${value.requiredCalls}</b> · Agenti coinvolti: <b>${value.agentIds.length}</b></p><p>Disponibili oggi: ${number(budget.daily?.remaining)}${budget.project?t(' · nel progetto: {count}',{count:number(budget.project.remaining)}):''}${budget.assignment?t(' · nell’incarico: {count}',{count:number(budget.assignment.remaining)}):''}</p>${budgetRecovery()}${value.agentIds.length>1?ui`<p class="preview-note">Stai autorizzando più agenti. I risultati dei passaggi precedenti possono essere ricevuti dagli agenti successivi.</p>`:''}<p>I conteggi riguardano chiamate AI; non sono un preventivo monetario. Il servizio può addebitare anche tentativi interrotti.</p></section>${value.reviewUnavailable?ui`<p class="preview-error">${escape(value.reviewUnavailable)}</p>`:''}${value.kind==='repository'?ui`<p class="preview-note">L’agente di sviluppo leggerà anche i file della copia isolata del repository ed eseguirà i controlli configurati. La selezione qui riguarda le memorie e i documenti aggiuntivi.</p>`:''}${value.kind==='task'?ui`<p class="preview-note">Saranno inclusi anche brief, dati del progetto e risultati dei passaggi completati. I nuovi risultati dipendono dal lavoro ancora da eseguire.</p>`:''}${value.steps.map(stepHTML).join('')}`:''}</div><div class="preview-footer"><p class="preview-dirty" data-preview-dirty role="status" aria-live="polite">${dirty&&value&&!loading?t('Hai modificato la selezione. Aggiorna l’anteprima prima di avviare.'):''}</p><button type="button" data-preview-close>Annulla</button><button type="button" data-preview-refresh${loading?' disabled':''}>Aggiorna anteprima</button><button type="button" class="is-primary" data-preview-start${loading||dirty||!value?.budget.allowed?' disabled':''}>Conferma e avvia</button></div>`;
    if(target?.repositoryAnalysisId){const fixed=document.createElement('div');fixed.className='preview-note';fixed.innerHTML=ui`<p>Tre contributi: analisi tecnica, valutazione strategica e sintesi del coordinatore.</p><p>Gli estratti saranno inviati a Codex/OpenAI solo premendo «Conferma e avvia». Codex locale usa comunque un servizio AI remoto.</p>`;dialog.querySelector('.preview-participants')?.replaceWith(fixed);}
    if(value?.repositoryAnalysis){const panel=document.createElement('div');panel.innerHTML=repositoryAnalysisPreviewHTML(value.repositoryAnalysis);dialog.querySelector('.preview-budget')?.after(...panel.children);}
    if(dirty)dialog.querySelector('[data-preview-start]').title=t('Aggiorna l’anteprima dopo le modifiche.');
  }
  async function refresh(){
    if(!target||loading)return;
    const fields=dialog.querySelector('#preview-workflow-form');
    if(fields){try{target.inputValues=readWorkflowInputValues(fields);target.expectedWorkflowVersion=workflowMeta.version;}catch(cause){error=cause.message;dirty=true;render();return;}}
    const own=++generation;loading=true;error='';render();
    try{
      const payload={...target,...(Object.keys(selection).length?{selection}:{}),...(target.kind==='chat'?{agentIds:target.repositoryAnalysisId?['forge','growth','nova']:agentIds,projectId}: {})};
      const response=await fetch('/api/execution/preview',{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify(payload)}),result=await response.json();
      if(!response.ok)throw Error(t(result.error||'Non è stato possibile preparare il contesto.'));
      if(own!==generation)return;value=result;selection={...result.selection};agentIds=result.agentIds;projectId=result.projectId||null;dirty=false;
    }catch(cause){if(own===generation){error=cause.message;dirty=true;}}
    finally{if(own===generation){loading=false;render();}}
  }
  const finish=(result,{preserveDraft=false}={})=>{generation++;loading=false;if(!preserveDraft)draft=null;const resolve=resolveOpen;resolveOpen=null;target=null;dialog.close();resolve?.(result);};
  dialog.addEventListener('click',event=>{
    const settings=event.target.closest('[data-preview-settings]');
    if(settings){
      const section=settings.dataset.previewSettings;
      draft={key:openKey,inputValues:{...target.inputValues},selection:structuredClone(selection),agentIds:[...agentIds],projectId};
      finish(null,{preserveDraft:true});const own=generation;
      setTimeout(()=>{if(own===generation)window.dispatchEvent(new CustomEvent('studio-open-operations',{detail:{section}}));},0);return;
    }
    if(event.target.closest('[data-preview-close]'))finish(null);
    if(event.target.closest('[data-preview-refresh]'))void refresh();
    if(event.target.closest('[data-preview-start]')&&!loading&&!dirty&&value?.budget.allowed)finish({previewId:value.previewId});
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
  dialog.addEventListener('input',event=>{if(!event.target.matches('[data-workflow-input-key]'))return;target.inputValues=Object.fromEntries([...dialog.querySelectorAll('[data-workflow-input-key]')].map(input=>[input.dataset.workflowInputKey,input.value]));markDirty();});
  dialog.addEventListener('change',event=>{
    const input=event.target;if(!input.matches('[data-context-kind],[data-preview-agent],[data-preview-history],[data-preview-project],[data-workflow-input-key]'))return;
    if(input.matches('[data-context-kind]')){const key=input.dataset.contextKind==='memory'?'excludeMemoryIds':'excludeSourceIds',set=new Set(selection[key]||[]);if(input.checked)set.delete(input.dataset.contextId);else set.add(input.dataset.contextId);selection[key]=[...set];dialog.querySelectorAll('[data-context-id]').forEach(other=>{if(other.dataset.contextKind===input.dataset.contextKind&&other.dataset.contextId===input.dataset.contextId)other.checked=input.checked;});}
    if(input.matches('[data-preview-agent]'))agentIds=[...dialog.querySelectorAll('[data-preview-agent]:checked')].map(item=>item.dataset.previewAgent);
    if(input.matches('[data-preview-history]'))selection.includeHistory=input.checked;
    if(input.matches('[data-preview-project]'))projectId=input.value||null;
    markDirty();
  });
  onLanguageChange(()=>{if(dialog.open)render();});
  window.addEventListener('studio-session-expired',()=>finish(null));
  return {open(input){
    if(resolveOpen)finish(null);
    const {workflow:metadata,...fields}=input;workflowMeta=metadata||null;
    openKey=executionPreviewIdentity(input);
    const restored=draft?.key===openKey?draft:null;if(!restored)draft=null;
    const defaults=executionPreviewDefaults(input,restored);
    target={...fields,...(restored?{inputValues:restored.inputValues}:{})};value=null;selection=defaults.selection;agentIds=defaults.agentIds;projectId=restored?restored.projectId:input.projectId||null;dirty=true;error='';
    render();dialog.showModal();const pending=new Promise(resolve=>{resolveOpen=resolve;});void refresh();return pending;
  }};
}
