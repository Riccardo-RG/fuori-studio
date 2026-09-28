import { t, ui, locale, bindText, onLanguageChange } from './i18n.js';
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const statuses = {queued:'Da avviare',running:'In lavorazione',review:'Da approvare',completed:'Approvato',failed:'Interrotto',paused:'In pausa'};
const stages = {queued:'In attesa del tuo avvio',preparing:'Preparazione della copia di lavoro',editing:'Modifiche al codice',checking:'Controlli in esecuzione',reviewing:'Revisione del codice',review:'Modifiche da controllare',completed:'Patch approvata',failed:'Il lavoro richiede attenzione',paused:'Lavoro fermato'};
const checkNames = {pending:'In attesa',running:'In corso',passed:'Superato',failed:'Fallito',error:'Errore',skipped:'Non eseguito'};
const date = value => {const d=new Date(value);return value&&Number.isFinite(d.getTime())?new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(d):'—';};
const badge = run => ui`<span class="ops-state state-${html(run.status)}">${html(t(statuses[run.status]||run.status))}</span>`;
const help = (label,text) => ui`<details class="repo-help"><summary aria-label="Aiuto: ${html(label)}">?</summary><p>${html(text)}</p></details>`;
let fieldSequence=0;
const field = (label,name,value='',area=false) => ui`<div class="ops-field"><label for="repo-field-${name}-${fieldSequence+1}">${html(label)}</label>${area?ui`<textarea id="repo-field-${name}-${++fieldSequence}" name="${name}" rows="5" maxlength="16000" required>${html(value)}</textarea>`:ui`<input id="repo-field-${name}-${++fieldSequence}" name="${name}" value="${html(value)}" maxlength="1000" required autocomplete="off">`}</div>`;

