import { agents } from './data.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const typeNames = { fact:'Informazione', preference:'Preferenza', decision:'Decisione', pattern:'Metodo ricorrente' };
const short = (value, max = 240) => String(value ?? '').length > max ? String(value).slice(0, max).trimEnd() + '…' : String(value ?? '');
const formattedDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('it-IT', {day:'numeric',month:'short',year:'numeric'}).format(date);
};

/** A local, inspectable knowledge library. The application owns conversation switching. */
export function createKnowledgePanel({ onScopeChange, onUseWorkflow, toast = () => {} }) {
  const panel = document.createElement('section');
  panel.id = 'knowledge-panel';
  panel.className = 'knowledge-panel';
  panel.setAttribute('aria-labelledby', 'knowledge-title');
  panel.innerHTML = `
    <div class="knowledge-heading"><div><div class="eyebrow">IL FILO DEL TUO LAVORO</div><h2 id="knowledge-title">La memoria dello studio.</h2><p>Contesti distinti. Collegamenti scelti da te.</p></div><button type="button" class="knowledge-button" data-action="new-scope" disabled>＋ Nuovo ambito</button></div>
    <div class="knowledge-toolbar"><div class="knowledge-scope-field"><label for="knowledge-scope">Ambito attivo · lo stesso della chat</label><select id="knowledge-scope" disabled><option>Caricamento…</option></select></div><p class="knowledge-scope-note" id="knowledge-scope-note">Le informazioni rimangono nel loro ambito. Puoi rendere disponibili singole note anche altrove.</p></div>
    <div class="knowledge-controls"><div class="knowledge-tabs" role="tablist" aria-label="Archivio dello studio"><button id="knowledge-tab-memories" type="button" role="tab" aria-selected="true" aria-controls="knowledge-results" data-tab="memories">Memoria <span data-count="memories">0</span></button><button id="knowledge-tab-workflows" type="button" role="tab" aria-selected="false" aria-controls="knowledge-results" tabindex="-1" data-tab="workflows">Procedure <span data-count="workflows">0</span></button></div><div class="knowledge-list-actions"><label class="visually-hidden" for="knowledge-search">Cerca nell’ambito attivo</label><input id="knowledge-search" type="search" placeholder="Cerca in questo ambito…" autocomplete="off" maxlength="200"><button type="button" class="knowledge-button is-primary" data-action="new-entry" disabled>＋ Nuova memoria</button></div></div>
    <div id="knowledge-feedback" class="knowledge-feedback" role="status" aria-live="polite">Caricamento della memoria…</div>
    <div id="knowledge-results" class="knowledge-results" role="tabpanel" aria-labelledby="knowledge-tab-memories" tabindex="0"></div>
    <p class="knowledge-footnote">Le proposte diventano contesto per gli agenti solo dopo la tua conferma. Le procedure preparano il lavoro in chat.</p>`;
  const insertion = document.querySelector('.team-section') || document.querySelector('main footer');
  if (insertion) insertion.before(panel);
  else document.querySelector('main')?.append(panel);

  const chatScope = document.createElement('div');
  chatScope.className = 'knowledge-chat-scope';
  chatScope.innerHTML = '<label for="knowledge-chat-scope">AMBITO</label><select id="knowledge-chat-scope" aria-label="Ambito della conversazione" disabled><option>Caricamento…</option></select><a href="#knowledge-title" aria-label="Apri la memoria di questo ambito" title="Apri la memoria">↗</a>';
  document.querySelector('.chat-context')?.before(chatScope);

  const dialog = document.createElement('dialog');
  dialog.id = 'knowledge-dialog';
  dialog.className = 'knowledge-dialog';
  dialog.setAttribute('aria-labelledby', 'knowledge-dialog-title');
  document.body.append(dialog);

  let snapshot = { version:1, scopes:[], memories:[], workflows:[] };
  let currentScope = 'business', activeTab = 'memories', query = '', busy = false, loading = true, saving = false, switching = false, failed = false;
  let loadRevision = 0;
  const $ = selector => panel.querySelector(selector);
  const isShared = scope => scope && (scope.id === 'shared' || scope.kind === 'shared' || scope.kind === 'profile');
  const scopeFor = id => snapshot.scopes.find(scope => scope.id === id);
  const scopeName = id => scopeFor(id)?.name || id || 'Ambito';
  const locked = () => busy || saving || switching || loading || failed;
  const visible = item => item.scopeId === currentScope || isShared(scopeFor(item.scopeId)) || (item.sharedWith || []).includes(currentScope);
  const scopeOptions = (selected, scopes = snapshot.scopes) => scopes.map(scope => `<option value="${escape(scope.id)}"${scope.id === selected ? ' selected' : ''}>${escape(scope.name)}${scope.parentId ? ` · ${escape(scopeName(scope.parentId))}` : ''}</option>`).join('');

  function setSnapshot(value) {
    if (!value || !Array.isArray(value.scopes) || !Array.isArray(value.memories) || !Array.isArray(value.workflows)) throw Error('La memoria ha restituito dati non validi. Riprova.');
    snapshot = value;
  }

  async function request(action, payload) {
    const response = await fetch('/api/workspace', action ? {method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify({action,payload})} : {cache:'no-store'});
    let data;
    try { data = await response.json(); } catch { throw Error('La memoria non è raggiungibile. Verifica che lo studio sia avviato.'); }
    if (!response.ok) {
      const error = Error(data.error || 'Non è stato possibile aggiornare la memoria.');
      error.status = response.status;
      throw error;
    }
    if (action) window.dispatchEvent(new CustomEvent('studio-workspace-changed'));
    return data;
  }

  function syncControls() {
    const disabled = locked();
    panel.querySelectorAll('[data-action]').forEach(button => { button.disabled = disabled && button.dataset.action !== 'retry'; });
    $('#knowledge-scope').disabled = disabled;
    chatScope.querySelector('select').disabled = disabled;
    panel.setAttribute('aria-busy', String(loading || switching));
    if (dialog.open) dialog.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = disabled; });
  }

  function syncScopes() {
    const options = scopeOptions(currentScope);
    $('#knowledge-scope').innerHTML = options;
    chatScope.querySelector('select').innerHTML = options;
    const selected = scopeFor(currentScope);
    $('#knowledge-scope-note').textContent = selected?.kind === 'archive' ? selected.description || 'Questa conversazione precede la separazione degli ambiti e può contenere temi diversi.' : isShared(selected)
      ? 'Il profilo comune è disponibile in tutti gli ambiti. Conserva qui soltanto preferenze e informazioni che vuoi usare ovunque.'
      : 'In questo ambito trovi le sue memorie, il profilo comune e le singole note collegate esplicitamente. Gli altri ambiti restano separati.';
    syncControls();
  }

  function origin(item) {
    if (item.scopeId === currentScope) return `<span class="knowledge-tag">${escape(scopeName(item.scopeId))}</span>`;
    if (isShared(scopeFor(item.scopeId))) return `<span class="knowledge-tag is-shared">Profilo comune · tutti gli ambiti</span>`;
    return `<span class="knowledge-tag is-shared">Collegata da ${escape(scopeName(item.scopeId))}</span>`;
  }

  function revisionButton(item) {
    return `<button type="button" class="knowledge-text-button" data-action="history" data-id="${escape(item.id)}" aria-label="Revisioni di ${escape(item.title)}">Versione ${escape(item.version || 1)}${item.revisions?.length ? ` · ${item.revisions.length} precedenti` : ''}</button>`;
  }

  function card(item) {
    const memory = activeTab === 'memories';
    const proposed = memory ? item.status !== 'confirmed' : item.status !== 'ready';
    const state = memory ? (proposed ? 'Da confermare' : 'Confermata') : (proposed ? 'Bozza' : 'Pronta');
    const agentRestriction = memory && item.agentIds?.length ? `<p class="knowledge-agent-access">Per ${escape(item.agentIds.map(id => agents.find(agent => agent.id === id)?.name || id).join(', '))}</p>` : '';
    return `<article class="knowledge-card"><div class="knowledge-card-meta">${origin(item)}<span class="knowledge-state${proposed ? ' is-proposed' : ''}">${state}</span></div><h3>${escape(item.title)}</h3><p class="knowledge-card-copy">${escape(short(memory ? item.content : item.description || item.input || item.output))}</p><div class="knowledge-card-details"><span>${memory ? escape(typeNames[item.type] || 'Informazione') : `${(item.steps || []).length} passaggi`}</span>${item.updatedAt ? `<span>Aggiornata ${escape(formattedDate(item.updatedAt))}</span>` : ''}</div>${agentRestriction}<p class="knowledge-source"><span>Fonte</span> ${escape(short(item.source || 'Annotazione manuale', 150))}</p>${item.sharedWith?.length ? `<p class="knowledge-links">Disponibile anche in ${escape(item.sharedWith.map(scopeName).join(', '))}</p>` : ''}<div class="knowledge-card-actions"><button type="button" class="knowledge-button" data-action="edit" data-id="${escape(item.id)}">${memory ? 'Apri / modifica' : 'Apri procedura'}</button>${memory && proposed ? `<button type="button" class="knowledge-button is-primary" data-action="confirm" data-id="${escape(item.id)}">Conferma</button>` : ''}${!memory && !proposed ? `<button type="button" class="knowledge-button is-primary" data-action="use" data-id="${escape(item.id)}">Usa in chat ↗</button>` : ''}</div><div class="knowledge-card-bottom">${revisionButton(item)}<button type="button" class="knowledge-text-button is-danger" data-action="delete" data-id="${escape(item.id)}" aria-label="Elimina ${escape(item.title)}">Elimina</button></div></article>`;
  }

  function render() {
    panel.querySelectorAll('[data-tab]').forEach(button => {
      const selected = button.dataset.tab === activeTab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.querySelector('[data-count]').textContent = snapshot[button.dataset.tab].filter(visible).length;
    });
    $('#knowledge-results').setAttribute('aria-labelledby', `knowledge-tab-${activeTab}`);
    $('[data-action="new-entry"]').textContent = activeTab === 'memories' ? '＋ Nuova memoria' : '＋ Nuova procedura';
    if (loading) {
      $('#knowledge-feedback').textContent = 'Caricamento della memoria…';
      $('#knowledge-results').innerHTML = '';
    } else if (failed) {
      $('#knowledge-results').innerHTML = '<div class="knowledge-empty"><h3>La memoria non è disponibile.</h3><p>I tuoi dati non sono stati modificati. Riprova a caricarli.</p><button type="button" class="knowledge-button" data-action="retry">Riprova</button></div>';
    } else {
      const term = query.trim().toLocaleLowerCase('it');
      const items = snapshot[activeTab].filter(visible).filter(item => !term || [item.title,item.content,item.description,item.input,item.output,item.source,...(item.steps || []).map(step => `${step.title} ${step.output}`)].join(' ').toLocaleLowerCase('it').includes(term)).sort((a,b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      $('#knowledge-feedback').textContent = query ? `${items.length} risultat${items.length === 1 ? 'o' : 'i'} in ${scopeName(currentScope)}.` : `${scopeName(currentScope)} · ${items.length} ${activeTab === 'memories' ? (items.length === 1 ? 'memoria disponibile' : 'memorie disponibili') : (items.length === 1 ? 'procedura disponibile' : 'procedure disponibili')}`;
      $('#knowledge-results').innerHTML = items.length ? items.map(card).join('') : `<div class="knowledge-empty"><span aria-hidden="true">${activeTab === 'memories' ? '◎' : '↗'}</span><h3>${query ? 'Nessun risultato in questo ambito.' : activeTab === 'memories' ? 'Diamo continuità al tuo lavoro.' : 'Un buon metodo, pronto a tornare utile.'}</h3><p>${query ? 'Prova un’altra parola o cambia ambito.' : activeTab === 'memories' ? 'Salva una preferenza, una decisione o un’informazione utile. Puoi anche partire da un messaggio della chat.' : 'Descrivi un incarico ricorrente, i suoi passaggi e la consegna attesa. Rivedilo prima di renderlo pronto.'}</p>${!query ? `<button type="button" class="knowledge-button" data-action="new-entry">${activeTab === 'memories' ? 'Aggiungi la prima memoria' : 'Crea una procedura'}</button>` : ''}</div>`;
    }
    syncControls();
  }

  async function load({scopeId} = {}) {
    const revision = ++loadRevision;
    loading = true;
    failed = false;
    render();
    try {
      const value = await request();
      if (revision !== loadRevision) return;
      setSnapshot(value);
      if (scopeId && scopeFor(scopeId)) currentScope = scopeId;
      if (!scopeFor(currentScope)) currentScope = snapshot.scopes.find(scope => !isShared(scope))?.id || snapshot.scopes[0]?.id || '';
      loading = false;
      syncScopes();
      render();
      return snapshot;
    } catch (error) {
      if (revision !== loadRevision) return;
      loading = false;
      failed = true;
      $('#knowledge-feedback').textContent = error.message;
      render();
    }
  }

  function setScope(scopeId) {
    if (!scopeId) return;
    currentScope = scopeId;
    query = '';
    $('#knowledge-search').value = '';
    syncScopes();
    render();
  }

  async function changeScope(scopeId) {
    if (locked()) { syncScopes(); return; }
    switching = true;
    syncControls();
    try {
      await onScopeChange(scopeId);
      setScope(scopeId);
    } catch (error) {
      toast(error.message || 'Non è stato possibile cambiare ambito.');
      syncScopes();
    } finally {
      switching = false;
      syncControls();
    }
  }

  function openDialog(title, body, submitLabel, onSubmit) {
    dialog.innerHTML = `<div class="knowledge-dialog-head"><div><div class="eyebrow">MEMORIA DELLO STUDIO</div><h2 id="knowledge-dialog-title">${escape(title)}</h2></div><button type="button" class="knowledge-close" aria-label="Chiudi finestra">✕</button></div><form class="knowledge-form"><div class="knowledge-form-body">${body}</div><p class="knowledge-form-error" role="alert" hidden></p><div class="knowledge-form-footer"><button type="button" class="knowledge-button" data-close>Annulla</button>${submitLabel ? `<button type="submit" class="knowledge-button is-primary">${escape(submitLabel)}</button>` : ''}</div></form>`;
    const close = () => { if (!saving) dialog.close(); };
    dialog.querySelector('.knowledge-close').addEventListener('click', close);
    dialog.querySelector('[data-close]').addEventListener('click', close);
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (locked() || !onSubmit) return;
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      const errorBox = dialog.querySelector('.knowledge-form-error');
      errorBox.hidden = true;
      saving = true;
      syncControls();
      dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        await onSubmit(new FormData(form), form);
        dialog.close();
      } catch (error) {
        errorBox.textContent = error.status === 409 ? `${error.message} Le modifiche nel modulo sono conservate. Chiudi e riapri la scheda per caricare l’ultima versione.` : error.message;
        errorBox.hidden = false;
        errorBox.scrollIntoView({block:'nearest'});
        if (error.status === 409) {
          try { setSnapshot(await request()); syncScopes(); render(); } catch { /* Keep the editable form when the refresh is unavailable. */ }
        }
      } finally {
        saving = false;
        dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
        syncControls();
      }
    });
    if (!dialog.open) dialog.showModal();
    syncControls();
  }

  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog || saving) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });

  function field(label, name, value = '', {area = false, required = false, max = 8000, hint = '', rows = 3} = {}) {
    const id = `knowledge-field-${name}`;
    return `<div class="knowledge-field"><label for="${id}">${escape(label)}</label>${area ? `<textarea id="${id}" name="${name}" rows="${rows}" maxlength="${max}"${required ? ' required' : ''}${hint ? ` aria-describedby="${id}-hint"` : ''}>${escape(value)}</textarea>` : `<input id="${id}" name="${name}" value="${escape(value)}" maxlength="${max}"${required ? ' required' : ''}${hint ? ` aria-describedby="${id}-hint"` : ''}>`}${hint ? `<p id="${id}-hint" class="knowledge-hint">${escape(hint)}</p>` : ''}</div>`;
  }

  function sharingFields(item) {
    const home = item.scopeId || currentScope;
    if (isShared(scopeFor(home))) return '<div class="knowledge-notice">Questa voce appartiene al profilo comune: è disponibile in tutti gli ambiti.</div>';
    const scopes = snapshot.scopes.filter(scope => scope.id !== home && !isShared(scope));
    return `<fieldset class="knowledge-sharing"><legend>Disponibile anche in</legend><p class="knowledge-hint">Scegli i collegamenti espliciti. Il contenuto completo sarà disponibile anche negli ambiti selezionati.</p><div class="knowledge-check-grid">${scopes.map(scope => `<label><input type="checkbox" name="sharedWith" value="${escape(scope.id)}"${(item.sharedWith || []).includes(scope.id) ? ' checked' : ''}><span>${escape(scope.name)}${scope.parentId ? `<small>${escape(scopeName(scope.parentId))}</small>` : ''}</span></label>`).join('')}</div></fieldset>`;
  }

  function sourceFields(item) {
    return field('Provenienza', 'source', item.source || 'Annotazione manuale', {max:500,hint:'Indica il messaggio, il documento o l’esperienza da cui proviene questa voce.'});
  }

  async function save(action, payload, message) {
    setSnapshot(await request(action, payload));
    syncScopes();
    render();
    toast(message);
  }

  function openMemory(item = {}) {
    if (locked()) return;
    const home = item.scopeId || currentScope;
    const state = item.status || 'confirmed';
    const body = `<p class="knowledge-form-intro">Salvata in <strong>${escape(scopeName(home))}</strong>${item.id ? ` · versione ${escape(item.version || 1)}` : ''}. Una memoria confermata può essere usata come contesto dal team.</p>${field('Titolo', 'title', item.title, {required:true,max:140})}<div class="knowledge-form-grid"><div class="knowledge-field"><label for="knowledge-field-type">Tipo</label><select id="knowledge-field-type" name="type">${Object.entries(typeNames).map(([value,label]) => `<option value="${value}"${value === (item.type || 'fact') ? ' selected' : ''}>${label}</option>`).join('')}</select></div><div class="knowledge-field"><label for="knowledge-field-status">Stato</label><select id="knowledge-field-status" name="status"><option value="confirmed"${state === 'confirmed' ? ' selected' : ''}>Confermata da me</option><option value="proposed"${state === 'proposed' ? ' selected' : ''}>Proposta · da verificare</option></select></div></div>${field('Contenuto', 'content', item.content, {area:true,rows:6,required:true,hint:'Scrivi una regola o un’informazione precisa. Le proposte non vengono usate finché non le confermi.'})}${sourceFields(item)}${sharingFields({...item,scopeId:home})}<details class="knowledge-advanced"><summary>Accesso dei singoli agenti</summary><p class="knowledge-hint">Nessuna selezione: disponibile a tutto il team nell’ambito consentito. Seleziona nomi per limitarne l’uso.</p><div class="knowledge-check-grid">${agents.map(agent => `<label><input type="checkbox" name="agentIds" value="${escape(agent.id)}"${(item.agentIds || []).includes(agent.id) ? ' checked' : ''}><span>${escape(agent.name)}</span></label>`).join('')}</div></details>`;
    openDialog(item.id ? 'Rivedi la memoria' : 'Una cosa da ricordare', body, item.id ? 'Salva modifiche' : 'Salva memoria', async data => {
      await save('saveMemory', { ...(item.id ? {id:item.id,expectedVersion:item.version} : {}),scopeId:home,type:data.get('type'),title:data.get('title').trim(),content:data.get('content').trim(),status:data.get('status'),source:data.get('source').trim(),sharedWith:data.getAll('sharedWith'),agentIds:data.getAll('agentIds') }, 'Memoria salvata.');
    });
  }

  function stepMarkup(step = {}, index = 0) {
    return `<fieldset class="knowledge-step"><legend>Passaggio <span class="knowledge-step-number">${index + 1}</span></legend><div class="knowledge-step-heading"><div class="knowledge-field"><label>Titolo<input name="stepTitle" value="${escape(step.title || '')}" maxlength="140" required></label></div><div class="knowledge-field"><label>Responsabile<select name="stepAgent">${agents.map(agent => `<option value="${escape(agent.id)}"${agent.id === (step.agentId || 'nova') ? ' selected' : ''}>${escape(agent.name)}</option>`).join('')}</select></label></div></div><div class="knowledge-field"><label>Risultato del passaggio<input name="stepOutput" value="${escape(step.output || '')}" maxlength="2000" required></label></div><button type="button" class="knowledge-text-button is-danger" data-remove-step>Rimuovi passaggio</button></fieldset>`;
  }

  function openWorkflow(item = {}) {
    if (locked()) return;
    const home = item.scopeId || currentScope;
    const body = `<p class="knowledge-form-intro">Salvata in <strong>${escape(scopeName(home))}</strong>. La procedura guida la chat e può definire i passaggi di un incarico. Le capacità disponibili sono analisi e redazione; non esegue azioni esterne.</p>${field('Titolo', 'title', item.title, {required:true,max:140})}${field('A cosa serve', 'description', item.description, {area:true,max:2000,rows:2})}${field('Materiali e informazioni di partenza', 'input', item.input, {area:true,required:true,max:4000,rows:3,hint:'Esempio: idea di prodotto, obiettivo, destinatari, vincoli e scadenza.'})}<div class="knowledge-steps" id="knowledge-steps">${(item.steps?.length ? item.steps : [{}]).map(stepMarkup).join('')}</div><button type="button" class="knowledge-button" id="knowledge-add-step">＋ Aggiungi un passaggio</button>${field('Consegna finale attesa', 'output', item.output, {area:true,required:true,max:4000,rows:3})}<div class="knowledge-field"><label for="knowledge-field-status">Stato</label><select id="knowledge-field-status" name="status"><option value="draft"${item.status !== 'ready' ? ' selected' : ''}>Bozza · da rivedere</option><option value="ready"${item.status === 'ready' ? ' selected' : ''}>Pronta per chat e incarichi</option></select></div>${sourceFields(item)}${sharingFields({...item,scopeId:home})}`;
    openDialog(item.id ? 'Rivedi la procedura' : 'Un metodo da riutilizzare', body, item.id ? 'Salva modifiche' : 'Salva procedura', async data => {
      const titles = data.getAll('stepTitle'), owners = data.getAll('stepAgent'), outputs = data.getAll('stepOutput');
      await save('saveWorkflow', { ...(item.id ? {id:item.id,expectedVersion:item.version} : {}),scopeId:home,title:data.get('title').trim(),description:data.get('description').trim(),input:data.get('input').trim(),output:data.get('output').trim(),status:data.get('status'),source:data.get('source').trim(),sharedWith:data.getAll('sharedWith'),steps:titles.map((title,index) => ({title:title.trim(),agentId:owners[index],output:outputs[index].trim()})) }, 'Procedura salvata.');
    });
    const steps = dialog.querySelector('#knowledge-steps');
    const refreshSteps = () => {
      const rows = [...steps.querySelectorAll('.knowledge-step')];
      rows.forEach((row,index) => {
        row.querySelector('.knowledge-step-number').textContent = index + 1;
        row.querySelector('[data-remove-step]').disabled = rows.length === 1;
        row.querySelector('[data-remove-step]').setAttribute('aria-label', `Rimuovi passaggio ${index + 1}`);
      });
      dialog.querySelector('#knowledge-add-step').disabled = rows.length >= 12;
    };
    dialog.querySelector('#knowledge-add-step').addEventListener('click', () => {
      if (saving || steps.children.length >= 12) return;
      steps.insertAdjacentHTML('beforeend', stepMarkup({}, steps.children.length));
      refreshSteps();
      steps.lastElementChild.querySelector('input').focus();
    });
    steps.addEventListener('click', event => {
      const button = event.target.closest('[data-remove-step]');
      if (!button || saving || steps.children.length <= 1) return;
      button.closest('.knowledge-step').remove();
      refreshSteps();
    });
    refreshSteps();
  }

  function openScope() {
    if (locked()) return;
    const validParents = kind => snapshot.scopes.filter(scope => !isShared(scope) && scope.kind !== 'archive' && (kind !== 'client' || ['business','development','consulting'].includes(scope.kind)));
    const kind = 'project';
    const scopes = validParents(kind);
    const body = '<p class="knowledge-form-intro">Crea uno spazio dedicato a un tuo progetto. Puoi creare anche un ambito per la consulenza. Le sue memorie restano separate: i collegamenti con gli altri ambiti si scelgono voce per voce.</p>' + field('Nome', 'name', '', {required:true,max:100}) + `<div class="knowledge-form-grid"><div class="knowledge-field"><label for="knowledge-field-kind">Tipo di spazio</label><select id="knowledge-field-kind" name="kind"><option value="client"${kind === 'client' ? ' selected' : ''}>Cliente</option><option value="project"${kind === 'project' ? ' selected' : ''}>Progetto</option></select></div><div class="knowledge-field"><label for="knowledge-field-parent">Organizzato sotto</label><select id="knowledge-field-parent" name="parentId">${scopeOptions(scopes.some(scope => scope.id === currentScope) ? currentScope : scopes[0]?.id, scopes)}</select></div></div><p class="knowledge-hint">L’organizzazione sotto un altro ambito non condivide automaticamente le informazioni.</p>`;
    openDialog('Un nuovo spazio di lavoro', body, 'Crea e apri lo spazio', async data => {
      const before = new Set(snapshot.scopes.map(scope => scope.id));
      setSnapshot(await request('createScope', {name:data.get('name').trim(),kind:data.get('kind'),parentId:data.get('parentId')}));
      syncScopes();
      render();
      const created = snapshot.scopes.find(scope => !before.has(scope.id));
      if (created) {
        try { await onScopeChange(created.id); setScope(created.id); }
        catch { toast('Spazio creato. Selezionalo dal menu per aprirne la conversazione.'); return; }
      }
      toast('Spazio creato. La sua memoria è separata.');
    });
    dialog.querySelector('[name="kind"]').addEventListener('change', event => {
      const parent = dialog.querySelector('[name="parentId"]');
      const options = validParents(event.target.value);
      parent.innerHTML = scopeOptions(options.some(scope => scope.id === parent.value) ? parent.value : options[0]?.id, options);
    });
  }

  function openHistory(item) {
    const revisions = [...(item.revisions || [])].reverse();
    const body = `<p class="knowledge-form-intro"><strong>${escape(item.title)}</strong> · versione attuale ${escape(item.version || 1)}. Le revisioni conservano i contenuti precedenti.</p>${revisions.length ? revisions.map((entry,index) => {
      const revision = entry.snapshot || entry;
      return `<details class="knowledge-revision"${index === 0 ? ' open' : ''}><summary>Versione ${escape(revision.version || entry.version || revisions.length - index)}${revision.updatedAt || entry.at ? ` · ${escape(formattedDate(revision.updatedAt || entry.at))}` : ''}</summary><h3>${escape(revision.title || item.title)}</h3><p class="knowledge-revision-content">${escape(revision.content || revision.description || '')}</p>${revision.input ? `<h4>Materiali di partenza</h4><p class="knowledge-revision-content">${escape(revision.input)}</p>` : ''}${revision.steps?.length ? `<ol>${revision.steps.map(step => `<li><strong>${escape(step.title)}</strong> · ${escape(agents.find(agent => agent.id === step.agentId)?.name || step.agentId)}<p>${escape(step.output || '')}</p></li>`).join('')}</ol>` : ''}${revision.output ? `<h4>Consegna</h4><p class="knowledge-revision-content">${escape(revision.output)}</p>` : ''}<p class="knowledge-hint">Fonte: ${escape(revision.source || 'Annotazione manuale')} · Stato: ${escape(({confirmed:'confermata',proposed:'proposta',draft:'bozza',ready:'pronta'})[revision.status] || revision.status || '—')}</p>${revision.sharedWith?.length ? `<p class="knowledge-hint">Disponibile anche in ${escape(revision.sharedWith.map(scopeName).join(', '))}</p>` : ''}</details>`;
    }).join('') : '<div class="knowledge-empty"><h3>Questa è la prima versione.</h3><p>Le modifiche future saranno conservate qui.</p></div>'}`;
    openDialog('La storia di questa voce', body);
    dialog.querySelector('[data-close]').textContent = 'Chiudi';
  }

  function openDelete(item) {
    if (locked()) return;
    const memory = activeTab === 'memories';
    openDialog(memory ? 'Elimina questa memoria?' : 'Elimina questa procedura?', `<p class="knowledge-form-intro"><strong>${escape(item.title)}</strong></p><p>La voce e le sue revisioni saranno rimosse da <strong>${escape(scopeName(item.scopeId))}</strong>${item.sharedWith?.length || isShared(scopeFor(item.scopeId)) ? ' e dagli ambiti in cui è disponibile' : ''}. I messaggi originali in chat restano conservati.</p>`, 'Elimina definitivamente', async () => {
      await save(memory ? 'deleteMemory' : 'deleteWorkflow', {id:item.id}, memory ? 'Memoria eliminata.' : 'Procedura eliminata.');
    });
    dialog.querySelector('button[type="submit"]').classList.add('is-danger-button');
    dialog.querySelector('[data-close]').focus();
  }

  async function confirmMemory(item) {
    if (locked()) return;
    openDialog('Conferma questa memoria', `<p class="knowledge-form-intro">Confermando rendi questa informazione disponibile al team in <strong>${escape(scopeName(item.scopeId))}</strong>${item.sharedWith?.length ? ` e in ${escape(item.sharedWith.map(scopeName).join(', '))}` : ''}.</p><h3>${escape(item.title)}</h3><p class="knowledge-revision-content">${escape(item.content)}</p><p class="knowledge-hint">Fonte: ${escape(item.source || 'Annotazione manuale')}</p>`, 'Conferma memoria', async () => {
      await save('saveMemory', {id:item.id,status:'confirmed',expectedVersion:item.version}, 'Memoria confermata. Ora è disponibile al team.');
    });
  }

  async function useWorkflow(item) {
    if (locked() || item.status !== 'ready') return;
    const prompt = `Vorrei usare la procedura «${item.title}».\n\nMateriali e informazioni necessari:\n${item.input || 'Da definire insieme.'}\n\nAiutami a raccogliere gli elementi mancanti e ad applicarla al mio caso. Non dare per eseguite azioni esterne.`;
    try { await onUseWorkflow({scopeId:currentScope,workflowId:item.id,prompt}); }
    catch (error) { toast(error.message || 'Non è stato possibile preparare la procedura in chat.'); }
  }

  function captureMessage(message) {
    if (locked()) { toast('Attendi che lo studio sia pronto prima di salvare una memoria.'); return; }
    const content = String(message.content ?? message.text ?? message.body ?? '').slice(0,8000);
    if (!content.trim()) return;
    openMemory({scopeId:currentScope,title:short(content.split('\n').find(line => line.trim()) || 'Dalla conversazione',100),content,status:'proposed',type:'fact',source:`Messaggio ${message.id || ''}`.trim(),sharedWith:[],agentIds:[]});
  }

  panel.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]');
    if (tab) { activeTab = tab.dataset.tab; render(); return; }
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'retry') { load({scopeId:currentScope}); return; }
    if (action === 'new-scope') { openScope(); return; }
    if (action === 'new-entry') { activeTab === 'memories' ? openMemory() : openWorkflow(); return; }
    const item = snapshot[activeTab].find(entry => entry.id === button.dataset.id);
    if (!item) return;
    if (action === 'edit') activeTab === 'memories' ? openMemory(item) : openWorkflow(item);
    if (action === 'history') openHistory(item);
    if (action === 'delete') openDelete(item);
    if (action === 'confirm') confirmMemory(item);
    if (action === 'use') useWorkflow(item);
  });
  panel.querySelector('[role="tablist"]').addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    activeTab = event.key === 'Home' ? 'memories' : event.key === 'End' ? 'workflows' : activeTab === 'memories' ? 'workflows' : 'memories';
    render();
    $(`[data-tab="${activeTab}"]`).focus();
  });
  $('#knowledge-search').addEventListener('input', event => { query = event.target.value; render(); });
  $('#knowledge-scope').addEventListener('change', event => { changeScope(event.target.value); });
  chatScope.querySelector('select').addEventListener('change', event => { changeScope(event.target.value); });

  return { load, setScope, setBusy(value) { busy = Boolean(value); syncControls(); }, captureMessage };
}
