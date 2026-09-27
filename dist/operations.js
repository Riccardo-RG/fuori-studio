import { agents } from './data.js';

const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const shorten = (value, max = 230) => String(value ?? '').length > max ? `${String(value).slice(0, max).trimEnd()}…` : String(value ?? '');
const states = {queued:'Da avviare',running:'In lavorazione',paused:'In pausa',review:'Da approvare',completed:'Approvato',failed:'Da riprendere',pending:'In attesa',approved:'Approvata',changes_requested:'Da rivedere',rejected:'Da rivedere'};
const providerTypes = {codex:'Codex locale',openrouter:'OpenRouter',openai:'OpenAI',anthropic:'Anthropic',deepseek:'DeepSeek'};
const date = value => {
  const parsed = new Date(value);
  return value && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('it-IT',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(parsed) : 'Da definire';
};
const localDate = value => {
  const parsed = new Date(value || Date.now() + 86400000);
  if (!Number.isFinite(parsed.getTime())) return '';
  return `${parsed.getFullYear()}-${String(parsed.getMonth()+1).padStart(2,'0')}-${String(parsed.getDate()).padStart(2,'0')}T${String(parsed.getHours()).padStart(2,'0')}:${String(parsed.getMinutes()).padStart(2,'0')}`;
};

export function createOperationsPanel({toast = () => {},onScopeChange = async () => {},onRefreshMemory = async () => {},onProviderChange = async () => {},onActivity = () => {}} = {}) {
  const panel = document.createElement('section');
  panel.id = 'operations-panel';
  panel.className = 'operations-panel';
  panel.setAttribute('aria-labelledby','operations-title');
  panel.innerHTML = `<div class="ops-heading"><div><div class="eyebrow">DA UN’IDEA A UNA CONSEGNA</div><h2 id="operations-title">Il lavoro che porti avanti.</h2><p>Progetti, incarichi e decisioni. Con un filo che rimane.</p></div><div class="ops-heading-actions"><button type="button" class="ops-icon" data-action="refresh" aria-label="Aggiorna progetti e attività" title="Aggiorna">↻</button><button type="button" class="ops-button is-primary" data-action="new-project" data-mutation>＋ Nuovo progetto</button></div></div><div class="ops-toolbar"><div class="ops-tabs" role="tablist" aria-label="Gestione dello studio"><button type="button" role="tab" id="ops-tab-projects" data-tab="projects" aria-selected="true" aria-controls="ops-content">Progetti <span data-count="projects">0</span></button><button type="button" role="tab" id="ops-tab-review" data-tab="review" aria-selected="false" aria-controls="ops-content" tabindex="-1">Da decidere <span data-count="review">0</span></button><button type="button" role="tab" id="ops-tab-routines" data-tab="routines" aria-selected="false" aria-controls="ops-content" tabindex="-1">Routine <span data-count="routines">0</span></button><button type="button" role="tab" id="ops-tab-providers" data-tab="providers" aria-selected="false" aria-controls="ops-content" tabindex="-1">Servizi AI</button></div><div class="ops-filter"><label for="ops-scope-filter" class="visually-hidden">Ambiti mostrati</label><select id="ops-scope-filter"><option value="current">Ambito attuale</option><option value="all">Tutti gli ambiti</option></select></div></div><div class="ops-status" role="status" aria-live="polite">Caricamento dei progetti…</div><div id="ops-content" class="ops-content" role="tabpanel" aria-labelledby="ops-tab-projects" tabindex="0"></div><p class="ops-footnote">Gli incarichi generano bozze dai materiali forniti. Ogni avvio è esplicito; approvi tu le consegne.</p>`;
  const insertion = document.querySelector('#knowledge-panel') || document.querySelector('.team-section') || document.querySelector('main footer');
  if (insertion) insertion.before(panel); else document.querySelector('main')?.append(panel);
  const dialog = document.createElement('dialog');
  dialog.id = 'operations-dialog';
  dialog.className = 'ops-dialog';
  dialog.setAttribute('aria-labelledby','ops-dialog-title');
  document.body.append(dialog);

  let operations = {projects:[],tasks:[],routines:[]}, workspace = {scopes:[],workflows:[]}, providers = {connections:[],assignments:{},policies:{}};
  let tab = 'projects',scopeId = 'business',filter = 'current',projectId = null,busy = false,loading = true,mutating = false,loadError = '',pollTimer = null,polling = false,loadNumber = 0;
  let dialogView = null,artifactSelection = new Map();
  const $ = selector => panel.querySelector(selector);
  const projectFor = id => operations.projects.find(project => project.id === id);
  const taskFor = id => operations.tasks.find(task => task.id === id);
  const scopeName = id => workspace.scopes.find(scope => scope.id === id)?.name || id || 'Ambito';
  const agentName = id => agents.find(agent => agent.id === id)?.name || id || 'Riccardo';
  const connectionName = id => providers.connections.find(connection => connection.id === id)?.name || (id === 'codex' ? 'Codex locale' : id) || 'Non assegnato';
  const locked = () => busy || loading || mutating || Boolean(loadError);
  const allowedProject = project => project && (filter === 'all' || project.scopeId === scopeId);
  const visibleProjects = () => operations.projects.filter(allowedProject).sort((a,b) => Number(b.kind === 'owned')-Number(a.kind === 'owned') || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const projectTasks = id => operations.tasks.filter(task => task.projectId === id).sort((a,b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  const artifacts = task => Array.isArray(task.artifacts) ? task.artifacts : [];
  const activeTask = task => task.status === 'running';
  const needsDecision = task => ['review','failed','paused'].includes(task.status);
  const state = value => states[value] || value || 'Da avviare';
  const badge = (value,label) => `<span class="ops-state state-${html(value || 'queued')}">${html(label || state(value))}</span>`;
  const scopeOptions = (selected,scopes = workspace.scopes.filter(scope => !['shared','archive'].includes(scope.kind))) => scopes.map(scope => `<option value="${html(scope.id)}"${selected === scope.id ? ' selected' : ''}>${html(scope.name)}</option>`).join('');
  const agentOptions = selected => agents.map(agent => `<option value="${html(agent.id)}"${agent.id === (selected || 'nova') ? ' selected' : ''}>${html(agent.name)}</option>`).join('');
  const workflowOptions = (project,selected) => `<option value="">Incarico libero</option>${workspace.workflows.filter(workflow => workflow.status === 'ready' && (workflow.scopeId === project?.scopeId || workflow.scopeId === 'shared' || workflow.sharedWith?.includes(project?.scopeId))).map(workflow => `<option value="${html(workflow.id)}"${workflow.id === selected ? ' selected' : ''}>${html(workflow.title)}</option>`).join('')}`;
  const taskWorkflowOptions = project => `<option value="__product__" selected>Dal brief alla proposta di prodotto · 4 agenti</option><option value="__single__">Un incarico al solo responsabile</option>${workflowOptions(project).replace('<option value="">Incarico libero</option>','')}`;
  const projectOptions = selected => operations.projects.slice().sort((a,b)=>Number(b.kind === 'owned')-Number(a.kind === 'owned')).map(project => `<option value="${html(project.id)}"${project.id === selected ? ' selected' : ''}>${html(project.title)} · ${html(scopeName(project.scopeId))}</option>`).join('');

  async function request(path,body) {
    const response = await fetch(path,body ? {method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify(body)} : {cache:'no-store'});
    let value;
    try { value = await response.json(); } catch { throw Error('Lo studio non ha risposto correttamente. Verifica che il server sia avviato.'); }
    if (!response.ok) {
      const error = Error(value.error || 'Non è stato possibile completare l’operazione.');
      error.status = response.status;
      throw error;
    }
    return value;
  }
  function acceptOperations(value) {
    if (!value || !Array.isArray(value.projects) || !Array.isArray(value.tasks) || !Array.isArray(value.routines)) throw Error('I dati dei progetti non sono validi. Riprova a caricarli.');
    operations = value;
    onActivity(operations);
  }
  function acceptProviders(value) {
    if (!value || !Array.isArray(value.connections)) throw Error('I servizi AI non sono disponibili. Riprova.');
    providers = {...value,assignments:value.assignments || {},policies:value.policies || {}};
  }
  function syncLocks() {
    panel.setAttribute('aria-busy',String(loading));
    panel.querySelectorAll('[data-mutation]').forEach(element => {element.disabled = locked();});
    panel.querySelectorAll('[data-action="refresh"]').forEach(element => {element.disabled = loading || mutating;});
    if (dialog.open) dialog.querySelectorAll('[data-mutation],button[type="submit"]').forEach(element => {element.disabled = locked();});
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (document.visibilityState === 'visible' && operations.tasks.some(activeTask)) pollTimer = setTimeout(poll,3000);
  }
  async function poll() {
    if (polling || loading || mutating || document.visibilityState !== 'visible') {schedulePoll();return;}
    polling = true;
    try {
      acceptOperations(await request('/api/operations'));
      render();
      if (dialogView?.kind === 'task' && dialog.open) renderTaskDialog(dialogView.id);
    } catch { $('.ops-status').textContent = 'Aggiornamento temporaneamente interrotto. Il lavoro sul server può proseguire; usa Aggiorna per verificarlo.'; }
    finally {polling = false;schedulePoll();}
  }
  document.addEventListener('visibilitychange',schedulePoll);

  async function load() {
    const version = ++loadNumber;
    loading = true;loadError = '';render();
    try {
      const result = await Promise.all([request('/api/operations'),request('/api/workspace'),request('/api/providers')]);
      if (version !== loadNumber) return;
      acceptOperations(result[0]);
      if (!Array.isArray(result[1].scopes) || !Array.isArray(result[1].workflows)) throw Error('Gli ambiti dello studio non sono disponibili.');
      workspace = result[1];acceptProviders(result[2]);
      if (projectId && !projectFor(projectId)) projectId = null;
      loading = false;render();schedulePoll();
    } catch (error) {
      if (version !== loadNumber) return;
      loading = false;loadError = error.message;render();
    }
  }
  async function refreshOperations() {acceptOperations(await request('/api/operations'));render();schedulePoll();}
  async function operation(action,payload) {
    const value = await request('/api/operations',{action,payload});
    if (Array.isArray(value.projects)) acceptOperations(value); else await refreshOperations();
    render();schedulePoll();return value;
  }
  async function providerMutation(action,payload) {
    const value = await request('/api/providers',{action,payload});
    if (Array.isArray(value.connections)) acceptProviders(value); else acceptProviders(await request('/api/providers'));
    render();await onProviderChange();return value;
  }
  async function inlineMutation(callback) {
    if (locked()) return;
    mutating = true;syncLocks();
    try {await callback();} catch(error) {toast(error.message);} finally {mutating = false;syncLocks();schedulePoll();}
  }

  function empty(title,copy,action,label) {
    return `<div class="ops-empty"><span aria-hidden="true">◎</span><h3>${html(title)}</h3><p>${html(copy)}</p>${action ? `<button type="button" class="ops-button is-primary" data-action="${html(action)}" data-mutation>${html(label)}</button>` : ''}</div>`;
  }
  function taskRow(task,showProject = false) {
    const completedSteps = (task.steps || []).filter(step => ['completed','done'].includes(step.status)).length;
    const latest = artifacts(task).at(-1);
    return `<button type="button" class="ops-task-row" data-action="task" data-id="${html(task.id)}"><span class="ops-task-summary">${showProject ? `<small>${html(projectFor(task.projectId)?.title || 'Progetto')}</small>` : ''}<strong>${html(task.title)}</strong><span>${html(agentName(task.agentId))}${task.steps?.length ? ` · ${completedSteps}/${task.steps.length} passaggi` : ''}${latest ? ` · consegna v${html(latest.version || artifacts(task).length)}` : ''}</span></span><span class="ops-task-side">${badge(task.status)}<span aria-hidden="true">↗</span></span></button>`;
  }
  function projectCard(project) {
    const tasks = projectTasks(project.id),review = tasks.filter(task => task.status === 'review').length;
    return `<article class="ops-project-card"><div class="ops-card-top"><span class="ops-kind${project.kind === 'owned' ? ' is-owned' : ''}">${project.kind === 'owned' ? 'PROGETTO PROPRIO' : 'PER UN CLIENTE'}</span><span class="ops-scope-tag">${html(scopeName(project.scopeId))}</span></div><h3>${html(project.title)}</h3><p>${html(shorten(project.description || 'Aggiungi obiettivo e contesto per orientare i prossimi incarichi.'))}</p><div class="ops-project-stats"><span>${tasks.length} incarich${tasks.length === 1 ? 'o' : 'i'}</span><span${review ? ' class="has-review"' : ''}>${review ? `${review} da approvare` : tasks.some(activeTask) ? 'Il team è al lavoro' : tasks.some(task=>task.status === 'completed') ? 'Consegne conservate' : 'Pronto per il prossimo passo'}</span></div><div class="ops-card-actions"><button type="button" class="ops-button" data-action="project" data-id="${html(project.id)}">Apri progetto ↗</button><button type="button" class="ops-button is-primary" data-action="new-task" data-project-id="${html(project.id)}" data-mutation>＋ Incarico</button></div></article>`;
  }
  function projectsView() {
    const selected = projectFor(projectId);
    if (selected && allowedProject(selected)) {
      const tasks = projectTasks(selected.id);
      return `<div class="ops-project-detail"><button type="button" class="ops-text-button" data-action="back-projects">← Tutti i progetti</button><div class="ops-detail-heading"><div><span class="ops-kind${selected.kind === 'owned' ? ' is-owned' : ''}">${selected.kind === 'owned' ? 'PROGETTO PROPRIO' : 'PER UN CLIENTE'} · ${html(scopeName(selected.scopeId))}</span><h3>${html(selected.title)}</h3><p>${html(selected.description || '')}</p></div><button type="button" class="ops-button" data-action="edit-project" data-id="${html(selected.id)}" data-mutation>Modifica</button></div><div class="ops-detail-actions"><button type="button" class="ops-button is-primary" data-action="new-task" data-project-id="${html(selected.id)}" data-mutation>＋ Nuovo incarico</button><button type="button" class="ops-button" data-action="new-routine" data-project-id="${html(selected.id)}" data-mutation>Crea una routine</button><button type="button" class="ops-text-button" data-action="open-scope" data-id="${html(selected.scopeId)}" data-mutation>Apri questo ambito in chat ↗</button></div>${tasks.length ? `<div class="ops-task-list">${tasks.map(task => taskRow(task)).join('')}</div>` : empty('Il primo incarico fa partire il progetto.','Descrivi un risultato concreto e fornisci i materiali necessari. L’agente preparerà una bozza che potrai rivedere.')}</div>`;
    }
    const projects = visibleProjects();
    return projects.length ? `<div class="ops-project-grid">${projects.map(projectCard).join('')}</div>` : empty('Dai spazio a un tuo progetto.','Crea un progetto reale, chiarisci l’obiettivo e affidagli il primo incarico. Puoi tenere distinti i progetti personali e quelli dei clienti.','new-project','Crea il primo progetto');
  }
  function reviewView() {
    const tasks = operations.tasks.filter(task => needsDecision(task) && allowedProject(projectFor(task.projectId)));
    return tasks.length ? `<div class="ops-view-intro"><h3>Il prossimo passo spetta a te.</h3><p>Controlla le consegne da approvare e gli incarichi in pausa o interrotti. Puoi chiedere una revisione o riprendere il lavoro, conservando le versioni precedenti.</p></div><div class="ops-task-list">${tasks.map(task => taskRow(task,true)).join('')}</div>` : empty('Nessuna decisione in attesa.','Le consegne da controllare e gli incarichi che richiedono attenzione appariranno qui. I risultati approvati rimangono nel loro progetto.');
  }
  function routinesView() {
    const routines = operations.routines.filter(routine => allowedProject(projectFor(routine.projectId)));
    return `<div class="ops-view-intro"><div><h3>Un buon metodo, a intervalli regolari.</h3><p>Le routine preparano nuovi incarichi da avviare. Non chiamano automaticamente i modelli AI e non generano consumi da sole.</p></div><button type="button" class="ops-button is-primary" data-action="new-routine" data-mutation>＋ Nuova routine</button></div>${routines.length ? `<div class="ops-project-grid">${routines.map(routine => `<article class="ops-routine-card"><div class="ops-card-top"><span class="ops-scope-tag">${html(projectFor(routine.projectId)?.title || 'Progetto')}</span><span class="ops-state ${routine.enabled ? 'state-completed' : 'state-paused'}">${routine.enabled ? 'Attiva' : 'Sospesa'}</span></div><h3>${html(routine.title)}</h3><p>${html(shorten(routine.brief))}</p><dl class="ops-routine-facts"><div><dt>Responsabile</dt><dd>${html(agentName(routine.agentId))}</dd></div><div><dt>Frequenza</dt><dd>Ogni ${html(routine.intervalHours)} ore</dd></div><div><dt>Prossimo incarico</dt><dd>${routine.enabled ? html(date(routine.nextRunAt)) : 'Routine sospesa'}</dd></div></dl><div class="ops-card-actions"><button type="button" class="ops-button" data-action="edit-routine" data-id="${html(routine.id)}" data-mutation>Modifica</button><button type="button" class="ops-button" data-action="toggle-routine" data-id="${html(routine.id)}" data-mutation>${routine.enabled ? 'Sospendi' : 'Attiva'}</button></div></article>`).join('')}</div>` : empty('Le attività ricorrenti possono aspettarti già organizzate.','Una revisione settimanale, una verifica di progetto o la preparazione di un incontro: scegli cosa ricordare allo studio e quando.')}`;
  }
  function providersView() {
    const connections = providers.connections;
    const codex = connections.find(connection => connection.type === 'codex' || connection.id === 'codex');
    const effectivePolicy = providers.policies[scopeId] || (codex ? [codex.id] : ['codex']);
    return `<div class="ops-view-intro"><div><h3>Un team, diversi motori.</h3><p>Il ruolo dell’agente resta nello studio. Scegli il servizio che lo fa lavorare e in quali ambiti può ricevere informazioni.</p></div><button type="button" class="ops-button is-primary" data-action="new-provider" data-mutation>＋ Collega servizio</button></div><div class="ops-provider-grid">${connections.map(connection => `<article class="ops-provider-card"><div class="ops-card-top"><span class="ops-kind">${html(providerTypes[connection.type] || connection.type)}</span><span class="ops-state ${connection.configured ? 'state-completed' : 'state-paused'}">${connection.configured ? 'Configurato' : 'Da configurare'}</span></div><h3>${html(connection.name)}</h3><p class="ops-model-name">${html(connection.type === 'codex' || connection.id === 'codex' ? 'Modello della sessione Codex' : connection.model)}</p><p class="ops-provider-note">${connection.type === 'codex' ? 'Usa l’accesso Codex di questo computer.' : connection.hasKey ? 'Chiave salvata sul server locale. Non viene restituita al browser.' : 'Nessuna chiave API salvata.'}</p>${connection.type !== 'codex' ? `<div class="ops-card-actions"><button type="button" class="ops-button" data-action="edit-provider" data-id="${html(connection.id)}" data-mutation>Modifica</button><button type="button" class="ops-button" data-action="test-provider" data-id="${html(connection.id)}" data-mutation>Test a consumo</button><button type="button" class="ops-text-button is-danger" data-action="delete-provider" data-id="${html(connection.id)}" data-mutation>Rimuovi</button></div>` : ''}</article>`).join('')}</div><div class="ops-provider-settings"><section aria-labelledby="ops-assignments-title"><h3 id="ops-assignments-title">Il motore di ciascun agente</h3><p>Una connessione configurata può essere usata da più agenti. L’accesso effettivo dipende anche dall’ambito dell’incarico.</p><div class="ops-assignments">${agents.map(agent => `<label><span>${html(agent.name)}<small>${html(agent.role)}</small></span><select data-assignment="${html(agent.id)}" data-mutation aria-label="Servizio AI di ${html(agent.name)}">${connections.map(connection => `<option value="${html(connection.id)}"${(providers.assignments[agent.id] || codex?.id || 'codex') === connection.id ? ' selected' : ''}${!connection.configured && connection.type !== 'codex' ? ' disabled' : ''}>${html(connection.name)}</option>`).join('')}</select></label>`).join('')}</div></section><section aria-labelledby="ops-policy-title"><h3 id="ops-policy-title">Servizi consentiti per ${html(scopeName(scopeId))}</h3><p>Solo i servizi selezionati possono elaborare questo ambito. Le note condivise mantengono la regola dell’ambito di origine: un servizio esterno deve essere consentito in entrambi.</p><form id="ops-policy-form"><div class="ops-policy-options">${connections.map(connection => `<label><input type="checkbox" name="connectionIds" value="${html(connection.id)}"${effectivePolicy.includes(connection.id) ? ' checked' : ''}${!connection.configured && connection.type !== 'codex' ? ' disabled' : ''}><span>${html(connection.name)}<small>${html(providerTypes[connection.type] || connection.type)}</small></span></label>`).join('')}</div><button type="submit" class="ops-button" data-mutation>Salva servizi consentiti</button></form><p class="ops-small-note">Per modificare un altro ambito, selezionalo nel menu della chat. Le assegnazioni degli agenti sono comuni allo studio.</p></section></div>`;
  }
  function render() {
    const projects = visibleProjects();
    $('[data-count="projects"]').textContent = projects.length;
    $('[data-count="review"]').textContent = operations.tasks.filter(task => needsDecision(task) && allowedProject(projectFor(task.projectId))).length;
    $('[data-count="routines"]').textContent = operations.routines.filter(routine => allowedProject(projectFor(routine.projectId))).length;
    panel.querySelectorAll('[data-tab]').forEach(button => {const selected = button.dataset.tab === tab;button.setAttribute('aria-selected',String(selected));button.tabIndex = selected ? 0 : -1;});
    $('#ops-content').setAttribute('aria-labelledby',`ops-tab-${tab}`);
    $('#ops-scope-filter').hidden = tab === 'providers';
    $('#ops-scope-filter option[value="current"]').textContent = scopeName(scopeId);
    if (loading) {$('.ops-status').textContent = 'Caricamento dei progetti…';$('#ops-content').innerHTML = '';}
    else if (loadError) {$('.ops-status').textContent = loadError;$('#ops-content').innerHTML = empty('Non è stato possibile caricare lo studio.','Le informazioni salvate non sono state modificate. Usa il pulsante Aggiorna per riprovare.');}
    else {
      const running = operations.tasks.filter(activeTask).length;
      $('.ops-status').textContent = `${tab === 'providers' ? scopeName(scopeId) : filter === 'all' ? 'Tutti gli ambiti' : scopeName(scopeId)}${running ? ` · ${running} incarich${running === 1 ? 'o' : 'i'} in lavorazione · aggiornamento automatico` : ' · salvato sul tuo computer'}`;
      $('#ops-content').innerHTML = tab === 'projects' ? projectsView() : tab === 'review' ? reviewView() : tab === 'routines' ? routinesView() : providersView();
      if (operations.scheduler?.error) {
        const warning = document.createElement('p');warning.className='ops-error';warning.textContent=`Una routine richiede attenzione: ${operations.scheduler.error}`;
        $('#ops-content').prepend(warning);
      }
    }
    syncLocks();
  }

  function field(label,name,value = '',{area = false,required = false,max = 8000,type = 'text',hint = '',min,step} = {}) {
    const id = `ops-field-${name}`;
    return `<div class="ops-field"><label for="${id}">${html(label)}</label>${area ? `<textarea id="${id}" name="${name}" rows="5" maxlength="${max}"${required ? ' required' : ''}>${html(value)}</textarea>` : `<input id="${id}" name="${name}" type="${type}" value="${html(value)}"${['text','password'].includes(type) ? ` maxlength="${max}"` : ''}${required ? ' required' : ''}${min !== undefined ? ` min="${min}"` : ''}${type === 'number' ? ` max="${max}"` : ''}${step !== undefined ? ` step="${step}"` : ''}${type === 'password' ? ' autocomplete="off" spellcheck="false" data-secret' : ''}>`}${hint ? `<p class="ops-hint">${html(hint)}</p>` : ''}</div>`;
  }
  function dialogShell(title,body,footer) {
    dialog.innerHTML = `<div class="ops-dialog-heading"><div><div class="eyebrow">LO STUDIO OPERATIVO</div><h2 id="ops-dialog-title">${html(title)}</h2></div><button type="button" class="ops-icon" data-close aria-label="Chiudi finestra">✕</button></div>${body}<div class="ops-dialog-footer">${footer || '<button type="button" class="ops-button" data-close>Chiudi</button>'}</div>`;
    dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',() => {if (!mutating) dialog.close();}));
    if (!dialog.open) dialog.showModal();
    syncLocks();
  }
  function showForm(title,body,submitLabel,onSubmit,{danger = false,afterSave} = {}) {
    dialogView = {kind:'form'};
    dialogShell(title,`<form id="ops-dialog-form" class="ops-form"><div class="ops-form-body">${body}</div><p class="ops-form-error" role="alert" hidden></p></form>`,`<button type="button" class="ops-button" data-close>Annulla</button><button type="submit" form="ops-dialog-form" class="ops-button ${danger ? 'is-danger-button' : 'is-primary'}" data-mutation>${html(submitLabel)}</button>`);
    dialog.querySelector('form').addEventListener('submit',async event => {
      event.preventDefault();if (locked()) return;
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      const data = new FormData(form),errorBox = dialog.querySelector('.ops-form-error');
      errorBox.hidden = true;mutating = true;syncLocks();
      form.querySelectorAll('[data-secret]').forEach(input => {input.value = '';});
      try {
        await onSubmit(data,form);
        dialog.close();if (afterSave) afterSave();
      } catch(error) {
        errorBox.textContent = error.status === 409 ? `${error.message} Il modulo conserva i tuoi dati. Aggiorna il progetto prima di riprovare.` : error.message;
        errorBox.hidden = false;errorBox.scrollIntoView({block:'nearest'});
      } finally {data.delete('apiKey');mutating = false;syncLocks();schedulePoll();}
    });
  }
  dialog.addEventListener('cancel',event => {if (mutating) event.preventDefault();});
  dialog.addEventListener('close',() => {if (!dialog.open) {dialogView = null;dialog.querySelectorAll('[data-secret]').forEach(input => {input.value = '';});}});
  dialog.addEventListener('click',event => {
    if (event.target !== dialog || mutating) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });

  function projectForm(project = {}) {
    if (locked()) return;
    const selectedScope = workspace.scopes.some(scope => scope.id === (project.scopeId || scopeId) && !['shared','archive'].includes(scope.kind)) ? project.scopeId || scopeId : 'business';
    showForm(project.id ? 'Rivedi il progetto' : 'Un progetto da portare avanti',`<p class="ops-form-intro">Dagli un obiettivo riconoscibile. Gli incarichi e le consegne resteranno associati a questo progetto.</p>${field('Titolo','title',project.title,{required:true,max:project.id ? 160 : 100})}${field('Obiettivo e contesto','description',project.description,{area:true,max:8000})}<div class="ops-form-grid"><div class="ops-field"><label for="ops-field-kind">Tipo di progetto</label><select id="ops-field-kind" name="kind"><option value="owned"${project.kind !== 'client' ? ' selected' : ''}>Un mio progetto</option><option value="client"${project.kind === 'client' ? ' selected' : ''}>Lavoro per un cliente</option></select></div><div class="ops-field"><label for="ops-field-scope">${project.id ? 'Ambito' : 'Ambito di riferimento'}</label><select id="ops-field-scope" name="scopeId">${scopeOptions(selectedScope)}</select></div></div>${!project.id ? '<label class="ops-check"><input type="checkbox" name="createScope" checked><span>Memoria e conversazione dedicate al progetto<small>Crea un ambito separato sotto quello scelto. Disattiva solo per usare esplicitamente la memoria dell’ambito esistente.</small></span></label>' : ''}`,project.id ? 'Salva modifiche' : 'Crea progetto',async data => {
      const before = new Set(operations.projects.map(item => item.id));
      await operation(project.id ? 'saveProject' : 'createProject',{...(project.id ? {id:project.id,expectedVersion:project.version} : {}),title:data.get('title').trim(),description:data.get('description').trim(),scopeId:data.get('scopeId'),kind:data.get('kind'),...(!project.id ? {createScope:data.has('createScope')} : {})});
      const savedProject = project.id ? projectFor(project.id) : operations.projects.find(item=>!before.has(item.id));
      if (!project.id && savedProject) {
        workspace = await request('/api/workspace');
        try {await onScopeChange(savedProject.scopeId);scopeId=savedProject.scopeId;filter='current';}
        catch {filter='all';toast('Progetto creato. Seleziona il suo ambito per aprire la chat dedicata.');}
      }
      projectId = savedProject?.id || null;
      if (projectFor(projectId)?.scopeId !== scopeId) filter = 'all';
      $('#ops-scope-filter').value = filter;tab = 'projects';render();toast('Progetto salvato.');
    });
  }
  function taskForm(selectedProjectId) {
    if (locked()) return;
    const project = projectFor(selectedProjectId) || visibleProjects()[0] || operations.projects[0];
    if (!project) {toast('Crea prima il progetto a cui affidare l’incarico.');projectForm();return;}
    showForm('Un incarico con un risultato chiaro',`<p class="ops-form-intro">Il lavoro viene preparato come bozza. Dopo aver salvato scegli quando avviare il modello AI; le chiamate API possono avere un costo.</p><div class="ops-field"><label for="ops-field-project">Progetto</label><select id="ops-field-project" name="projectId">${projectOptions(project.id)}</select></div>${field('Titolo dell’incarico','title','',{required:true,max:160})}${field('Brief e materiali da usare','brief','',{area:true,required:true,max:12000,hint:'Includi informazioni, vincoli e criteri di accettazione. Il team ragiona sui materiali forniti: non può accedere automaticamente al web, ai tuoi file o ai repository.'})}<div class="ops-form-grid"><div class="ops-field"><label for="ops-field-agent">Responsabile</label><select id="ops-field-agent" name="agentId">${agentOptions('nova')}</select></div><div class="ops-field"><label for="ops-field-workflow">Procedura</label><select id="ops-field-workflow" name="workflowId">${taskWorkflowOptions(project)}</select><p class="ops-hint">Il percorso prodotto coinvolge Riccardo, Raffaele, Big Fonz e D’albenzio sui materiali forniti. Le altre procedure devono essere pronte e disponibili nell’ambito.</p></div></div>`,'Salva incarico',async data => {
      await operation('createTask',{projectId:data.get('projectId'),title:data.get('title').trim(),brief:data.get('brief').trim(),agentId:data.get('agentId'),...(data.get('workflowId') === '__product__' ? {template:'product-brief',workflowId:null} : {workflowId:data.get('workflowId') === '__single__' ? null : data.get('workflowId') || null})});
      projectId = data.get('projectId');tab = 'projects';render();toast('Incarico salvato. Aprilo per avviare il lavoro.');
    });
    dialog.querySelector('[name="projectId"]').addEventListener('change',event => {dialog.querySelector('[name="workflowId"]').innerHTML = taskWorkflowOptions(projectFor(event.target.value));});
  }
  function routineForm(routine = {},selectedProjectId) {
    if (locked()) return;
    const project = projectFor(routine.projectId || selectedProjectId) || visibleProjects()[0] || operations.projects[0];
    if (!project) {toast('Crea prima un progetto per organizzare la routine.');projectForm();return;}
    showForm(routine.id ? 'Rivedi la routine' : 'Un appuntamento con il tuo lavoro',`<p class="ops-form-intro">Quando arriva la scadenza, lo studio crea un incarico da avviare. Nessun servizio AI viene chiamato automaticamente. Lo studio deve essere in esecuzione per preparare gli incarichi.</p><div class="ops-field"><label for="ops-field-project">Progetto</label><select id="ops-field-project" name="projectId">${projectOptions(project.id)}</select></div>${field('Titolo della routine','title',routine.title,{required:true,max:160})}${field('Brief dell’incarico ricorrente','brief',routine.brief,{area:true,required:true,max:12000})}<div class="ops-form-grid"><div class="ops-field"><label for="ops-field-agent">Responsabile</label><select id="ops-field-agent" name="agentId">${agentOptions(routine.agentId)}</select></div><div class="ops-field"><label for="ops-field-workflow">Procedura</label><select id="ops-field-workflow" name="workflowId">${workflowOptions(project,routine.workflowId)}</select></div></div><div class="ops-form-grid">${field('Intervallo in ore','intervalHours',routine.intervalHours || 168,{type:'number',required:true,min:1,max:720,step:1})}${field('Prossimo incarico · ora locale','nextRunAt',localDate(routine.nextRunAt),{type:'datetime-local',required:true})}</div><label class="ops-check"><input type="checkbox" name="enabled"${routine.enabled ? ' checked' : ''}><span>Routine attiva<small>Prepara soltanto incarichi da avviare manualmente.</small></span></label>`,routine.id ? 'Salva routine' : 'Crea routine',async data => {
      await operation(routine.id ? 'updateRoutine' : 'createRoutine',{...(routine.id ? {id:routine.id,expectedVersion:routine.version} : {}),projectId:data.get('projectId'),title:data.get('title').trim(),brief:data.get('brief').trim(),agentId:data.get('agentId'),workflowId:data.get('workflowId') || null,intervalHours:Number(data.get('intervalHours')),nextRunAt:new Date(data.get('nextRunAt')).toISOString(),enabled:data.has('enabled')});
      tab = 'routines';render();toast('Routine salvata.');
    });
    dialog.querySelector('[name="projectId"]').addEventListener('change',event => {dialog.querySelector('[name="workflowId"]').innerHTML = workflowOptions(projectFor(event.target.value));});
  }
  function usageSummary(task) {
    let input = 0,output = 0,known = false,unknown = false,inputKnown = false,outputKnown = false;
    for (const step of task.steps || []) {
      const usage = step.execution?.usage;
      if (Number.isFinite(usage?.inputTokens) || Number.isFinite(usage?.outputTokens)) {known = true;input += Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;output += Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;}
      inputKnown ||= Number.isFinite(usage?.inputTokens);outputKnown ||= Number.isFinite(usage?.outputTokens);
      if ((step.execution || ['completed','done'].includes(step.status)) && (!Number.isFinite(usage?.inputTokens) || !Number.isFinite(usage?.outputTokens))) unknown = true;
    }
    if (!known) return '<span>Token: non disponibili</span>';
    const number = value => new Intl.NumberFormat('it-IT').format(value);
    return `<span>Token ${unknown ? 'noti ' : ''}in ingresso: ${inputKnown ? number(input) : 'non disponibili'}</span><span>In uscita: ${outputKnown ? number(output) : 'non disponibili'}</span>${unknown ? '<span>Conteggio parziale: alcuni valori non sono disponibili.</span>' : ''}`;
  }
  function contextDetails(context) {
    if (!context) return '';
    const memories = context.memories || [],workflows = context.workflows || (context.workflow ? [context.workflow] : []);
    return `<details class="ops-context"><summary>Contesto utilizzato · ${memories.length} memorie${workflows.length ? ` · ${workflows.length} procedure` : ''}</summary><p>Ambito: ${html(context.scopeName || scopeName(context.scopeId))}. Le fonti indicano la provenienza delle note, non una verifica indipendente.</p>${memories.length ? `<ul>${memories.map(memory=>`<li><strong>${html(memory.title)}</strong> · v${html(memory.version)} · ${html(scopeName(memory.scopeId))}<span>Fonte: ${html(memory.source || 'Annotazione manuale')}</span></li>`).join('')}</ul>` : '<p>Nessuna memoria aggiuntiva utilizzata.</p>'}${workflows.length ? `<ul>${workflows.map(workflow=>`<li>Procedura: <strong>${html(workflow.title)}</strong> · v${html(workflow.version)}</li>`).join('')}</ul>` : ''}</details>`;
  }
  function taskActions(task) {
    if (task.status === 'running') return `<button type="button" class="ops-button" data-dialog-action="pause" data-id="${html(task.id)}" data-mutation>Metti in pausa</button>`;
    if (['queued','paused','failed'].includes(task.status)) return `<button type="button" class="ops-button is-primary" data-dialog-action="run" data-id="${html(task.id)}" data-mutation>${task.status === 'queued' ? 'Avvia il lavoro' : 'Riprendi il lavoro'}</button>${['paused','failed'].includes(task.status) ? `<button type="button" class="ops-button" data-dialog-action="restart" data-id="${html(task.id)}" data-mutation>Riparti dall’inizio</button>` : ''}`;
    return '';
  }
  function renderTaskDialog(id) {
    const task = taskFor(id);if (!task) return;
    dialogView = {kind:'task',id};
    const versions = artifacts(task);
    const selected = Math.min(artifactSelection.get(id) ?? versions.length - 1,versions.length - 1);
    const artifact = versions[selected];
    const latest = selected === versions.length - 1;
    const project = projectFor(task.projectId);
    const wasOpen = dialog.open;
    const openDetails = [...dialog.querySelectorAll('details')].map((detail,index)=>detail.open ? index : -1).filter(index=>index >= 0);
    const focusedId = dialog.contains(document.activeElement) ? document.activeElement.id : null;
    const oldScroll = dialog.scrollTop;
    dialogShell(task.title,`<div class="ops-task-body"><div class="ops-task-meta">${badge(task.status)}<span>${html(project?.title || '')} · ${html(scopeName(project?.scopeId))}</span><span>${html(agentName(task.agentId))}</span></div><details class="ops-disclosure"><summary>Brief e materiali di partenza</summary><p class="ops-prewrap">${html(task.brief)}</p></details>${task.error ? `<p class="ops-error" role="status">${html(typeof task.error === 'string' ? task.error : task.error.message || 'L’esecuzione richiede una verifica.')}</p>` : ''}${task.steps?.length ? `<ol class="ops-steps">${task.steps.map((step,index) => `<li><span class="ops-step-number">${index + 1}</span><div><div class="ops-step-title"><strong>${html(step.title)}</strong>${badge(step.status,step.status === 'completed' ? 'Completato' : '')}</div><p>${html(agentName(step.agentId))}${step.execution?.provider ? ` · ${html(connectionName(step.execution.provider.id))}${step.execution.provider.model && step.execution.provider.model !== 'local-default' ? ` · ${html(step.execution.provider.model)}` : ''}` : ''}${Number.isFinite(step.execution?.durationMs) ? ` · ${Math.max(0,Math.round(step.execution.durationMs / 1000))} s` : ''}</p>${step.output ? `<details><summary>Leggi il risultato del passaggio</summary><div class="ops-prewrap">${html(step.output)}</div></details>` : ''}${contextDetails(step.context)}${step.error ? `<p class="ops-step-error">${html(typeof step.error === 'string' ? step.error : step.error.message)}</p>` : ''}</div></li>`).join('')}</ol>` : '<p class="ops-hint">I passaggi saranno disponibili quando il lavoro viene preparato.</p>'}<div class="ops-usage">${usageSummary(task)}</div>${artifact ? `<section class="ops-delivery" aria-labelledby="ops-delivery-title"><div class="ops-delivery-heading"><div><span class="ops-kind">${artifact.decision === 'approved' ? 'CONSEGNA APPROVATA' : artifact.decision === 'changes_requested' ? 'REVISIONE RICHIESTA' : 'CONSEGNA DA RIVEDERE'}</span><h3 id="ops-delivery-title">${html(artifact.title || task.title)}</h3></div><label class="ops-version-label">Versione<select id="ops-artifact-version">${versions.map((item,index) => `<option value="${index}"${index === selected ? ' selected' : ''}>${html(item.version || index + 1)} · ${html(state(item.decision || 'pending'))}</option>`).join('')}</select></label></div><div class="ops-artifact-text">${html(artifact.content || '')}</div>${contextDetails(artifact.context)}${artifact.feedback ? `<div class="ops-feedback"><strong>Feedback ricevuto</strong><p class="ops-prewrap">${html(artifact.feedback)}</p></div>` : ''}<div class="ops-delivery-actions"><button type="button" class="ops-button" data-dialog-action="download" data-id="${html(id)}">Scarica .md ↓</button>${latest && task.status === 'review' ? `<button type="button" class="ops-button is-primary" data-dialog-action="approve" data-id="${html(id)}" data-mutation>Approva consegna</button><button type="button" class="ops-button" data-dialog-action="changes" data-id="${html(id)}" data-mutation>Chiedi una revisione</button>` : ''}${latest && task.status === 'completed' && artifact.decision === 'approved' ? `<button type="button" class="ops-button" data-dialog-action="memory" data-id="${html(id)}" data-mutation>Proponi una memoria</button>` : ''}</div></section>` : `<div class="ops-run-note">${task.status === 'running' ? 'Il lavoro continua sul server anche se aggiorni la pagina. Troverai qui la consegna da controllare.' : 'Avviando il lavoro autorizzi le chiamate al servizio assegnato agli agenti. Le API esterne possono generare consumi. Il risultato sarà una bozza da approvare.'}</div>`}${task.events?.length ? `<details class="ops-disclosure ops-events"><summary>Storico dell’incarico · ${task.events.length} eventi</summary><ol>${task.events.slice().reverse().map(event => `<li><time>${html(date(event.createdAt))}</time><span>${html(event.message || event.type)}</span></li>`).join('')}</ol></details>` : ''}</div>`,`<button type="button" class="ops-button" data-close>Chiudi</button>${taskActions(task)}`);
    if (wasOpen) {openDetails.forEach(index=>{const detail=dialog.querySelectorAll('details')[index];if (detail) detail.open=true;});dialog.scrollTop = oldScroll;if (focusedId) dialog.querySelector(`#${CSS.escape(focusedId)}`)?.focus({preventScroll:true});}
    dialog.querySelector('#ops-artifact-version')?.addEventListener('change',event => {artifactSelection.set(id,Number(event.target.value));renderTaskDialog(id);});
  }
  async function runTask(task,action) {
    await inlineMutation(async () => {
      await request(`/api/tasks/${action}`,{id:task.id,expectedVersion:task.version});
      await refreshOperations();renderTaskDialog(task.id);
      toast(action === 'pause' ? 'Pausa richiesta. I risultati già salvati rimangono disponibili.' : 'Lavoro avviato. Puoi continuare a usare lo studio.');
    });
  }
  function restartTask(task) {
    showForm('Ripartire dall’inizio?',`<p class="ops-form-intro">${html(task.title)}</p><p>I risultati intermedi salvati saranno rimossi e i passaggi verranno preparati di nuovo con il contesto attuale. Le versioni delle consegne restano conservate.</p><p class="ops-hint">Questa azione rimette l’incarico in attesa. Dovrai avviarlo esplicitamente.</p>`,'Prepara un nuovo avvio',async () => {await operation('restartTask',{id:task.id,expectedVersion:task.version});toast('Incarico pronto per ripartire.');},{afterSave:()=>renderTaskDialog(task.id)});
  }
  function approveTask(task) {
    showForm('Approva questa consegna',`<p class="ops-form-intro"><strong>${html(task.title)}</strong> · versione ${html(artifacts(task).at(-1)?.version || artifacts(task).length)}</p><p>Confermi di aver controllato la consegna. L’incarico sarà completato e il risultato rimarrà consultabile nel progetto.</p><p class="ops-hint">Approvare non pubblica, non invia messaggi e non modifica file esterni.</p>`,'Approva consegna',async () => {await operation('approveTask',{id:task.id,expectedVersion:task.version});toast('Consegna approvata.');},{afterSave:()=>renderTaskDialog(task.id)});
  }
  function requestChanges(task) {
    showForm('Cosa deve cambiare?',`<p class="ops-form-intro">La versione attuale rimane conservata. Descrivi le modifiche necessarie; il prossimo avvio preparerà una nuova consegna.</p>${field('Feedback per il team','feedback','',{area:true,required:true,max:6000})}`,'Richiedi revisione',async data => {await operation('requestChanges',{id:task.id,feedback:data.get('feedback').trim(),expectedVersion:task.version});toast('Revisione richiesta. Avvia il lavoro quando sei pronto.');},{afterSave:()=>renderTaskDialog(task.id)});
  }
  function memoryFromTask(task) {
    const version = artifacts(task)[artifactSelection.get(task.id) ?? artifacts(task).length - 1];
    if (!version) return;
    showForm('Cosa vuoi conservare?',`<p class="ops-form-intro">Dalla consegna approvata puoi ricavare una decisione o un metodo riutilizzabile. Sarà salvato come <strong>proposta da verificare</strong> nella memoria del progetto.</p>${field('Titolo della memoria','title',shorten(version.title || task.title,140),{required:true,max:160})}<div class="ops-field"><label for="ops-field-memory-type">Tipo</label><select id="ops-field-memory-type" name="type"><option value="pattern">Metodo riutilizzabile</option><option value="decision">Decisione</option></select></div>${field('Contenuto da conservare','content',String(version.content || '').slice(0,8000),{area:true,required:true,max:8000,hint:'Rivedi il testo e conserva soltanto quello che può aiutare i prossimi incarichi.'})}`,'Salva proposta',async data => {await request('/api/tasks/memory',{id:task.id,title:data.get('title').trim(),content:data.get('content').trim(),type:data.get('type')});await onRefreshMemory();toast('Proposta salvata. Confermala nella memoria per renderla disponibile agli agenti.');});
  }
  function downloadArtifact(task) {
    const artifact = artifacts(task)[artifactSelection.get(task.id) ?? artifacts(task).length - 1];
    if (!artifact) return;
    const blob = new Blob([`# ${artifact.title || task.title}\n\n${artifact.content || ''}\n`],{type:'text/markdown;charset=utf-8'});
    const url = URL.createObjectURL(blob),link = document.createElement('a');
    link.href = url;link.download = `${(task.title || 'consegna').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').slice(0,80)}-v${artifact.version || 1}.md`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function providerForm(connection = {}) {
    if (locked()) return;
    showForm(connection.id ? 'Modifica il servizio AI' : 'Collega un servizio AI',`<p class="ops-form-intro">Usa una tua chiave API. Viene inviata al server locale e non viene conservata nel browser. Il collegamento non esegue chiamate al modello.</p>${field('Nome della connessione','name',connection.name,{required:true,max:100})}<div class="ops-form-grid"><div class="ops-field"><label for="ops-field-provider-type">Servizio</label><select id="ops-field-provider-type" name="type"${connection.id ? ' disabled' : ''}>${['openrouter','openai','anthropic','deepseek'].map(type=>`<option value="${type}"${connection.type === type ? ' selected' : ''}>${providerTypes[type]}</option>`).join('')}</select></div>${field('ID esatto del modello','model',connection.model,{required:true,max:200,hint:'Copia l’identificativo del modello dalla documentazione del servizio.'})}</div>${field(connection.id ? 'Nuova chiave API · facoltativa' : 'Chiave API','apiKey','',{type:'password',required:!connection.id,max:1000,hint:connection.id ? 'Lascia vuoto per conservare la chiave già salvata. Il campo viene svuotato dopo l’invio.' : 'Il campo viene svuotato dopo l’invio.'})}<div class="ops-run-note">Per usare questa connessione assegna un agente e consenti il servizio negli ambiti pertinenti. Le chiamate vengono addebitate dal tuo fornitore.</div>`,'Salva connessione',async data => {
      const payload = {...(connection.id ? {id:connection.id} : {}),name:data.get('name').trim(),type:connection.type || data.get('type'),model:data.get('model').trim()};
      const secret = data.get('apiKey')?.trim();if (secret) payload.apiKey = secret;
      try {await providerMutation('saveConnection',payload);} finally {delete payload.apiKey;}
      toast('Connessione salvata. Non è stata eseguita alcuna chiamata al modello.');
    });
  }
  function testProvider(connection) {
    showForm('Verifica la connessione',`<p class="ops-form-intro"><strong>${html(connection.name)}</strong> · ${html(connection.model)}</p><p>Il test invia una breve richiesta al modello. <strong>Può generare un piccolo consumo a pagamento</strong> sul tuo account presso il fornitore.</p><p class="ops-hint">Non invia memorie, documenti o contenuti dei tuoi progetti.</p>`,'Esegui test a consumo',async () => {
      const result = await request('/api/providers/test',{id:connection.id});
      acceptProviders(await request('/api/providers'));render();await onProviderChange();
      const usage = result.usage;
      toast(`Connessione verificata.${Number.isFinite(usage?.inputTokens) || Number.isFinite(usage?.outputTokens) ? ` Token: ${Number.isFinite(usage.inputTokens) ? usage.inputTokens : 'non disponibili'} in ingresso, ${Number.isFinite(usage.outputTokens) ? usage.outputTokens : 'non disponibili'} in uscita.` : ''}`);
    });
  }
  function deleteProvider(connection) {
    showForm('Rimuovi la connessione?',`<p class="ops-form-intro"><strong>${html(connection.name)}</strong></p><p>La configurazione e la chiave salvata saranno rimosse dallo studio. Controlla gli agenti assegnati a questo servizio prima di avviare altri incarichi.</p><p class="ops-hint">Questa azione non revoca la chiave presso il fornitore.</p>`,'Rimuovi connessione',async () => {await providerMutation('deleteConnection',{id:connection.id});toast('Connessione rimossa.');},{danger:true});
  }

  panel.addEventListener('click',event => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) {tab = tabButton.dataset.tab;render();return;}
    const button = event.target.closest('[data-action]');if (!button || button.disabled) return;
    const {action,id} = button.dataset;
    if (action === 'refresh') {load();return;}
    if (action === 'new-project') {projectForm();return;}
    if (action === 'project') {projectId = id;render();return;}
    if (action === 'back-projects') {projectId = null;render();return;}
    if (action === 'edit-project') {projectForm(projectFor(id));return;}
    if (action === 'new-task') {taskForm(button.dataset.projectId);return;}
    if (action === 'task') {renderTaskDialog(id);return;}
    if (action === 'new-routine') {routineForm({},button.dataset.projectId);return;}
    if (action === 'edit-routine') {routineForm(operations.routines.find(routine=>routine.id === id));return;}
    if (action === 'toggle-routine') {const routine = operations.routines.find(item=>item.id === id);if (routine) inlineMutation(async()=>{await operation('updateRoutine',{id,expectedVersion:routine.version,enabled:!routine.enabled});toast(routine.enabled ? 'Routine sospesa.' : 'Routine attiva: preparerà incarichi da avviare.');});return;}
    if (action === 'open-scope') {inlineMutation(async()=>{await onScopeChange(id);scopeId=id;filter='current';$('#ops-scope-filter').value=filter;render();toast(`Chat aperta in ${scopeName(id)}.`);});return;}
    if (action === 'new-provider') {providerForm();return;}
    const connection = providers.connections.find(item=>item.id === id);
    if (!connection) return;
    if (action === 'edit-provider') providerForm(connection);
    if (action === 'test-provider') testProvider(connection);
    if (action === 'delete-provider') deleteProvider(connection);
  });
  panel.addEventListener('change',event => {
    if (event.target.id === 'ops-scope-filter') {filter=event.target.value;projectId=null;render();}
    const agentId = event.target.dataset.assignment;
    if (agentId) inlineMutation(async()=>{try {await providerMutation('assignAgent',{agentId,connectionId:event.target.value});toast('Servizio dell’agente aggiornato.');} catch(error) {render();throw error;}});
  });
  panel.addEventListener('submit',event => {
    if (event.target.id !== 'ops-policy-form') return;
    event.preventDefault();const connectionIds=new FormData(event.target).getAll('connectionIds');
    inlineMutation(async()=>{await providerMutation('setScopePolicy',{scopeId,connectionIds});toast(`Servizi consentiti aggiornati per ${scopeName(scopeId)}.`);});
  });
  panel.querySelector('[role="tablist"]').addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();const tabs=['projects','review','routines','providers'];
    const index=tabs.indexOf(tab);tab=tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (index+(event.key === 'ArrowRight' ? 1 : -1)+tabs.length)%tabs.length];
    render();$(`[data-tab="${tab}"]`).focus();
  });
  dialog.addEventListener('click',event => {
    const button=event.target.closest('[data-dialog-action]');if (!button || button.disabled) return;
    const task=taskFor(button.dataset.id);if (!task) return;
    const action=button.dataset.dialogAction;
    if (action === 'run' || action === 'pause') runTask(task,action);
    if (action === 'restart') restartTask(task);
    if (action === 'approve') approveTask(task);
    if (action === 'changes') requestChanges(task);
    if (action === 'memory') memoryFromTask(task);
    if (action === 'download') downloadArtifact(task);
  });
  return {load,setScope(id) {if (!id) return;scopeId=id;projectId=null;render();},setBusy(value) {busy=Boolean(value);syncLocks();}};
}
