import {t,ui,onLanguageChange} from './i18n.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const repositoryName=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/.test(value)&&!value.endsWith('.git')&&!value.split('/').some(part=>part==='.'||part==='..');
const safeURL=value=>{try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='github.com'&&!url.username&&!url.password?url.href:null;}catch{return null;}};
const count=value=>Number.isSafeInteger(value)&&value>=0?String(value):t('Non disponibile');

export function repositoryAnalysisChoices(snapshot,scopeId){
  const choices=[],seen=new Set();
  for(const connection of Array.isArray(snapshot?.connections)?snapshot.connections:[]){
    if(connection.tokenConfigured!==true||!Array.isArray(connection.scopeIds)||!connection.scopeIds.includes(scopeId)||typeof connection.id!=='string')continue;
    for(const repository of Array.isArray(connection.repositories)?connection.repositories:[]){
      const key=JSON.stringify([connection.id,repository]);
      if(!repositoryName(repository)||seen.has(key))continue;
      seen.add(key);choices.push({key,connectionId:connection.id,connectionName:String(connection.name||connection.id),repository});
    }
  }
  return choices;
}

export function repositoryAnalysisDraftMatches(draft,{scopeId,conversationId,message}){
  return Boolean(draft&&draft.scopeId===scopeId&&draft.conversationId===conversationId&&(message===undefined||draft.goal===message));
}

export function repositoryAnalysisInput({scopeId,goal,selected},choices,currentScopeId){
  if(!scopeId||scopeId!==currentScopeId)throw Error(t('L’ambito è cambiato. Riapri l’analisi nell’ambito desiderato.'));
  const message=String(goal||'').trim();
  if(!message||message.length>6000)throw Error(t('Descrivi l’obiettivo dell’analisi, entro 6.000 caratteri.'));
  const entries=Array.isArray(selected)?selected:[];
  if(entries.length<1||entries.length>5)throw Error(t('Seleziona da uno a cinque repository.'));
  const seen=new Set();
  const targets=entries.map(entry=>{
    const choice=choices.find(item=>item.key===entry.key);
    if(!choice||seen.has(choice.repository.toLowerCase()))throw Error(t('La selezione contiene repository duplicati o non autorizzati.'));
    seen.add(choice.repository.toLowerCase());
    const ref=String(entry.ref||'').trim();
    if(ref.length>200||/[\u0000-\u0020\u007f\\]/.test(ref)||ref.includes('..')||ref.startsWith('-')||ref.startsWith('/')||ref.endsWith('/'))throw Error(t('Il riferimento del repository non è valido.'));
    return {connectionId:choice.connectionId,repository:choice.repository,...(ref?{ref}:{})};
  });
  return {scopeId,goal:message,targets};
}

export function repositoryAnalysisPreviewHTML(analysis){
  if(!analysis||!Array.isArray(analysis.repositories))return '';
  return ui`<details class="repository-analysis-evidence"><summary>Repository acquisiti per l’analisi</summary><p>Lettura parziale in sola lettura. Nessun test o comando è stato eseguito.</p><p>Le fonti dei repository selezionati sono necessarie a questa analisi. Per cambiarle, torna alla selezione dei repository.</p><p>Le fonti acquisite restano nell’archivio anche annullando o revocando il collegamento GitHub. Sono riutilizzabili secondo i normali permessi delle fonti.</p>${analysis.repositories.map(repository=>{
    const coverage=repository.coverage||{},url=safeURL(repository.url);
    return ui`<article><h4>${escape(repository.repository)}</h4><p>Riferimento: <code>${escape(repository.ref)}</code></p><p>Commit letto: <code>${escape(repository.commit)}</code></p><p>${escape(t('File letti: {read} · idonei: {eligible} · omessi: {omitted} · voci nell’albero: {entries}',{read:count(coverage.readFiles),eligible:count(coverage.eligibleFiles),omitted:count(coverage.omittedFiles),entries:count(coverage.treeEntries)}))}</p>${coverage.treeTruncated?ui`<p class="preview-note">GitHub ha restituito un albero incompleto. La copertura è parziale.</p>`:''}${url?ui`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">Apri repository su GitHub ↗</a>`:''}<details><summary>File e riferimenti letti</summary><ul>${(Array.isArray(repository.files)?repository.files:[]).map(file=>{const link=safeURL(file.url);return ui`<li><code>${escape(file.path)}:${escape(file.startLine)}–${escape(file.endLine)}</code>${file.truncated?ui` <span>Estratto parziale.</span>`:''}${link?ui` <a href="${escape(link)}" target="_blank" rel="noopener noreferrer">Apri file su GitHub ↗</a>`:''}</li>`;}).join('')}</ul></details></article>`;
  }).join('')}</details>`;
}

