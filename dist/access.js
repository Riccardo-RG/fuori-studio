import { t, ui, locale, language, onLanguageChange } from './i18n.js';
import {createSetupPanel} from './setup.js';
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const date = value => { const d = new Date(value); return value && Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(d) : t('Non ancora'); };
const originalFetch = window.fetch.bind(window);
let gateOptions = {};
let session = null, fetchInstalled = false, booting = false, appLoaded = false, sessionCheck = null;
export function getAccessSession() { return session; }

function gate({error = '', expired = false} = {}) {
  gateOptions = {error,expired};
  const host = document.querySelector('#access-gate'), shell = document.querySelector('.app-shell');
  if (!host) return;
  document.body.classList.add('access-pending'); shell.inert = true; host.hidden = false;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  const needsLogin = session?.authRequired && !session.authenticated;
  host.innerHTML = ui`<div class="access-gate-card"><img src="favicon.svg" alt="" width="48" height="48"><span class="eyebrow">IL TUO STUDIO, IL TUO SPAZIO</span><h1>${error ? t('Lo studio non risponde.') : needsLogin ? (expired ? t('Rientra nel tuo studio.') : t('Benvenuto in Fuori Studio.')) : t('Apriamo il tuo studio.')}</h1><p>${error ? html(error) : needsLogin ? t('Accedi per ritrovare gli ambiti, le memorie e il lavoro che hai conservato.') : t('Verifichiamo l’accesso a questa installazione.')}</p>${needsLogin ? ui('<a class="access-button is-primary" href="/auth/login">Accedi al tuo studio <span aria-hidden="true">↗</span></a><p class="access-gate-note">L’account dello studio è separato dalle credenziali dei servizi AI.</p>') : error ? ui('<button class="access-button is-primary" type="button" data-access-retry>Riprova</button>') : ui('<span class="access-loading" role="status">Verifica in corso…</span>')}</div>`;
  host.querySelector('[data-access-retry]')?.addEventListener('click', () => void bootstrap());
}
function installSessionFetch() {
  if (fetchInstalled) return; fetchInstalled = true;
  window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const internal = url.origin === location.origin && /^\/(api|auth)\//.test(url.pathname);
    const publicRequest = url.pathname === '/api/session';
    if (internal && !publicRequest && session?.authRequired && !session.authenticated) return new Response(JSON.stringify({get error(){return t('Accedi di nuovo al tuo studio.');}}),{status:401,headers:{'Content-Type':'application/json'}});
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let options = init;
    if (internal) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('Accept-Language',language());
      if (!['GET','HEAD','OPTIONS'].includes(method)) {
        headers.set('X-Fuori-Studio','local');
        if (session?.csrfToken) headers.set('X-CSRF-Token',session.csrfToken);
      }
      options = {...init,headers};
    }
    const response = await originalFetch(input,options);
    if (internal && !publicRequest && response.status === 401 && session?.authRequired && session.authenticated) {
      // A remote pairing failure can also be 401; verify our own session first.
      if(!sessionCheck)sessionCheck=originalFetch('/api/session',{cache:'no-store',headers:{'Accept-Language':language()}}).then(async result=>result.ok?result.json():null).catch(()=>null).finally(()=>{sessionCheck=null;});
      const latest=await sessionCheck;
      if(latest&&typeof latest.authenticated==='boolean'){
        const expired=session?.authenticated&&latest.authRequired&&!latest.authenticated;session=latest;
        if(expired){gate({expired:true});window.dispatchEvent(new Event('studio-session-expired'));}
      }
    }
    return response;
  };
}
async function bootstrap() {
  if (booting) return; booting = true; gate();
  try {
    const response = await originalFetch('/api/session',{cache:'no-store',headers:{'Accept-Language':language()}});
    if (!response.ok) throw Error(t('L’accesso non è disponibile. Verifica che lo studio sia avviato, poi riprova.'));
    const value = await response.json();
    if (typeof value.authRequired !== 'boolean' || typeof value.authenticated !== 'boolean') throw Error(t('Lo studio ha restituito uno stato di accesso non valido.'));
    session = value; installSessionFetch();
    if (session.authRequired && !session.authenticated) { gate(); return; }
    document.querySelector('#access-gate').hidden = true; document.querySelector('.app-shell').inert = false; document.body.classList.remove('access-pending');
    await (await import('./team.js')).loadTeam();
    if (!appLoaded) { await import('./app.js'); appLoaded = true; }
  } catch (error) { gate({error:error.message}); }
  finally { booting = false; }
}