export function createRepositoriesPanel({onPreview=async()=>null,host,toast=()=>{},onActivity=()=>{},onRefreshMemory=async()=>{},onNewProject=()=>{},onOutcome=()=>{}}={}) {
  let snapshot={repositories:[],runs:[],workers:[],available:false,localOnly:true},context={projects:[],scopes:[],scopeId:'business',filter:'current',projectId:null};
  let loaded=false,loading=false,saving=false,busy=false,visible=false,error='',pollTimer=null,polling=false,disposed=false,loadVersion=0,view=null,patchLoading=false;
  let languageView=null;
  const patches=new Map();
  const dialog=document.createElement('dialog');dialog.id='repositories-dialog';dialog.className='ops-dialog repo-dialog';dialog.setAttribute('aria-labelledby','repo-dialog-title');document.body.append(dialog);
  const repository=id=>snapshot.repositories.find(item=>item.id===id),runFor=id=>snapshot.runs.find(item=>item.id===id);
  const project=id=>context.projects.find(item=>item.id===id),scopeName=id=>context.scopes.find(item=>item.id===id)?.name||id;
  const allowed=item=>context.filter==='all'||item.scopeId===context.scopeId;
  const locked=()=>loading||saving||busy||!snapshot.available;
  const localAvailable=()=>snapshot.localAvailable??(snapshot.available&&snapshot.localOnly!==false);
  const workers=()=>Array.isArray(snapshot.workers)?snapshot.workers:[];
  const workerFor=id=>workers().find(item=>item.id===id);
  const targetId=item=>item?.configuration?.executionTarget||item?.executionTarget||repository(item?.repositoryId)?.executionTarget||'local';
  const targetName=item=>targetId(item)==='local'?t('Questo computer'):item?.workerName||workerFor(targetId(item))?.name||repository(item?.repositoryId)?.workerName||t('Dispositivo collegato');
  const targetOnline=item=>targetId(item)==='local'?localAvailable():workerFor(targetId(item))?.online===true;
  const scopedWorkers=scopeId=>workers().filter(item=>(item.scopeIds||[]).includes(scopeId));
  const scopedAliases=(worker,scopeId)=>(worker?.repositories||[]).filter(item=>(item.scopeIds||[]).includes(scopeId));
  const targetBadge=item=>ui`<span class="repo-target${targetOnline(item)?' is-online':' is-offline'}"><i aria-hidden="true"></i>${html(targetName(item))}${targetId(item)!=='local'?` · ${targetOnline(item)?'online':'offline'}`:''}</span>`;
  function onboarding(){return ui`<div class="repo-worker-setup"><div class="repo-title-row"><h4>Collega un computer per lavorare sul codice.</h4>${help(t('Repository autorizzati sul dispositivo'),t('In Account → Dispositivi crea un codice con il permesso Modifiche ai repository e gli ambiti necessari. Sul computer collega il worker e registra ogni repository dalla CLI, scegliendo un alias e i controlli consentiti. Quando il worker è online, qui appariranno solo i repository autorizzati per il progetto.'))}</div><ol><li>Autorizza il dispositivo e l’ambito da Account → Dispositivi.</li><li>Collega il worker dalla CLI e registra il repository sul computer.</li><li>Avvia il worker, poi aggiorna questa scheda.</li></ol><div class="repo-patch-actions"><button type="button" class="ops-button" data-repo-action="devices">Apri Dispositivi ↗</button><button type="button" class="ops-button" data-repo-action="refresh">Aggiorna dispositivi</button></div><p class="ops-hint">Percorsi e controlli si autorizzano sul computer. Lo studio online non riceve accesso libero ai suoi file.</p></div>`;}

  const passed=run=>run.status==='review'&&run.decision?.status!=='changes_requested'&&Boolean(run.patchHash)&&run.checksValid===true&&run.files?.length>0&&run.checks?.length>0&&run.checks.every(check=>check.status==='passed'&&check.exitCode===0);
  function accept(value) {
    if(!value||!Array.isArray(value.repositories)||!Array.isArray(value.runs))throw Error(t('I dati dei repository non sono disponibili.'));
    snapshot=value;loaded=true;error='';onActivity(snapshot);render();schedule();
  }
  async function request(body) {
    const response=await fetch('/api/repositories',body?{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify(body)}:{cache:'no-store'});
    let value;try{value=await response.json();}catch{throw Error(t('Il server non ha risposto correttamente.'));}
    if(disposed)throw Error(t('Sessione scaduta.'));
    if(!response.ok){const e=Error(value.error||t('Operazione non riuscita.'));e.status=response.status;throw e;}return value;
  }
  async function load({quiet=false}={}) {
    if(disposed)return;
    const version=++loadVersion;
    if(!quiet){loading=true;error='';render();}
    try{const value=await request();if(version!==loadVersion||disposed)return;loading=false;accept(value);if(view?.kind==='run'&&dialog.open)showRun(view.id);}
    catch(e){if(version!==loadVersion||disposed)return;loading=false;error=e.message;render();}
    finally{schedule();}
  }
  function schedule(){clearTimeout(pollTimer);if(!disposed&&document.visibilityState==='visible'&&snapshot.runs.some(run=>run.status==='running'))pollTimer=setTimeout(poll,3000);}
  async function poll(){if(polling||loading||saving||document.hidden){schedule();return;}polling=true;try{await load({quiet:true});}finally{polling=false;schedule();}}
  function visibility(){if(!document.hidden&&snapshot.runs.some(run=>run.status==='running'))void poll();else schedule();}
  document.addEventListener('visibilitychange',visibility);
  function expire(){disposed=true;clearTimeout(pollTimer);loadVersion++;if(dialog.open)dialog.close();}
  window.addEventListener('studio-session-expired',expire);
  async function mutation(action,payload) {
    const value=await request({action,payload});
    if(Array.isArray(value.runs))accept(value);else await load({quiet:true});
    if(action==='proposeMemory')await onRefreshMemory();return value;
  }
  function syncLocks(){host.querySelectorAll('[data-repo-mutation]').forEach(el=>el.disabled=locked()||el.dataset.repoUnavailable==='true');dialog.querySelectorAll('[data-repo-mutation],button[type="submit"]').forEach(el=>el.disabled=locked()||el.dataset.repoUnavailable==='true');dialog.querySelectorAll('[data-repo-action="approve"]').forEach(el=>el.disabled=locked()||!passed(runFor(el.dataset.id)||{}));}
  function checkCommand(check){return [check.program,...(check.args||[]).map(arg=>/^[\w./:-]+$/.test(arg)?arg:JSON.stringify(arg))].join(' ');}
  function card(repo) {
    const runs=snapshot.runs.filter(run=>run.repositoryId===repo.id).sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
    const remote=targetId(repo)!=='local';
    return ui`<article class="repo-card"><div class="repo-card-heading"><div><span class="repo-kicker">${html(project(repo.projectId)?.title||t('Progetto'))} · ${html(scopeName(repo.scopeId))}</span><h3>${html(repo.name||repo.repositoryAlias||repo.path?.split('/').at(-1)||t('Repository'))}</h3></div>${targetBadge(repo)}</div><code class="repo-path">${remote?`Alias: ${html(repo.repositoryAlias||repo.path)}`:html(repo.path)}</code><div class="repo-facts"><span>${html(repo.branch||t('HEAD separato'))}</span><code>${html(repo.head?.slice(0,10)||'HEAD')}</code><span>${repo.dirty?t('Modifiche locali escluse'):t('Copia sorgente pulita')}</span></div><div class="repo-card-bottom"><span>${repo.checks?.length||0} controlli ${remote?t('autorizzati sul dispositivo'):t('definiti')} · ${t(runs.length===1?'{count} incarico':'{count} incarichi',{count:runs.length})}</span><div class="repo-card-actions">${Number.isInteger(repo.version)?ui`<button type="button" class="ops-button" data-repo-action="refresh-repository" data-id="${html(repo.id)}" data-repo-mutation data-repo-unavailable="${!targetOnline(repo)}" title="Aggiorna il commit di base e i controlli per i prossimi incarichi">Aggiorna collegamento</button>`:''}<button type="button" class="ops-button is-primary" data-repo-action="create" data-id="${html(repo.id)}" data-repo-mutation data-repo-unavailable="${!targetOnline(repo)}">＋ Incarico sul codice</button></div></div>${runs.length?ui`<div class="repo-runs">${runs.map(run=>ui`<button type="button" class="repo-run" data-repo-action="run" data-id="${html(run.id)}"><span><strong>${html(run.title)}</strong><small>${html(t(stages[run.stage]||run.stage||statuses[run.status]))} · ${html(date(run.updatedAt))}</small></span>${badge(run)}<span aria-hidden="true">↗</span></button>`).join('')}</div>`:''}</article>`;
  }
  function render() {
    if(!visible)return;
    const repos=snapshot.repositories.filter(allowed),projects=context.projects.filter(allowed),hasTargets=localAvailable()||projects.some(item=>scopedWorkers(item.scopeId).some(worker=>scopedAliases(worker,item.scopeId).length));
    host.innerHTML=ui`<div class="repo-intro"><div><div class="repo-title-row"><h3>Dal progetto al codice.</h3>${help(t('Come lavora sul repository'),t('Si parte dall’ultimo commit HEAD, in una copia isolata sul computer scelto. I file locali non salvati in un commit sono esclusi. Codex e i controlli eseguono codice su quel computer, con il suo accesso AI. Usa repository e comandi di cui ti fidi. Approvare una patch non modifica, integra o pubblica il repository originale.'))}</div><p>Scegli il computer, prepara una modifica e controlla la patch prima di approvarla.</p></div><div class="repo-card-actions"><button type="button" class="ops-button" data-repo-action="refresh" aria-label="Aggiorna repository e dispositivi">Aggiorna</button><button type="button" class="ops-button is-primary" data-repo-action="register" data-repo-mutation>Collega repository</button></div></div>${loading?ui('<p class="repo-notice" role="status">Caricamento dei repository…</p>'):error?ui`<p class="ops-error" role="alert">${html(error)} <button type="button" class="ops-text-button" data-repo-action="refresh">Riprova</button></p>`:!snapshot.available?ui`<div class="repo-empty"><span aria-hidden="true">⌘</span><h3>Prepara l’esecuzione del codice.</h3><p>${snapshot.reason?html(snapshot.reason):t('Per lavorare sul codice serve un computer con Git e Codex disponibili.')}</p></div>`:repos.length?ui`<div class="repo-grid">${repos.map(card).join('')}</div>`:!projects.length?ui(`<div class="repo-empty"><span aria-hidden="true">⌘</span><h3>Prima, scegli un progetto.</h3><p>Crea un progetto dello studio oppure mostra tutti gli ambiti per collegarne uno esistente.</p><button type="button" class="ops-button" data-repo-action="new-project">Crea un progetto</button></div>`):!hasTargets?onboarding():ui(`<div class="repo-empty"><span aria-hidden="true">⌘</span><h3>Collega il codice al suo progetto.</h3><p>Seleziona un progetto e il computer su cui lavorare. Per un dispositivo collegato scegli un repository già autorizzato; su questo computer puoi indicare il percorso Git e i controlli.</p><ol><li>Collega un repository al progetto</li><li>Descrivi la modifica e avvia Codex</li><li>Controlla test, diff e revisione</li></ol><button type="button" class="ops-button" data-repo-action="register">Collega il primo repository</button></div>`)}<p class="repo-footnote">Codex sul computer scelto · Avvio a consumo esplicito · Approvazione senza merge o push</p>`;
    syncLocks();
  }
  function shell(title,body,footer) {
    dialog.innerHTML=ui`<div class="ops-dialog-heading"><div><div class="eyebrow">IL CODICE DEL PROGETTO</div><h2 id="repo-dialog-title">${html(title)}</h2></div><button type="button" class="ops-icon" data-repo-close aria-label="Chiudi finestra">✕</button></div>${body}<div class="ops-dialog-footer">${footer||ui('<button type="button" class="ops-button" data-repo-close>Chiudi</button>')}</div>`;
    if(!dialog.open)dialog.showModal();syncLocks();
  }
  function form(title,body,label,submit) {
    view={kind:'form'};
    shell(title,ui`<form id="repo-form"><div class="ops-form-body">${body}</div><p class="ops-form-error" role="alert" hidden></p></form>`,ui`<button type="button" class="ops-button" data-repo-close>Annulla</button><button type="submit" form="repo-form" class="ops-button is-primary" data-repo-mutation>${html(label)}</button>`);
    dialog.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault();if(locked())return;const el=event.currentTarget;if(!el.reportValidity())return;const data=new FormData(el),box=dialog.querySelector('.ops-form-error');box.hidden=true;saving=true;syncLocks();
      try{const after=await submit(data,el);dialog.close();saving=false;syncLocks();if(after)after();}
      catch(e){box.textContent=e.status===409?ui`${e.message} Chiudi il modulo e aggiorna l’incarico prima di riprovare.`:e.message;box.hidden=false;box.scrollIntoView({block:'nearest'});}
      finally{saving=false;syncLocks();schedule();}
    });
  }
  function checkFields(check={label:'',program:'',args:[]}) {return ui`<fieldset class="repo-check-fields"><legend>Controllo</legend>${field(t('Nome del controllo'),'checkLabel',check.label)}<div class="repo-check-command">${field(t('Programma'),'checkProgram',check.program)}${field(t('Argomenti · array JSON'),'checkArgs',JSON.stringify(check.args))}</div><button type="button" class="ops-text-button is-danger" data-repo-action="remove-check">Rimuovi controllo</button></fieldset>`;}
  function register() {
    languageView=()=>register();
    if(locked())return;const projects=context.projects.filter(allowed);if(!projects.length){toast(t('Crea prima un progetto o mostra tutti gli ambiti.'));return;}
    const chosen=projects.find(item=>item.id===context.projectId)||projects[0];
    form(t('Collega il repository'),ui`<p class="ops-form-intro">Scegli dove si trova il codice. Il collegamento prepara il progetto e non avvia Codex.</p><div class="ops-field"><label for="repo-project">Progetto dello studio</label><select id="repo-project" name="projectId" required>${projects.map(item=>ui`<option value="${html(item.id)}"${chosen.id===item.id?' selected':''}>${html(item.title)} · ${html(scopeName(item.scopeId))}</option>`).join('')}</select></div><div class="ops-field"><label for="repo-execution-target">Computer di esecuzione</label><select id="repo-execution-target" name="executionTarget" required></select></div><div id="repo-target-status" aria-live="polite"></div><fieldset id="repo-local-fields" class="repo-location-fields">${field(t('Percorso della repository Git'),'path')}${snapshot.suggestedPath?ui('<button type="button" class="ops-text-button" data-repo-action="use-suggested">Usa il percorso di Fuori Studio</button>'):''}<div class="repo-title-row"><h3>Controlli da eseguire</h3>${help(t('Comandi reali'),t('Ogni controllo esegue un programma con argomenti separati, senza shell. Gli argomenti sono un array JSON: per npm test scrivi ["test"]. Non usare pipe, glob o variabili di shell. Sono consentiti solo programmi e comandi di verifica supportati dal server; installazioni e comandi di shell non sono ammessi.'))}</div><p class="ops-hint">Il percorso deve esistere su questo computer. I controlli eseguono codice nella copia di lavoro; serve almeno un controllo.</p><div id="repo-check-fields">${checkFields({label:t('Test'),program:'npm',args:['test']})}${checkFields({label:t('Verifica del progetto'),program:'npm',args:['run','check']})}</div><button type="button" class="ops-button" data-repo-action="add-check">＋ Aggiungi controllo</button></fieldset><fieldset id="repo-remote-fields" class="repo-location-fields" hidden disabled><div class="ops-field"><label for="repo-alias">Repository autorizzato</label><select id="repo-alias" name="repositoryAlias" required></select></div><div id="repo-alias-details"></div></fieldset><div id="repo-registration-setup" hidden>${onboarding()}</div><p class="repo-notice">Viene usato il codice salvato nell’ultimo commit HEAD. Le modifiche locali non committate restano escluse. L’approvazione conserva una patch: il merge e il push rimangono una tua scelta separata.</p>`,t('Collega al progetto'),async(data,el)=>{
      const selected=project(data.get('projectId'));if(!selected)throw Error(t('Seleziona un progetto esistente.'));
      const target=String(data.get('executionTarget')||'');
      if(target!=='local'){
        const worker=scopedWorkers(selected.scopeId).find(item=>item.id===target),alias=scopedAliases(worker,selected.scopeId).find(item=>item.alias===data.get('repositoryAlias'));
        if(!worker||!alias)throw Error(t('Seleziona un repository autorizzato per questo progetto.'));
        if(!worker.online)throw Error(t('Avvia il worker sul computer e aggiorna i dispositivi prima di collegare il repository.'));
        await mutation('register',{projectId:selected.id,scopeId:selected.scopeId,executionTarget:worker.id,repositoryAlias:alias.alias});
      }else{
        if(!localAvailable())throw Error(t('L’esecuzione su questo computer non è disponibile.'));
        const checks=[...el.querySelectorAll('.repo-check-fields')].map(row=>{let args;try{args=JSON.parse(row.querySelector('[name="checkArgs"]').value);}catch{throw Error(t('Gli argomenti devono essere un array JSON, per esempio ["run", "check"].'));}if(!Array.isArray(args)||args.some(value=>typeof value!=='string'))throw Error(t('Ogni argomento deve essere una stringa nell’array JSON.'));return {label:row.querySelector('[name="checkLabel"]').value.trim(),program:row.querySelector('[name="checkProgram"]').value.trim(),args};});
        if(!checks.length)throw Error(t('Aggiungi almeno un controllo.'));await mutation('register',{projectId:selected.id,scopeId:selected.scopeId,path:String(data.get('path')).trim(),checks});
      }
      toast(t('Repository collegato. Ora puoi preparare un incarico.'));
    });
    dialog.querySelector('#repo-project').addEventListener('change',()=>updateRegistration(true));
    dialog.querySelector('#repo-execution-target').addEventListener('change',()=>updateRegistration(false));
    dialog.querySelector('#repo-alias').addEventListener('change',()=>updateRegistration(false));
    updateRegistration(true);
  }
  function updateRegistration(rebuildTargets=false){
    const selected=project(dialog.querySelector('#repo-project')?.value);if(!selected)return;
    const targetSelect=dialog.querySelector('#repo-execution-target'),aliasSelect=dialog.querySelector('#repo-alias');
    if(rebuildTargets){
      const previous=targetSelect.value,options=[...(localAvailable()?[{id:'local',name:t('Questo computer')}]:[]),...scopedWorkers(selected.scopeId).map(item=>({id:item.id,name:`${item.name} · ${item.online?'online':'offline'}`}))];
      targetSelect.innerHTML=options.length?options.map(item=>ui`<option value="${html(item.id)}">${html(item.name)}</option>`).join(''):ui('<option value="">Nessun computer autorizzato</option>');
      if(options.some(item=>item.id===previous))targetSelect.value=previous;
    }
    const local=targetSelect.value==='local',worker=workerFor(targetSelect.value),aliases=scopedAliases(worker,selected.scopeId),previousAlias=aliasSelect.value;
    aliasSelect.innerHTML=aliases.length?aliases.map(item=>ui`<option value="${html(item.alias)}">${html(item.name||item.alias)} · ${html(item.alias)}</option>`).join(''):ui('<option value="">Nessun repository autorizzato in questo ambito</option>');
    if(aliases.some(item=>item.alias===previousAlias))aliasSelect.value=previousAlias;
    const alias=aliases.find(item=>item.alias===aliasSelect.value),ready=local?localAvailable():Boolean(worker?.online&&alias);
    for(const [id,shown]of [['repo-local-fields',local],['repo-remote-fields',!local&&Boolean(worker)]]){const fields=dialog.querySelector('#'+id);fields.hidden=!shown;fields.disabled=!shown;}
    dialog.querySelector('#repo-target-status').innerHTML=local?ui('<p class="ops-hint">Git e Codex lavoreranno su questo computer.</p>'):worker?ui`<p class="repo-target-note${worker.online?'':' is-offline'}">${worker.online?t('Il worker è online. Codex userà l’accesso configurato su questo dispositivo.'):t('Il worker è offline. Avvialo sul computer, poi aggiorna i dispositivi.')}</p>`:'';
    dialog.querySelector('#repo-registration-setup').hidden=local||Boolean(worker&&aliases.length&&worker.online);
    dialog.querySelector('#repo-alias-details').innerHTML=alias?ui`<div class="repo-authorized-details"><div class="repo-title-row"><h3>Controlli autorizzati sul dispositivo</h3>${help(t('Configurazione del worker'),t('Alias, percorso e comandi si configurano dalla CLI sul computer che esegue il lavoro. Qui puoi consultarli; per cambiarli aggiorna il worker e poi il collegamento. Gli incarichi già preparati conservano la propria configurazione.'))}</div><div class="repo-facts"><span>${html(alias.branch||t('HEAD separato'))}</span><code>${html(alias.head?.slice(0,12)||'HEAD')}</code><span>${alias.dirty?t('Modifiche locali escluse'):t('Copia sorgente pulita')}</span></div><div class="repo-command-list">${(alias.checks||[]).map(check=>ui`<div><strong>${html(check.label)}</strong><code>${html(checkCommand(check))}</code></div>`).join('')||ui('<p class="ops-hint">Nessun controllo disponibile.</p>')}</div><p class="ops-hint">Ambito autorizzato: ${html(scopeName(selected.scopeId))}. I comandi non sono modificabili dal browser.</p></div>`:'';
    dialog.querySelector('button[type="submit"]').dataset.repoUnavailable=String(!ready);syncLocks();
  }
  function create(repo) {
    languageView=()=>create(repo);
    if(!targetOnline(repo)){toast(t('Collega il computer per preparare un incarico sul codice.'));return;}
    form(t('Un incarico sul codice'),ui`<p class="ops-form-intro"><strong>${html(repo.name)}</strong> · ${html(project(repo.projectId)?.title)} · ${html(targetName(repo))}. Verrà preparato un incarico da avviare separatamente.</p>${field(t('Titolo della modifica'),'title')}${field(t('Obiettivo, vincoli e risultato atteso'),'brief','',true)}<p class="ops-hint">Descrivi quali comportamenti devono cambiare e come verificarli. Non inserire credenziali nel brief.</p>`,t('Prepara incarico'),async data=>{const before=new Set(snapshot.runs.map(item=>item.id));await mutation('create',{repositoryId:repo.id,title:data.get('title').trim(),brief:data.get('brief').trim()});const saved=snapshot.runs.find(item=>!before.has(item.id));return saved?()=>showRun(saved.id):null;});
  }
  function start(run) {
    languageView=()=>start(run);
    if(!targetOnline(run)){toast(t('Il computer di esecuzione non è disponibile. Aggiorna i dispositivi e riprova.'));return;}
    form(t('Avvia il lavoro sul codice'),ui`<p class="ops-form-intro"><strong>${html(run.title)}</strong></p><p>Codex modificherà una copia isolata del commit <code>${html(run.baseCommit?.slice(0,12)||'HEAD')}</code> ed eseguirà i controlli configurati. Lavorerà su <strong>${html(targetName(run))}</strong> con l’accesso Codex di quel computer e può generare consumo sul relativo account.</p><div class="repo-command-list">${(run.checks||repository(run.repositoryId)?.checks||[]).map(check=>ui`<div><strong>${html(check.label)}</strong><code>${html(checkCommand(check))}</code></div>`).join('')}</div><p class="repo-notice">Il lavoro esegue codice sul computer scelto. Il repository originale e le sue modifiche non committate non vengono integrati nella copia. Al termine controllerai diff, risultati e revisione.</p>`,t('Avvia Codex e controlli'),async()=>{dialog.close();const receipt=await onPreview({kind:'repository',id:run.id,expectedVersion:run.version});if(receipt)await mutation('start',{id:run.id,expectedVersion:run.version,...receipt});return()=>showRun(run.id);});
  }
  function revise(run) {
    languageView=()=>revise(run);
    form(t('Prepara una nuova revisione'),ui`<p class="ops-form-intro">La patch e i risultati di <strong>${html(run.title)}</strong> restano conservati. La nuova revisione partirà dallo stesso commit di base e includerà il tuo feedback nel brief.</p>${field(t('Cosa deve cambiare o essere ripreso'),'feedback','',true)}<p class="ops-hint">Verrà creato un nuovo incarico da avviare esplicitamente. Il lavoro precedente non riprende da solo.</p>`,t('Prepara revisione'),async data=>{const before=new Set(snapshot.runs.map(item=>item.id));await mutation('requestChanges',{id:run.id,expectedVersion:run.version,feedback:data.get('feedback').trim()});const next=snapshot.runs.find(item=>!before.has(item.id));return()=>showRun(next?.id||run.id);});
  }
  function approve(run) {
    languageView=()=>approve(run);
    if(!passed(run))return;
    form(t('Approva questa patch'),ui`<p class="ops-form-intro"><strong>${html(run.title)}</strong> · versione ${run.version}</p><p>I ${run.checks.length} controlli configurati sono passati. Conferma dopo aver letto la patch e la revisione.</p><div class="repo-review-facts"><span>${run.stats?.files||run.files.length} file modificati</span><span class="repo-add">+${run.stats?.additions||0}</span><span class="repo-delete">−${run.stats?.deletions||0}</span></div><p class="repo-notice">L’approvazione conserva il risultato come accettato. Non esegue merge, commit nel repository originale o push.</p><code class="repo-hash">Patch ${html(run.patchHash)}</code>`,t('Conferma approvazione'),async()=>{await mutation('approve',{id:run.id,expectedVersion:run.version});return()=>showRun(run.id);});
  }
  function proposeMemory(run) {
    languageView=()=>proposeMemory(run);
    form(t('Un metodo da ricordare'),ui`<p class="ops-form-intro">Crea una proposta nell’ambito <strong>${html(scopeName(run.scopeId))}</strong>, collegata a questa patch approvata. Rivedila in Memoria prima di usarla come contesto.</p>${field(t('Titolo della memoria'),'title',run.title)}<div class="ops-field"><label for="repo-memory-type">Tipo</label><select id="repo-memory-type" name="type"><option value="pattern">Metodo riutilizzabile</option><option value="decision">Decisione</option></select></div>${field(t('Regola o decisione da conservare'),'content','',true)}`,t('Crea proposta di memoria'),async data=>{await mutation('proposeMemory',{id:run.id,expectedVersion:run.version,title:data.get('title').trim(),content:data.get('content').trim(),type:data.get('type')});toast(t('Proposta creata. Rivedila nella memoria di questo ambito.'));return()=>showRun(run.id);});
  }
  function patchMarkup(patch){return patch.split('\n').map(line=>ui`<span class="${line.startsWith('+++')||line.startsWith('---')?'repo-diff-file':line.startsWith('+')?'repo-diff-add':line.startsWith('-')?'repo-diff-remove':line.startsWith('@@')?'repo-diff-hunk':''}">${html(line)||' '}</span>`).join('');}
  function showRun(id) {
    languageView=()=>showRun(id);
    const run=runFor(id);if(!run)return;const repo=repository(run.repositoryId),scroll=dialog.scrollTop,opened=[...dialog.querySelectorAll('details[open][data-detail]')].map(el=>el.dataset.detail);view={kind:'run',id};
    const patch=patches.get(`${id}:${run.patchHash}`);
    const checks=(run.checks||[]).map(check=>ui`<details class="repo-check-result" data-detail="check-${html(check.label)}"><summary><span><strong>${html(check.label)}</strong><code>${html(checkCommand(check))}</code></span><span class="repo-check-state is-${html(check.status)}">${html(t(checkNames[check.status]||check.status))}</span></summary><div><p class="ops-hint">${check.exitCode===null||check.exitCode===undefined?t('Nessun codice di uscita'):ui`Codice di uscita: ${Number(check.exitCode)}`} ${Number.isFinite(check.durationMs)?`· ${(check.durationMs/1000).toFixed(1)} s`:''}${check.truncated?t(' · Log troncato'):''}</p><pre class="repo-log">${html(check.output||t('Nessun output disponibile.'))}</pre></div></details>`).join('');
    const review=typeof run.review==='string'?run.review:run.review?.text;
    shell(run.title,ui`<div class="ops-task-body repo-run-body"><div class="ops-task-meta">${badge(run)}<span>${html(t(stages[run.stage]||run.stage||''))}</span><span>v${run.version} · ${html(date(run.updatedAt))}</span></div><p class="repo-source">${html(repo?.name||t('Repository'))} · ${html(scopeName(run.scopeId))} · base <code>${html(run.baseCommit?.slice(0,12)||'HEAD')}</code></p><div class="repo-run-target">${targetBadge(run)}${!targetOnline(run)&&run.status==='queued'?ui('<p class="ops-hint">Ricollega questo computer e aggiorna lo stato per avviare l’incarico.</p>'):''}</div>${run.error?ui`<p class="ops-error" role="alert">${html(run.error)}</p>`:''}${run.dependencies?.reason?ui`<p class="repo-notice">${html(run.dependencies.reason)}</p>`:''}<details class="ops-disclosure" data-detail="brief"><summary>Obiettivo e vincoli</summary><p class="ops-prewrap">${html(run.brief)}</p>${run.feedback?ui`<h3 class="repo-feedback-title">Feedback della revisione</h3><p class="ops-prewrap">${html(run.feedback)}</p>`:''}</details>${run.summary?ui`<section class="repo-summary"><h3>Risultato del lavoro</h3><p>${html(run.summary)}</p></section>`:''}<section><div class="repo-title-row"><h3>Controlli</h3>${help(t('Che cosa confermano i controlli'),t('L’approvazione è disponibile solo per una patch non vuota con tutti i controlli configurati superati. Leggi comunque il diff e la revisione: un test passato non garantisce ogni comportamento.'))}</div><div class="repo-check-results">${checks||ui('<p class="ops-hint">Nessun controllo registrato.</p>')}</div></section>${run.files?.length?ui`<section><div class="repo-title-row"><h3>Modifiche proposte</h3><div class="repo-review-facts"><span>${run.stats?.files||run.files.length} file</span><span class="repo-add">+${run.stats?.additions||0}</span><span class="repo-delete">−${run.stats?.deletions||0}</span></div></div><div class="repo-files">${run.files.map(file=>ui`<div><code>${html(file.path)}</code><span>${html(file.status)} <b class="repo-add">+${Number(file.additions)||0}</b> <b class="repo-delete">−${Number(file.deletions)||0}</b></span></div>`).join('')}</div>${run.patchHash?ui`<div class="repo-patch-actions"><button type="button" class="ops-button" data-repo-action="patch" data-id="${html(id)}"${patchLoading?' disabled':''}>${patchLoading?t('Caricamento…'):patch?t('Nascondi diff'):t('Leggi il diff')}</button><button type="button" class="ops-button" data-repo-action="download" data-id="${html(id)}">Scarica patch</button></div>${patch?ui`<pre class="repo-diff" tabindex="0" aria-label="Diff della patch">${patchMarkup(patch)}</pre>`:''}`:''}</section>`:''}${run.review?ui`<section class="repo-review"><div class="repo-title-row"><h3>Revisione del codice</h3><span class="repo-local">${run.review.status==='unavailable'?t('Non disponibile'):run.review.status==='pending'?t('In attesa'):t('Codex')}</span></div><p>${html(review||run.review.error||t('La revisione non contiene un risultato disponibile.'))}</p><small>Una revisione AI aiuta il controllo, ma la decisione resta tua.</small></section>`:''}${run.status==='review'&&!passed(run)?ui`<p class="repo-notice">${run.decision?.status==='changes_requested'?t('Questo tentativo è stato sostituito da una nuova revisione. La patch resta consultabile.'):t('Approvazione non disponibile: occorrono una patch non vuota e tutti i controlli configurati superati e validi.')}</p>`:''}${run.decision?ui`<section class="repo-decision"><h3>Decisione conservata</h3><p>${html(typeof run.decision==='string'?run.decision:run.decision.feedback||({approved:t('Patch approvata'),changes_requested:t('Nuova revisione richiesta')})[run.decision.status]||run.decision.kind||t('Decisione registrata'))}</p>${run.decision.nextRunId?ui`<button type="button" class="ops-text-button" data-repo-action="run" data-id="${html(run.decision.nextRunId)}">Apri la nuova revisione ↗</button>`:''}</section>`:''}<details class="ops-disclosure ops-events" data-detail="events"><summary>Attività dell’incarico</summary><ol>${(run.events||[]).map(event=>ui`<li><time>${html(date(event.at||event.createdAt))}</time><span>${html(event.message||event.text||event.type||event.kind)}</span></li>`).join('')||ui('<li>Nessun evento registrato.</li>')}</ol></details><p class="repo-footnote">La patch resta separata dal repository originale. Nessun merge o push automatico.</p></div>`,ui`<button type="button" class="ops-button" data-repo-close>Chiudi</button><button type="button" class="ops-button" data-repo-action="refresh-run" data-id="${html(id)}">Aggiorna</button>${run.status==='queued'?ui`<button type="button" class="ops-button is-primary" data-repo-action="start" data-id="${html(id)}" data-repo-mutation data-repo-unavailable="${!targetOnline(run)}">Avvia Codex</button>`:''}${run.status==='running'?ui`<button type="button" class="ops-button" data-repo-action="pause" data-id="${html(id)}" data-repo-mutation>Ferma il lavoro</button>`:''}${['review','failed','paused'].includes(run.status)?ui`<button type="button" class="ops-button" data-repo-action="revise" data-id="${html(id)}" data-repo-mutation>Chiedi una revisione</button>`:''}${run.status==='review'?ui`<button type="button" class="ops-button is-primary" data-repo-action="approve" data-id="${html(id)}" data-repo-mutation${passed(run)?'':' disabled'}>Approva patch</button>`:''}${run.status==='completed'&&run.decision?.status==='approved'?ui`<button type="button" class="ops-button is-primary" data-repo-action="memory" data-id="${html(id)}" data-repo-mutation>Crea memoria proposta</button><button type="button" class="ops-button" data-repo-action="outcome" data-id="${html(id)}" data-repo-mutation>Valuta risultato</button><button type="button" class="ops-button" data-repo-action="github" data-id="${html(id)}" data-repo-mutation>Prepara PR GitHub</button>`:''}`);
    for(const el of dialog.querySelectorAll('details[data-detail]'))el.open=opened.includes(el.dataset.detail);dialog.scrollTop=scroll;
  }
  async function readPatch(run,{download=false}={}) {
    const key=`${run.id}:${run.patchHash}`;
    if(!download&&patches.has(key)){patches.delete(key);showRun(run.id);return;}
    patchLoading=true;if(!download)showRun(run.id);
    try{const response=await fetch(`/api/repositories/patch?id=${encodeURIComponent(run.id)}`,{cache:'no-store'});if(!response.ok){let value;try{value=await response.json();}catch{}throw Error(value?.error||t('Non è stato possibile caricare la patch.'));}const patch=await response.text();if(download){const url=URL.createObjectURL(new Blob([patch],{type:'text/x-diff;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`${run.id}.patch`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}else{patches.set(key,patch);while(patches.size>3)patches.delete(patches.keys().next().value);}}
    catch(e){toast(e.message);}finally{patchLoading=false;if(view?.kind==='run'&&view.id===run.id&&dialog.open)showRun(run.id);}
  }
  async function pause(run){if(locked())return;saving=true;syncLocks();try{await mutation('pause',{id:run.id,expectedVersion:run.version});showRun(run.id);}catch(e){toast(e.message);}finally{saving=false;syncLocks();}}
  async function refreshRepository(repo){if(!targetOnline(repo))return;saving=true;syncLocks();try{await mutation('refresh',{id:repo.id,expectedVersion:repo.version});toast(t('Collegamento aggiornato. I prossimi incarichi useranno questa configurazione.'));}catch(e){toast(e.message);}finally{saving=false;syncLocks();}}
  function click(event) {
    const close=event.target.closest('[data-repo-close]');if(close){if(!saving)dialog.close();return;}
    const button=event.target.closest('[data-repo-action]');if(!button||button.disabled)return;
    const {repoAction:action,id}=button.dataset;
    if(action==='refresh'||action==='refresh-run'){void load().then(()=>{if(dialog.open&&dialog.querySelector('#repo-project'))updateRegistration(true);});return;}
    if(action==='devices'){dialog.close();window.dispatchEvent(new CustomEvent('studio-open-access',{detail:{section:'devices'}}));return;}
    if(action==='refresh-repository'){const repo=repository(id);if(repo&&!locked())void refreshRepository(repo);return;}
    if(action==='register'){register();return;}
    if(action==='new-project'){onNewProject();return;}
    if(action==='create'){const repo=repository(id);if(repo&&!locked())create(repo);return;}
    if(action==='use-suggested'){dialog.querySelector('[name="path"]').value=snapshot.suggestedPath;return;}
    if(action==='add-check'){dialog.querySelector('#repo-check-fields').insertAdjacentHTML('beforeend',checkFields());return;}
    if(action==='remove-check'){button.closest('.repo-check-fields').remove();return;}
    const run=runFor(id);if(!run)return;
    if(action==='github'&&run.status==='completed'&&run.decision?.status==='approved'){dialog.close();window.dispatchEvent(new CustomEvent('studio-open-github',{detail:{runId:run.id}}));return;}
    if(action==='outcome'&&run.status==='completed'&&run.decision?.status==='approved'){dialog.close();onOutcome({runId:run.id,title:run.title});return;}
    if(action==='run'){showRun(id);return;}if(action==='patch'||action==='download'){void readPatch(run,{download:action==='download'});return;}
    if(locked())return;
    if(action==='start'&&run.status==='queued')start(run);if(action==='pause'&&run.status==='running')void pause(run);if(action==='revise'&&['review','failed','paused'].includes(run.status))revise(run);if(action==='approve')approve(run);if(action==='memory'&&run.status==='completed'&&run.decision?.status==='approved')proposeMemory(run);
  }
  const stopLanguage=onLanguageChange(()=>{
    if(disposed)return;render();if(!dialog.open||saving||!languageView)return;
    const previous=[...dialog.querySelectorAll('input,textarea,select')].map(node=>({id:node.id,name:node.name,value:node.value,checked:node.checked,type:node.type}));
    const fields=[...dialog.querySelectorAll('.repo-check-fields')].map(row=>({label:row.querySelector('[name="checkLabel"]').value,program:row.querySelector('[name="checkProgram"]').value,args:row.querySelector('[name="checkArgs"]').value}));
    const get=name=>previous.find(item=>item.name===name)?.value;
    const wasRegister=Boolean(dialog.querySelector('#repo-project'));
    const errorNode=dialog.querySelector('.ops-form-error'),errorState=errorNode&&!errorNode.hidden?errorNode.textContent:null;
    languageView();
    if(wasRegister){
      dialog.querySelector('#repo-project').value=get('projectId');updateRegistration(true);
      dialog.querySelector('#repo-execution-target').value=get('executionTarget');updateRegistration(false);
      dialog.querySelector('#repo-alias').value=get('repositoryAlias')||'';updateRegistration(false);
      dialog.querySelector('#repo-check-fields').innerHTML=fields.map(check=>checkFields({...check,args:[]})).join('');
    }
    const used=new Map();for(const item of previous){const index=used.get(item.name)||0;used.set(item.name,index+1);const node=[...dialog.querySelectorAll('input,textarea,select')].filter(el=>el.name===item.name)[index];if(!node||node.type==='file')continue;const label=node.id&&dialog.querySelector('label[for="'+node.id+'"]');if(label)label.htmlFor=item.id;node.id=item.id;if(node.type==='checkbox'||node.type==='radio')node.checked=item.checked;else node.value=item.value;}
    if(errorState){const box=dialog.querySelector('.ops-form-error');if(box){box.textContent=errorState;box.hidden=false;}}
    syncLocks();
  });
  host.addEventListener('click',click);dialog.addEventListener('click',click);
  dialog.addEventListener('close',()=>{if(!dialog.open)view=null;});dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  return {load,openRun:showRun,setContext(value){context={...context,...value};render();},setVisible(value){visible=Boolean(value);host.hidden=!visible;render();if(visible&&!loaded&&!loading)void load();},setBusy(value){busy=Boolean(value);syncLocks();},getSnapshot:()=>snapshot,dispose(){stopLanguage();disposed=true;loadVersion++;clearTimeout(pollTimer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('studio-session-expired',expire);host.removeEventListener('click',click);dialog.remove();patches.clear();}};
}