export async function readRepositoryAnalysis(payload,{fetchImpl=fetch,signal,getScopeId=()=>payload.scopeId,getBusy=()=>false}={}){
  if(getScopeId()!==payload.scopeId)throw Error(t('L’ambito è cambiato. Riapri l’analisi nell’ambito desiderato.'));
  if(getBusy())throw Error(t('Attendi la fine del lavoro prima di avviare l’analisi.'));
  const response=await fetchImpl('/api/repository-analysis/prepare',{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify(payload),signal});
  let result;try{result=await response.json();}catch{throw Error(t('La risposta dello studio non è leggibile. Riprova la preparazione.'));}
  signal?.throwIfAborted();
  if(!response.ok)throw Error(result.error||t('Non è stato possibile preparare l’analisi dei repository.'));
  if(getScopeId()!==payload.scopeId||result.scopeId!==payload.scopeId)throw Error(t('L’ambito è cambiato. Riapri l’analisi nell’ambito desiderato.'));
  if(getBusy())throw Error(t('Attendi la fine del lavoro prima di avviare l’analisi.'));
  if(typeof result.id!=='string'||!result.id||result.goal!==payload.goal||!Array.isArray(result.repositories))throw Error(t('La risposta dello studio non è leggibile. Riprova la preparazione.'));
  return result;
}