export function createAccessPanel({toast = () => {},onAISettings = () => {},onWorkspaceChanged = () => {},getScopeId = () => 'business'} = {}) {
  const dialog = document.createElement('dialog'); dialog.id = 'access-dialog'; dialog.className = 'access-dialog'; dialog.setAttribute('aria-labelledby','access-title'); document.body.append(dialog);
  const trigger = document.querySelector('#access-open');
  let tab = 'account', state = null, scopes = [], sessions = [], loading = false, saving = false, failure = '', pairing = null, confirm = null, loadNumber = 0;
  const formDrafts=new Map();
  const setup=createSetupPanel({toast});
  const modes = {local:'Locale',hybrid:'Ibrido',online:'Online'};
  const scopeName = id => scopes.find(scope => scope.id === id)?.name || id;
  const checkedScopes = (values = [],prefix = 'scopeIds',allowed = null) => ui`<div class="access-scope-grid">${(allowed?allowed.map(id=>scopes.find(scope=>scope.id===id)||{id,name:id,kind:'scope'}):scopes).filter(scope => scope.kind !== 'archive').map(scope => ui`<label><input type="checkbox" name="${prefix}" value="${html(scope.id)}"${values.includes(scope.id)?' checked':''}><span>${html(scope.name)}<small>${({get shared(){return t('Profilo comune');},get profile(){return t('Profilo comune');},get project(){return t('Progetto');},get business(){return t('Lavoro');},get personal(){return t('Personale');}})[scope.kind] || t('Ambito')}</small></span></label>`).join('')}</div>`;
  const help = (title,text) => ui`<details class="access-help"><summary aria-label="Aiuto: ${html(title)}">?</summary><div role="note"><strong>${html(title)}</strong><p>${html(text)}</p></div></details>`;
  const note = text => ui`<p class="access-note">${html(text)}</p>`;
  async function request(path,body) {
    const response = await fetch(path,body ? {method:'POST',headers:{'Content-Type':'application/json','Accept-Language':language()},body:JSON.stringify(body)} : {cache:'no-store',headers:{'Accept-Language':language()}});
    let data;try {data=await response.json();}catch {throw Error(t('Lo studio non ha risposto correttamente. Riprova.'));}
    if (!response.ok) {const error=Error(data.error || t('Operazione non riuscita.'));error.status=response.status;throw error;}
    return data;
  }
  function updateTrigger() {
    if (!trigger) return;
    const local = session?.mode === 'local';
    trigger.querySelector('[data-access-name]').textContent = local ? t('Su questo dispositivo') : session?.user?.name || t('Il mio account');
    trigger.setAttribute('aria-label',local ? t('Apri accesso, dispositivi e sincronizzazione') : t('Account di {name}: dispositivi e sincronizzazione',{name:session?.user?.name || t('questo studio')}));
  }
  function accountView() {
    const local = state.mode === 'local';
    return ui`<div class="access-intro"><div><span class="access-kicker">IL TUO ACCESSO</span><h3>${local ? t('Uno studio sul tuo dispositivo.') : html(t('Ciao, {name}.',{name:session?.user?.name || t('bentornato')}))}</h3><p>${local ? t('Qui puoi lavorare senza un account. Lo studio conserva i dati in questa installazione.') : t('L’account protegge l’accesso allo studio. I dispositivi autorizzati possono sincronizzare gli ambiti che scegli.')}</p></div><span class="access-mode">${html(modes[state.mode] ? t(modes[state.mode]) : state.mode)}</span></div><div class="access-facts"><div><span>Archivio</span><strong>${state.storage?.type === 'sqlite' ? t('Database locale') : t('Archivio dello studio')}</strong><small>${state.storage?.encrypted ? t('Cifrato a riposo') : t('Cifratura non confermata')}</small></div><div><span>Accesso</span><strong>${local ? t('Nessun account richiesto') : t('Account personale')}</strong><small>${local ? t('Questa installazione') : html(session?.user?.name || t('Accesso autenticato'))}</small></div></div><div class="access-ai-card"><span class="access-ai-icon" aria-hidden="true">✳</span><div><strong>L’account non è il servizio AI.</strong><p>Codex e gli altri modelli hanno connessioni e credenziali proprie.</p></div><button type="button" class="access-button" data-action="ai-settings">Servizi AI ↗</button></div>${!local && session?.authRequired ? ui`<section class="access-section"><div class="access-section-title"><h4>Accessi al tuo account</h4>${help(t('Accessi e dispositivi'),t('Un accesso è una sessione del browser. Un dispositivo collegato ha invece permessi specifici di sincronizzazione o esecuzione, gestiti nella scheda Dispositivi.'))}</div><div class="access-list">${sessions.map(item=>ui`<article class="access-session"><div><strong>${html(item.name || t('Browser'))}</strong><small>${item.current ? t('Questo accesso') : t('Ultima attività {date}',{date:date(item.lastSeenAt)})} · scade ${date(item.expiresAt)}</small></div>${item.current ? ui('<span class="access-state">Attuale</span>') : ui`<button type="button" class="access-link is-danger" data-action="confirm-session" data-id="${html(item.id)}">Termina</button>`}</article>`).join('') || note(t('Nessuna sessione aggiuntiva disponibile.'))}</div><button type="button" class="access-button" data-action="logout">Esci da questo studio</button></section>` : ''}`;
  }
  function devicesView() {
    const devices=state.devices || [],active=devices.filter(item=>!item.revokedAt),canPair=state.mode!=='local';
    return ui`<div class="access-intro"><div><span class="access-kicker">DISPOSITIVI AUTORIZZATI</span><h3>Ogni dispositivo ha il suo compito.</h3><p>Concedi accesso solo agli ambiti e alle funzioni che vuoi usare altrove.</p></div>${help(t('Un codice, permessi precisi'),t('Il codice è monouso e scade. Chi lo usa riceve solo le capacità e gli ambiti selezionati. Per eseguire incarichi testuali o modifiche al codice deve essere attivo anche il worker sul dispositivo. Il permesso Repository richiede inoltre repository e controlli autorizzati dalla CLI su quel computer.'))}</div><div class="access-list">${active.length ? active.map(item=>ui`<article class="access-device"><div class="access-device-top"><div><strong>${html(item.name)}</strong><small>${item.online ? t('Online') : t('Non connesso')} · ultima attività ${date(item.lastSeenAt)}</small></div><span class="access-state${item.online?'':' is-muted'}">${item.online?t('Online'):t('Offline')}</span></div><div class="access-tags">${(item.capabilities || []).map(value=>ui`<span>${html(({get execute(){return t('Incarichi testuali');},get sync(){return t('Sincronizzazione');},get repository(){return t('Modifiche ai repository');}})[value]||value)}</span>`).join('')}</div><p>${(item.scopeIds || []).map(scopeName).map(html).join(' · ') || t('Nessun ambito autorizzato')}</p><button type="button" class="access-link is-danger" data-action="confirm-device" data-id="${html(item.id)}">Revoca questo dispositivo</button></article>`).join('') : ui`<div class="access-empty"><strong>Questo studio non ha altri dispositivi.</strong><p>${canPair?t('Crea un codice quando vuoi collegarne uno.'):t('Collega uno studio dalla scheda Sincronizzazione.')}</p></div>`}</div><form class="access-form access-section" data-form="execution"><div class="access-section-title"><h4>Dove si eseguono gli incarichi testuali</h4>${help(t('Esecuzione degli incarichi'),t('Questa scelta riguarda gli incarichi testuali. Un dispositivo remoto deve avere il permesso Eseguire incarichi testuali, accesso all’ambito e un worker attivo. Per il codice scegli invece il computer quando colleghi il repository. Le credenziali AI appartengono al computer che esegue il lavoro.'))}</div><label for="access-executor">Destinazione dei nuovi incarichi testuali</label><div class="access-inline"><select id="access-executor" name="id"><option value="local"${state.executionTarget==='local'?' selected':''}>Questa installazione</option>${active.filter(item=>(item.capabilities||[]).includes('execute')).map(item=>ui`<option value="${html(item.id)}"${state.executionTarget===item.id?' selected':''}>${html(item.name)} · ${item.online?'online':'offline'}</option>`).join('')}</select><button class="access-button" type="submit">Salva</button></div></form>${canPair?ui`<details class="access-disclosure"${pairing?' open':''}><summary>＋ Collega un nuovo dispositivo</summary><form class="access-form" data-form="pair"><label for="access-device-name">Nome del dispositivo</label><input id="access-device-name" name="name" required maxlength="100" autocomplete="off" placeholder="Ad esempio: MacBook personale"><fieldset><legend>Funzioni autorizzate</legend><div class="access-checks"><label><input type="checkbox" name="capabilities" value="sync"><span>Sincronizzare memorie e procedure</span></label><label><input type="checkbox" name="capabilities" value="execute"><span>Eseguire incarichi testuali<small>Risposte e consegne AI, con le connessioni del dispositivo.</small></span></label><label><input type="checkbox" name="capabilities" value="repository"><span>Modifiche ai repository<small>Codex, copie isolate e controlli sui repository autorizzati dalla CLI del dispositivo.</small></span></label></div></fieldset><fieldset><legend>Ambiti autorizzati</legend>${checkedScopes()}</fieldset><button type="submit" class="access-button is-primary">Crea codice monouso</button></form>${pairing ? ui`<div class="access-pairing" role="status"><span>CODICE DI COLLEGAMENTO</span><code>${html(pairing.code)}</code><p>Scade ${date(pairing.expiresAt)}</p><dl><dt>Studio</dt><dd>${html(pairing.serverUrl || location.origin)}</dd></dl><p>Per sincronizzare, inseriscilo in “Collega uno studio” sul nuovo dispositivo. Per eseguire incarichi o modifiche al codice, usalo nel collegamento del worker dalla CLI. Il codice non viene salvato nel browser.</p><button class="access-button" type="button" data-action="copy-pairing">Copia codice</button></div>` : ''}</details>`:ui(`<div class="access-empty"><strong>Collega questo dispositivo a uno studio online.</strong><p>Il codice si crea nello studio online. Inseriscilo nella scheda Sincronizzazione di questa installazione.</p><button class="access-button" type="button" data-action="goto-sync">Collega uno studio</button></div>`)}`;
  }
  function conflictView(conflict) {
    const local=conflict.local || {},remote=conflict.remote || {};
    const localDeleted=conflict.localDeleted===true,remoteDeleted=conflict.remoteDeleted===true;
    const text=item=>Object.keys(item).length?[item.content||item.description,item.input?t('Materiali: {value}',{value:item.input}):'',...(item.steps||[]).map((step,i)=>`${i+1}. ${step.title} · ${step.agentId||''}\n${step.output||''}`),item.output?t('Consegna: {value}',{value:item.output}):''].filter(Boolean).join('\n\n')||item.title:t('Voce rimossa');
    return ui`<article class="access-conflict"><div class="access-section-title"><h4>${html(conflict.title || local.title || remote.title || t('Modifiche da confrontare'))}</h4><span class="access-state is-warning">Da scegliere</span></div><p>${html(scopeName(conflict.scopeId))} · ${conflict.kind==='workflow'?t('Procedura'):conflict.kind==='scope'?t('Ambito'):t('Memoria')}</p><div class="access-compare"><div><span>QUESTA INSTALLAZIONE</span><strong>${html(local.title || t('Versione locale'))}</strong><p>${html(text(local))}</p><small>${date(local.updatedAt)}</small></div><div><span>STUDIO COLLEGATO</span><strong>${html(remote.title || t('Versione remota'))}</strong><p>${html(text(remote))}</p><small>${date(remote.updatedAt)}</small></div></div>${localDeleted||remoteDeleted?ui('<p class="access-note">Una copia è stata eliminata. Se il testo dell’altra versione è ancora utile, copialo in una nuova nota prima di confermare l’eliminazione.</p>'):''}<div class="access-row-actions"><button type="button" class="access-button" data-action="resolve" data-id="${html(conflict.id)}" data-choice="local"${remoteDeleted&&!localDeleted?' disabled':''}>${localDeleted?t('Conferma eliminazione locale'):t('Mantieni copia locale')}</button><button type="button" class="access-button" data-action="resolve" data-id="${html(conflict.id)}" data-choice="remote"${localDeleted&&!remoteDeleted?' disabled':''}>${remoteDeleted?t('Conferma eliminazione collegata'):t('Usa copia collegata')}</button></div></article>`;
  }
  function syncView() {
    const sync=state.sync || {},link=sync.link,conflicts=sync.conflicts || [];
    return ui`<div class="access-intro"><div><span class="access-kicker">CONTINUITÀ, A TUA SCELTA</span><h3>Porta con te solo gli ambiti che scegli.</h3><p>Si sincronizzano ambiti, memorie e procedure. Conversazioni e incarichi restano nella rispettiva installazione.</p></div>${help(t('Cosa viene condiviso'),t('La sincronizzazione è facoltativa per ogni ambito. Non trasferisce la cronologia completa, gli incarichi o le credenziali dei servizi AI. Se entrambe le copie cambiano, confronti le versioni e scegli quale conservare.'))}</div>${link ? ui`<div class="access-connection"><div><strong>${html(link.name || t('Studio collegato'))}</strong><p>${html(link.url)}</p><small>Ultima sincronizzazione ${date(link.lastSyncAt)}</small></div><span class="access-state${link.error?' is-warning':link.lastSyncAt?'':' is-muted'}">${link.error?t('Da verificare'):link.lastSyncAt?t('Sincronizzato'):t('Configurato')}</span></div>${link.error?ui`<p class="access-inline-error" role="status">${html(link.error)}</p>`:''}<form class="access-form access-section" data-form="sync-scopes"><div class="access-section-title"><h4>Ambiti da sincronizzare</h4><span class="access-count">${(sync.enabledScopeIds||[]).length} selezionati</span></div>${checkedScopes(sync.enabledScopeIds||[],'scopeIds',link.scopeIds||[])}<div class="access-row-actions"><button type="submit" class="access-button">Salva selezione</button><button type="button" class="access-button is-primary" data-action="sync-now">Sincronizza ora</button></div><p class="access-note">Gli aggiornamenti partono con “Sincronizza ora”. Deselezionare un ambito ferma gli aggiornamenti futuri. Non cancella le copie già trasferite.</p></form>${conflicts.length ? ui`<section class="access-section"><div class="access-section-title"><h4>Versioni da confrontare</h4><span class="access-count">${conflicts.length}</span></div><p class="access-note">Le modifiche in conflitto attendono una tua scelta.</p>${conflicts.map(conflictView).join('')}</section>` : ui('<div class="access-quiet-status">Nessun conflitto da risolvere.</div>')}<button type="button" class="access-link is-danger" data-action="confirm-disconnect">Scollega questo studio</button>` : ui(`<div class="access-empty"><strong>La sincronizzazione è disattivata.</strong><p>Il lavoro rimane in questa installazione finché non colleghi uno studio e selezioni gli ambiti.</p></div><form class="access-form access-section" data-form="connect"><h4>Collega uno studio</h4><p class="access-note">Crea prima un codice monouso nella scheda Dispositivi dello studio da collegare.</p><label for="access-sync-url">Indirizzo dello studio</label><input id="access-sync-url" name="url" type="url" required autocomplete="url" placeholder="https://studio.example.com"><div class="access-form-grid"><div><label for="access-sync-code">Codice monouso</label><input id="access-sync-code" name="code" required maxlength="200" autocomplete="off" spellcheck="false"></div><div><label for="access-sync-name">Nome di questo dispositivo</label><input id="access-sync-name" name="name" required maxlength="100" autocomplete="off" placeholder="Mac personale"></div></div><button type="submit" class="access-button is-primary">Collega studio</button><p class="access-note">Dopo il collegamento sceglierai gli ambiti da sincronizzare.</p></form>`)}`;
  }
  function render() {
    dialog.querySelectorAll('form[data-form]').forEach(form=>{const fields=[...form.querySelectorAll('[name]')];formDrafts.set(form.dataset.form,fields.filter(field=>!['checkbox','radio'].includes(field.type)||field.checked).map(field=>[field.name,field.value]));});
    const focusId=dialog.contains(document.activeElement)?document.activeElement.id:null;
    dialog.innerHTML = ui`<div class="access-dialog-head"><div><span class="eyebrow">IL TUO STUDIO</span><h2 id="access-title">Accesso e dispositivi.</h2></div><button type="button" class="access-close" data-action="close" aria-label="Chiudi accesso e dispositivi">✕</button></div><div class="access-tabs" role="tablist" aria-label="Accesso allo studio">${[['account',t('Account')],['devices',t('Dispositivi')],['sync',t('Sincronizzazione')],['setup',t('Preparazione')]].map(([id,label])=>ui`<button type="button" role="tab" id="access-tab-${id}" aria-controls="access-content" data-tab="${id}" aria-selected="${tab===id}" tabindex="${tab===id?0:-1}">${label}</button>`).join('')}</div><div class="access-feedback${failure?' is-error':''}" role="${failure?'alert':'status'}"${!failure&&!loading?' hidden':''}>${html(failure || t('Verifica dello studio…'))}${failure?ui('<button type="button" class="access-link" data-action="refresh">Riprova</button>'):''}</div><div class="access-dialog-body" id="access-content" role="tabpanel" aria-labelledby="access-tab-${tab}">${tab==='setup'?ui('<div id="access-setup-panel"></div>'):state ? tab==='account'?accountView():tab==='devices'?devicesView():syncView() : ui('<div class="access-empty"><span class="access-loading">Caricamento…</span></div>')}${confirm?ui`<div class="access-confirm" role="alert"><strong>${html(confirm.title)}</strong><p>${html(confirm.message)}</p><div class="access-row-actions"><button type="button" class="access-button" data-action="cancel-confirm">Annulla</button><button type="button" class="access-button is-danger" data-action="confirm">${html(confirm.label)}</button></div></div>`:''}</div>`;
    dialog.querySelectorAll('form[data-form]').forEach(form=>{const draft=formDrafts.get(form.dataset.form);if(!draft)return;for(const field of form.querySelectorAll('[name]')){const values=draft.filter(([name])=>name===field.name).map(([,value])=>value);if(field.type==='checkbox'||field.type==='radio')field.checked=values.includes(field.value);else if(values.length)field.value=values[0];}});
    setup.attach(dialog.querySelector('#access-setup-panel'));setup.setVisible(tab==='setup'&&dialog.open);
    dialog.setAttribute('aria-busy',String(loading||saving));
    if(loading||saving)dialog.querySelectorAll('button:not([data-action="close"]),input,select').forEach(item=>item.disabled=true);
    if(focusId)dialog.querySelector(`#${CSS.escape(focusId)}`)?.focus({preventScroll:true});
  }
  async function load() {
    const number=++loadNumber;loading=true;failure='';render();
    try {
      const [value,workspace,accesses]=await Promise.all([request('/api/access'),request('/api/workspace'),session?.authRequired?request('/auth/sessions'):Promise.resolve({sessions:[]})]);
      if(number!==loadNumber)return;
      if(!value?.mode||!Array.isArray(value.devices))throw Error(t('Lo stato dei dispositivi non è valido.'));
      state=value;scopes=workspace.scopes||[];sessions=accesses.sessions||[];
    } catch(error){if(number===loadNumber)failure=error.message;}
    finally{if(number===loadNumber){loading=false;render();updateTrigger();}}
  }
  async function mutate(path,body,message,after) {
    if(saving||loading)return;saving=true;failure='';render();
    try {const value=await request(path,body);if(after)after(value);if(message)toast(message);await load();}
    catch(error){failure=error.status===409?t('{error} Le versioni sono cambiate: aggiorna lo stato prima di scegliere di nuovo.',{error:error.message}):error.message;}
    finally{saving=false;render();}
  }
  async function submit(form) {
    if(saving||loading||!form.reportValidity())return;
    const data=new FormData(form),kind=form.dataset.form;
    if(kind==='pair') {
      const scopeIds=data.getAll('scopeIds'),capabilities=data.getAll('capabilities');
      if(!scopeIds.length||!capabilities.length){failure=t('Scegli almeno un ambito e una funzione da autorizzare.');render();return;}
      await mutate('/api/devices',{action:'pair',payload:{name:String(data.get('name')).trim(),scopeIds,capabilities}},t('Codice creato. Usalo prima della scadenza.'),value=>pairing=value);
    } else if(kind==='execution') await mutate('/api/devices',{action:'target',payload:{id:data.get('id')}},t('Destinazione degli incarichi aggiornata.'));
    else if(kind==='connect') await mutate('/api/sync',{action:'connect',payload:{url:String(data.get('url')).trim(),code:String(data.get('code')).trim(),name:String(data.get('name')).trim()}},t('Studio collegato. Scegli gli ambiti da sincronizzare.'));
    else if(kind==='sync-scopes') await mutate('/api/sync',{action:'configure',payload:{scopeIds:data.getAll('scopeIds')}},t('Scelta degli ambiti salvata.'));
  }
  dialog.addEventListener('submit',event=>{event.preventDefault();void submit(event.target);});
  dialog.addEventListener('click',async event=>{
    const tabButton=event.target.closest('[data-tab]');if(tabButton&&!saving&&!loading){tab=tabButton.dataset.tab;failure='';confirm=null;render();dialog.querySelector(`#access-tab-${tab}`)?.focus();return;}
    const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
    const action=button.dataset.action;
    if(action==='close'){if(!saving)dialog.close();return;}
    if(action==='refresh'){void load();return;}
    if(action==='goto-sync'){tab='sync';render();return;}
    if(action==='ai-settings'){dialog.close();onAISettings();return;}
    if(action==='logout'){if(saving)return;saving=true;render();try{await request('/auth/logout',{});session={...session,authenticated:false,csrfToken:null};gate();window.dispatchEvent(new Event('studio-session-expired'));}catch(error){failure=error.message;}finally{saving=false;if(dialog.open)render();}return;}
    if(action==='copy-pairing'){try{await navigator.clipboard.writeText(pairing.code);toast(t('Codice copiato.'));}catch{toast(t('Copia il codice mostrato nella scheda.'));}return;}
    if(action==='sync-now'){await mutate('/api/sync',{action:'run',payload:{}},t('Sincronizzazione verificata.'),()=>{onWorkspaceChanged();});return;}
    if(action==='resolve'){
      const conflict=state.sync.conflicts.find(item=>item.id===button.dataset.id);if(!conflict)return;
      await mutate('/api/sync',{action:'resolve',payload:{id:conflict.id,choice:button.dataset.choice,expectedVersion:conflict.version}},t('Versione scelta. Esegui la sincronizzazione per aggiornare lo studio collegato.'),()=>onWorkspaceChanged());return;
    }
    if(action==='confirm-device'){const device=state.devices.find(item=>item.id===button.dataset.id);if(!device)return;confirm={get title(){return t('Revocare {name}?',{name:device.name});},get message(){return t('Il dispositivo perderà i permessi per gli aggiornamenti e gli incarichi futuri. Le copie già trasferite non vengono cancellate.');},get label(){return t('Revoca dispositivo');},path:'/api/devices',body:{action:'revoke',payload:{id:device.id}}};render();}
    if(action==='confirm-session'){const item=sessions.find(item=>item.id===button.dataset.id);if(!item)return;confirm={get title(){return t('Terminare {name}?',{name:item.name || t('questo accesso')});},get message(){return t('Quel browser dovrà accedere di nuovo. Questo accesso rimane aperto.');},get label(){return t('Termina accesso');},path:'/auth/sessions/revoke',body:{id:item.id}};render();}
    if(action==='confirm-disconnect'){confirm={get title(){return t('Scollegare lo studio?');},get message(){return t('Gli aggiornamenti si fermano. Le memorie già presenti nelle due installazioni restano conservate.');},get label(){return t('Scollega studio');},path:'/api/sync',body:{action:'disconnect',payload:{}}};render();}
    if(action==='cancel-confirm'){confirm=null;render();}
    if(action==='confirm'&&confirm){const item=confirm;confirm=null;await mutate(item.path,item.body,t('Impostazione aggiornata.'));}
  });
  dialog.addEventListener('keydown',event=>{
    if(!event.target.matches('[role="tab"]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const tabs=['account','devices','sync','setup'],index=tabs.indexOf(tab);tab=tabs[event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];render();dialog.querySelector(`#access-tab-${tab}`).focus();
  });
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  dialog.addEventListener('close',()=>{if(dialog.open)return;setup.setVisible(false);setup.attach(null);pairing=null;confirm=null;formDrafts.clear();dialog.replaceChildren();});
  trigger?.addEventListener('click',()=>{if(!dialog.open)dialog.showModal();void load();});
  function open(section='account'){if(saving)return;tab=['account','devices','sync','setup'].includes(section)?section:'account';if(!dialog.open)dialog.showModal();void load();}
  window.addEventListener('studio-open-access',event=>open(event.detail?.section));
  onLanguageChange(()=>{updateTrigger();if(dialog.open)render();});
  updateTrigger();
  return {open,refresh:load};
}
onLanguageChange(()=>{const host=document.querySelector('#access-gate');if(host&&!host.hidden)gate(gateOptions);});
if(document.querySelector('#access-gate'))void bootstrap();
