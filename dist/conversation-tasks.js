import {agents} from './data.js';
import {t, ui, locale, onLanguageChange} from './i18n.js';

const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const name = id => agents.find(agent => agent.id === id)?.name || t('Tu');
const date = value => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(locale(), {dateStyle:'medium',timeStyle:'short'}).format(parsed) : '';
};

export function createConversationTasks({onCreated = async () => {}, onProjectsChanged = () => {}, toast = () => {}} = {}) {
  const dialog = document.createElement('dialog');
  dialog.id = 'conversation-task-dialog';
  dialog.className = 'ops-dialog conversation-task-dialog';
  dialog.setAttribute('aria-labelledby', 'conversation-task-title');
  document.body.append(dialog);
  let source = null, draft = null, values = {}, projectTitle = '', projectMode = false;
  let busy = false, saving = false, expiredSession = false, sourceChanged = false, projectUncertain = false, pendingRequest = null, error = '', expiryTimer = null;
  const sameSource = value => source && ['scopeId','conversationId','messageId'].every(key => source[key] === value[key]);
  const expired = () => draft && Date.parse(draft.expiresAt) <= Date.now();

  async function request(path, body) {
    const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify(body)});
    let value;
    try { value = await response.json(); }
    catch { throw Error(t('Lo studio non ha risposto correttamente. Riprova per verificare il salvataggio.')); }
    if (expiredSession) throw Object.assign(Error(t('Sessione scaduta.')), {status:401});
    if (!response.ok) throw Object.assign(Error(t(value.error || 'Non è stato possibile preparare l’incarico.')), {status:response.status});
    return value;
  }
  function capture() {
    for (const input of dialog.querySelectorAll('[data-task-field]')) values[input.name] = input.value;
    const input = dialog.querySelector('#conversation-project-title');
    if (input) projectTitle = input.value;
  }
  function sync() {
    dialog.setAttribute('aria-busy', String(saving));
    dialog.querySelectorAll('[data-task-field],#conversation-project-title').forEach(input => { input.disabled = saving || Boolean(pendingRequest); });
    dialog.querySelectorAll('[data-conversation-action]').forEach(button => {
      const action = button.dataset.conversationAction;
      button.disabled = saving || (action !== 'close' && (busy || Boolean(pendingRequest)));
    });
    const submit = dialog.querySelector('[form="conversation-task-form"]');
    if (submit) submit.disabled = saving || busy || !draft || (!pendingRequest && (expired() || sourceChanged || !draft.projects.length || !draft.agentIds.length));
    const projectSubmit = dialog.querySelector('#conversation-project-form button[type="submit"]');
    if (projectSubmit) projectSubmit.disabled = saving || busy || projectUncertain || Boolean(pendingRequest);
  }
  function render({captureValues = true} = {}) {
    if (expiredSession) return;
    if (captureValues) capture();
    const active = dialog.contains(document.activeElement) ? document.activeElement.id : null;
    const scroll = dialog.scrollTop;
    const stale = expired() && !pendingRequest;
    dialog.innerHTML = ui`<div class="ops-dialog-heading"><div><div class="eyebrow">DALLA CONVERSAZIONE AL LAVORO</div><h2 id="conversation-task-title">Prepara un incarico</h2></div><button type="button" class="ops-icon" data-conversation-action="close" aria-label="Chiudi finestra">✕</button></div>
      <div class="ops-form-body conversation-task-body">
        <p class="ops-form-intro">Trasforma questo messaggio in un risultato da consegnare. Rivedi il brief e scegli a chi affidarlo.</p>
        ${draft ? ui`<div class="conversation-task-source"><span aria-hidden="true">↳</span><div><strong>${draft.source.agentId ? t('Messaggio di {name}',{name:html(name(draft.source.agentId))}) : t('Messaggio salvato')}</strong>${draft.source.createdAt ? ui`<span>${html(date(draft.source.createdAt))}</span>` : ''}<p>Origine e permessi del contesto restano collegati all’incarico.</p></div></div>` : ''}
        ${saving && !draft ? ui`<p role="status">Preparazione dei materiali…</p>` : ''}
        ${draft ? ui`<form id="conversation-task-form" class="conversation-task-fields">
          <div class="ops-form-grid">
            <div class="ops-field"><label for="conversation-task-project">Progetto</label><select id="conversation-task-project" name="projectId" data-task-field required>${draft.projects.length ? draft.projects.map(project => ui`<option value="${html(project.id)}"${values.projectId === project.id ? ' selected' : ''}>${html(project.title)}</option>`).join('') : ui`<option value="">Crea un progetto in questo ambito</option>`}</select></div>
            <div class="ops-field"><label for="conversation-task-agent">Responsabile</label><select id="conversation-task-agent" name="agentId" data-task-field required>${draft.agentIds.length ? draft.agentIds.map(id => ui`<option value="${html(id)}"${values.agentId === id ? ' selected' : ''}>${html(name(id))}</option>`).join('') : ui`<option value="">Nessun agente autorizzato</option>`}</select></div>
          </div>
          <p class="ops-hint">Puoi scegliere i tuoi progetti di questo ambito e gli agenti autorizzati a ricevere il contesto originale.</p>
          <div class="conversation-task-project-actions"><button type="button" class="ops-text-button" data-conversation-action="project">＋ Crea un progetto qui</button><button type="button" class="ops-text-button" data-conversation-action="refresh">Aggiorna progetti e permessi</button></div>
          <div class="ops-field"><label for="conversation-task-name">Titolo dell’incarico</label><input id="conversation-task-name" name="title" data-task-field value="${html(values.title)}" required maxlength="160" autocomplete="off"></div>
          <div class="ops-field"><label for="conversation-task-brief">Risultato richiesto e materiali</label><textarea id="conversation-task-brief" name="brief" data-task-field rows="9" required maxlength="16000" aria-describedby="conversation-task-brief-help">${html(values.brief)}</textarea><p id="conversation-task-brief-help" class="ops-hint">Il messaggio completo è il punto di partenza. Specifica il risultato atteso, i vincoli e come valutarlo.</p></div>
        </form>
        ${projectMode || !draft.projects.length ? ui`<form id="conversation-project-form" class="conversation-task-project-form"><h3>Un progetto per questo lavoro</h3><p>Verrà creato come tuo progetto, nello stesso ambito della conversazione. Il brief resta qui.</p><div class="ops-field"><label for="conversation-project-title">Nome del progetto</label><input id="conversation-project-title" name="title" value="${html(projectTitle)}" maxlength="100" required autocomplete="off"></div><button type="submit" class="ops-button">Crea progetto e continua</button></form>` : ''}
        <div class="conversation-task-assurance"><span aria-hidden="true">✓</span><p><strong>Salvare non avvia l’AI.</strong> L’incarico resta in coda: controllerai contesto e servizio prima di avviarlo.</p></div>` : ''}
        ${projectUncertain ? ui`<p class="conversation-task-notice" role="status">Il progetto potrebbe essere già stato creato. Aggiorna l’elenco prima di riprovare.</p>` : ''}
        ${sourceChanged ? ui`<button type="button" class="ops-button" data-conversation-action="restart">Riparti dal messaggio aggiornato</button>` : ''}
        ${stale ? ui`<p class="conversation-task-notice" role="status">La verifica è scaduta. Aggiornala per ricontrollare i permessi: le tue modifiche restano qui.</p>` : ''}
        ${pendingRequest ? ui`<p class="conversation-task-notice" role="status">La conferma del salvataggio non è arrivata. Riprova con gli stessi dati: non verrà creato un duplicato.</p>` : ''}
        ${busy ? ui`<p class="ops-hint" role="status">Attendi la fine del lavoro in corso prima di salvare.</p>` : ''}
        <p class="ops-form-error conversation-task-error" role="alert"${error ? '' : ' hidden'}>${html(error)}</p>
      </div>
      <div class="ops-dialog-footer"><button type="button" class="ops-button" data-conversation-action="close">Chiudi</button>${!draft || stale ? ui`<button type="button" class="ops-button" data-conversation-action="refresh">Aggiorna verifica</button>` : ''}${draft ? ui`<button type="submit" form="conversation-task-form" class="ops-button is-primary">${saving ? t('Salvataggio…') : pendingRequest ? t('Verifica il salvataggio') : t('Crea incarico da avviare')}</button>` : ''}</div>`;
    sync();
    dialog.querySelector('#conversation-task-form')?.addEventListener('submit', save);
    dialog.querySelector('#conversation-project-form')?.addEventListener('submit', createProject);
    if (active) dialog.querySelector(`#${CSS.escape(active)}`)?.focus({preventScroll:true});
    dialog.scrollTop = scroll;
    clearTimeout(expiryTimer);
    if (draft && !expired()) expiryTimer = setTimeout(() => { if (dialog.open && !saving) render(); }, Math.min(Date.parse(draft.expiresAt) - Date.now() + 20, 2147483647));
  }
  async function refresh({preserve = true, projectId} = {}) {
    if (saving || busy || pendingRequest || !source) return;
    capture();saving = true;error = '';render();
    try {
      const next = await request('/api/conversation/task-preview', source);
      if (!next?.id || !next.source || !Array.isArray(next.projects) || !Array.isArray(next.agentIds)) throw Error(t('Lo studio ha restituito una bozza non valida.'));
      if (preserve && draft?.sourceDigest && next.sourceDigest !== draft.sourceDigest) {sourceChanged = true;throw Error(t('Il messaggio originale è cambiato. Riparti dal testo aggiornato per ricontrollare il brief.'));}
      draft = next;sourceChanged = false;projectUncertain = false;
      if (!preserve) values = {title:next.title,brief:next.brief};
      values.projectId = next.projects.some(item => item.id === (projectId || values.projectId)) ? projectId || values.projectId : next.projects[0]?.id || '';
      values.agentId = next.agentIds.includes(values.agentId) ? values.agentId : next.agentId || next.agentIds[0] || '';
    } catch (failure) { error = failure.message; }
    finally { saving = false;render({captureValues:false}); }
  }
  async function save(event) {
    event.preventDefault();
    if (saving || busy || !draft || (!pendingRequest && (expired() || sourceChanged)) || !event.currentTarget.reportValidity()) return;
    capture();
    pendingRequest ||= {draftId:draft.id,projectId:values.projectId,title:values.title.trim(),brief:values.brief.trim(),agentId:values.agentId};
    saving = true;error = '';render();
    try {
      const result = await request('/api/conversation/task', pendingRequest);
      if (!result?.taskId) throw Error(t('Lo studio non ha risposto correttamente. Riprova per verificare il salvataggio.'));
      pendingRequest = null;dialog.close();draft = null;source = null;values = {};
      toast(t('Incarico creato. Rivedi il contesto quando vuoi avviare il lavoro.'));
      try { await onCreated(result); } catch { toast(t('Incarico salvato. Apri Progetti e aggiorna per visualizzarlo.')); }
    } catch (failure) {
      if (failure.status >= 400 && failure.status < 500) pendingRequest = null;
      error = failure.message;
    } finally { saving = false;if (dialog.open) render(); }
  }
  async function createProject(event) {
    event.preventDefault();
    if (saving || busy || pendingRequest || projectUncertain || !event.currentTarget.reportValidity()) return;
    capture();saving = true;error = '';render();
    let createdId;
    try {
      const result = await request('/api/operations', {action:'createProject',payload:{title:projectTitle.trim(),description:'',scopeId:source.scopeId,kind:'owned',createScope:false}});
      const previous = new Set(draft.projects.map(project => project.id));
      createdId = result.projects?.filter(project => project.scopeId === source.scopeId && project.kind === 'owned' && !previous.has(project.id) && project.title === projectTitle.trim()).sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0]?.id;
      projectTitle = '';projectMode = false;void onProjectsChanged();
    } catch (failure) { error = failure.message;projectUncertain = !(failure.status >= 400 && failure.status < 500); }
    finally { saving = false;render({captureValues:false}); }
    if (!error) await refresh({projectId:createdId});
  }
  dialog.addEventListener('click', event => {
    const button = event.target.closest('[data-conversation-action]');
    if (!button || button.disabled || saving) return;
    const action = button.dataset.conversationAction;
    if (action === 'close') dialog.close();
    else if (action === 'refresh') void refresh({preserve:Boolean(draft)});
    else if (action === 'restart') void refresh({preserve:false});
    else if (action === 'project') {projectMode = !projectMode;render();if (projectMode) dialog.querySelector('#conversation-project-title')?.focus();}
  });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {capture();clearTimeout(expiryTimer);});
  onLanguageChange(() => {if (dialog.open) render();});
  window.addEventListener('studio-session-expired', () => {expiredSession = true;dialog.close();dialog.replaceChildren();source = draft = pendingRequest = null;values = {};projectTitle = '';});
  return {
    async open(value) {
      if (busy || saving || expiredSession) return;
      if (!sameSource(value) && !pendingRequest) {
        dialog.replaceChildren();source = {...value};draft = null;values = {};projectTitle = '';projectMode = false;sourceChanged = false;projectUncertain = false;error = '';
      }
      render();if (!dialog.open) dialog.showModal();
      if (!draft) await refresh({preserve:false});
    },
    setBusy(value) {busy = Boolean(value);if (dialog.open) render();},
  };
}