export function createRepositoryAnalysisDialog({getScopeId,getBusy=()=>false,toast=()=>{}}){
  const dialog=document.createElement('dialog');dialog.id='repository-analysis-dialog';dialog.className='repository-analysis-dialog';dialog.setAttribute('aria-labelledby','repository-analysis-title');document.body.append(dialog);
  let scopeId=null,scopeName='',goal='',choices=[],selected=new Map(),loading=false,reading=false,error='',generation=0,controller=null,resolveOpen=null;
  const capture=()=>{const input=dialog.querySelector('[data-analysis-goal]');if(input)goal=input.value;for(const input of dialog.querySelectorAll('[data-analysis-ref]'))if(selected.has(input.dataset.analysisRef))selected.set(input.dataset.analysisRef,input.value);};
  function render(){
    const busy=loading||reading;
    dialog.innerHTML=ui`<div class="repository-analysis-heading"><h2 id="repository-analysis-title">Analizza e confronta repository</h2><button type="button" data-analysis-close aria-label="Chiudi finestra">✕</button></div><form id="repository-analysis-form"><div class="repository-analysis-body"><p>Ambito: <strong>${escape(scopeName||scopeId)}</strong></p><p>Seleziona da uno a cinque repository autorizzati. Il team produrrà una lettura tecnica, una valutazione strategica e una sintesi finale.</p><label for="repository-analysis-goal">Obiettivo dell’analisi</label><textarea id="repository-analysis-goal" data-analysis-goal rows="4" maxlength="6000" required${busy?' disabled':''}>${escape(goal)}</textarea><p>La prima fase legge un campione di file da GitHub, escludendo percorsi sensibili. Non esegue codice né test. Il codice sarà inviato ai servizi AI solo dopo la revisione e conferma dell’anteprima.</p>${loading?ui`<p role="status">Caricamento dei repository autorizzati…</p>`:choices.length?ui`<fieldset${reading?' disabled':''}><legend>Repository da leggere</legend>${choices.map((choice,index)=>ui`<article class="repository-analysis-choice"><label><input type="checkbox" data-analysis-target="${index}"${selected.has(choice.key)?' checked':''}><span><strong>${escape(choice.repository)}</strong><small>${escape(choice.connectionName)}</small></span></label>${selected.has(choice.key)?ui`<label class="repository-analysis-ref">Ramo o riferimento facoltativo<input type="text" data-analysis-ref="${escape(choice.key)}" value="${escape(selected.get(choice.key))}" maxlength="200" placeholder="Ramo predefinito" autocomplete="off"></label>`:''}</article>`).join('')}</fieldset>`:ui`<p class="repository-analysis-notice">Nessun repository autorizzato in questo ambito. Collega GitHub e autorizza almeno un repository nel pannello GitHub.</p>`}${reading?ui`<p role="status">Lettura dei repository e preparazione delle fonti…</p>`:''}${error?ui`<p class="repository-analysis-error" role="alert">${escape(error)}</p>`:''}<p class="repository-analysis-notice">Le fonti già acquisite restano salvate nell’ambito, anche annullando. Questa fase non avvia risposte AI.</p></div><div class="repository-analysis-footer"><button type="button" data-analysis-close>Annulla</button><button type="button" data-analysis-reload${busy?' disabled':''}>Aggiorna repository</button><button type="submit" class="is-primary"${busy||!choices.length?' disabled':''}>Leggi repository e prepara anteprima</button></div></form>`;
  }
  function close(result=null){generation++;controller?.abort();controller=null;loading=false;reading=false;const resolve=resolveOpen;resolveOpen=null;if(dialog.open)dialog.close();resolve?.(result);}
  async function load(){
    if(loading||reading)return;capture();const own=++generation;controller=new AbortController();loading=true;error='';render();
    try{const response=await fetch('/api/github',{cache:'no-store',signal:controller.signal}),value=await response.json();if(!response.ok)throw Error(value.error||t('Non è stato possibile leggere i collegamenti GitHub.'));if(own!==generation)return;if(scopeId!==getScopeId())throw Error(t('L’ambito è cambiato. Riapri l’analisi nell’ambito desiderato.'));choices=repositoryAnalysisChoices(value,scopeId);selected=new Map([...selected].filter(([key])=>choices.some(choice=>choice.key===key)));}
    catch(cause){if(own===generation&&cause.name!=='AbortError')error=cause.message;}
    finally{if(own===generation){
      const active=document.activeElement,keepClose=active?.matches('[data-analysis-close]'),keepReload=active?.matches('[data-analysis-reload]');
      loading=false;controller=null;render();
      if(keepClose)dialog.querySelector('[data-analysis-close]')?.focus({preventScroll:true});
      else if(keepReload)dialog.querySelector('[data-analysis-reload]')?.focus({preventScroll:true});
      else if(document.activeElement===document.body||document.activeElement===dialog)dialog.querySelector('[data-analysis-goal]')?.focus({preventScroll:true});
    }}
  }
  async function prepare(event){
    event.preventDefault();if(loading||reading||getBusy())return;capture();let payload;
    try{payload=repositoryAnalysisInput({scopeId,goal,selected:[...selected].map(([key,ref])=>({key,ref}))},choices,getScopeId());}catch(cause){error=cause.message;render();return;}
    const own=++generation;controller=new AbortController();reading=true;error='';render();
    try{
      const result=await readRepositoryAnalysis(payload,{signal:controller.signal,getScopeId,getBusy});
      if(own!==generation)return;
      close(result);
    }catch(cause){if(own===generation&&cause.name!=='AbortError')error=cause.message;}
    finally{if(own===generation){reading=false;controller=null;render();}}
  }
  dialog.addEventListener('submit',event=>void prepare(event));
  dialog.addEventListener('click',event=>{if(event.target.closest('[data-analysis-close]'))close();else if(event.target.closest('[data-analysis-reload]'))void load();});
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('input',capture);
  dialog.addEventListener('change',event=>{const input=event.target.closest('[data-analysis-target]');if(!input||loading||reading)return;capture();const index=Number(input.dataset.analysisTarget),choice=choices[index];if(!choice)return;if(input.checked)selected.set(choice.key,'');else selected.delete(choice.key);error=selected.size>5?t('Seleziona da uno a cinque repository.'):'';render();dialog.querySelector(`[data-analysis-target="${index}"]`)?.focus({preventScroll:true});});
  const unsubscribe=onLanguageChange(()=>{if(dialog.open){capture();render();}});
  const expire=()=>close();window.addEventListener('studio-session-expired',expire);
  return {open(input){if(getBusy()){toast(t('Attendi la fine del lavoro prima di avviare l’analisi.'));return Promise.resolve(null);}if(resolveOpen)close();if(input.scopeId!==scopeId){choices=[];selected=new Map();}scopeId=input.scopeId;scopeName=input.scopeName||scopeId;goal=input.goal||'';error='';render();dialog.showModal();const pending=new Promise(resolve=>{resolveOpen=resolve;});void load();return pending;},cancel:close,dispose(){close();unsubscribe();window.removeEventListener('studio-session-expired',expire);dialog.remove();}};
}
