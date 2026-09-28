import { t, ui, locale, onLanguageChange, bindTranslations } from './i18n.js';
import { agents } from './data.js';
import { scopeIdentity } from './experience-state.js';
import { icon } from './studio-icons.js';
import { createRepositoriesPanel } from './repositories.js';
import { createPlanningPanel } from './plans.js';
import { createGovernancePanel } from './governance.js';
import { createSourcesPanel } from './sources.js';
import { createGithubPanel } from './github.js';

const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const shorten = (value, max = 230) => String(value ?? '').length > max ? `${String(value).slice(0, max).trimEnd()}…` : String(value ?? '');
const states = {queued:'Da avviare',running:'In lavorazione',paused:'In pausa',review:'Da approvare',completed:'Approvato',failed:'Da riprendere',pending:'In attesa',approved:'Approvata',changes_requested:'Da rivedere',rejected:'Da rivedere'};
const providerTypes = {codex:'Codex locale',openrouter:'OpenRouter',openai:'OpenAI',anthropic:'Anthropic',deepseek:'DeepSeek'};
const date = value => {
  const parsed = new Date(value);
  return value && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(locale(),{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(parsed) : t('Da definire');
};
const localDate = value => {
  const parsed = new Date(value || Date.now() + 86400000);
  if (!Number.isFinite(parsed.getTime())) return '';
  return `${parsed.getFullYear()}-${String(parsed.getMonth()+1).padStart(2,'0')}-${String(parsed.getDate()).padStart(2,'0')}T${String(parsed.getHours()).padStart(2,'0')}:${String(parsed.getMinutes()).padStart(2,'0')}`;
};

export function createOperationsPanel({onCreateWorkflow = () => {},toast = () => {},onScopeChange = async () => {},onRefreshMemory = async () => {},onProviderChange = async () => {},onActivity = () => {},onRepositoryActivity = () => {}} = {}) {
  const panel = document.createElement('section');
  panel.id = 'operations-panel';
  panel.className = 'operations-panel';
  panel.setAttribute('aria-labelledby','operations-title');
  panel.innerHTML = `<div class="ops-heading"><div><div class="eyebrow">DA UN’IDEA A UNA CONSEGNA</div><h2 id="operations-title">Il lavoro che porti avanti.</h2><p>Progetti, incarichi e decisioni. Con un filo che rimane.</p></div><div class="ops-heading-actions"><button type="button" class="ops-icon" data-action="refresh" aria-label="Aggiorna progetti e attività" title="Aggiorna">↻</button><button type="button" class="ops-button is-primary" data-action="new-project" data-mutation>＋ Nuovo progetto</button></div></div><div class="ops-toolbar"><div class="ops-tabs" role="tablist" aria-label="Gestione dello studio"><button type="button" role="tab" id="ops-tab-projects" data-tab="projects" aria-selected="true" aria-controls="ops-content">Progetti <span data-count="projects">0</span></button><button type="button" role="tab" id="ops-tab-review" data-tab="review" aria-selected="false" aria-controls="ops-content" tabindex="-1">Da decidere <span data-count="review">0</span></button><button type="button" role="tab" id="ops-tab-routines" data-tab="routines" aria-selected="false" aria-controls="ops-content" tabindex="-1">Routine <span data-count="routines">0</span></button><button type="button" role="tab" id="ops-tab-repositories" data-tab="repositories" aria-selected="false" aria-controls="repo-panel" tabindex="-1">Repository <span data-count="repositories">0</span></button><button type="button" role="tab" id="ops-tab-github" data-tab="github" aria-selected="false" aria-controls="github-panel" tabindex="-1">GitHub</button><button type="button" role="tab" id="ops-tab-sources" data-tab="sources" aria-selected="false" aria-controls="sources-panel" tabindex="-1">Fonti <span data-count="sources">0</span></button><button type="button" role="tab" id="ops-tab-results" data-tab="results" aria-selected="false" aria-controls="governance-panel" tabindex="-1">Risultati</button><button type="button" role="tab" id="ops-tab-providers" data-tab="providers" aria-selected="false" aria-controls="ops-content" tabindex="-1">Servizi AI</button></div><div class="ops-filter"><label for="ops-scope-filter" class="visually-hidden">Ambiti mostrati</label><select id="ops-scope-filter"><option value="current">Ambito attuale</option><option value="all">Tutti gli ambiti</option></select></div></div><div class="ops-status" role="status" aria-live="polite">Caricamento dei progetti…</div><div id="ops-content" class="ops-content" role="tabpanel" aria-labelledby="ops-tab-projects" tabindex="0"></div><p class="ops-footnote">Gli incarichi generano bozze dai materiali forniti. Ogni avvio è esplicito; approvi tu le consegne.</p>`;
  const repositoryHost=document.createElement('div');repositoryHost.id='repo-panel';repositoryHost.className='ops-content repo-panel';repositoryHost.hidden=true;repositoryHost.setAttribute('role','tabpanel');repositoryHost.setAttribute('aria-labelledby','ops-tab-repositories');panel.querySelector('#ops-content').after(repositoryHost);
  const governanceHost=document.createElement('div');governanceHost.id='governance-panel';governanceHost.className='ops-content governance-panel';governanceHost.hidden=true;governanceHost.setAttribute('role','tabpanel');governanceHost.setAttribute('aria-labelledby','ops-tab-results');repositoryHost.after(governanceHost);
  const governanceSettings=document.createElement('div');governanceSettings.id='governance-settings';
  const sourcesHost=document.createElement('div');sourcesHost.id='sources-panel';sourcesHost.className='ops-content sources-panel';sourcesHost.hidden=true;sourcesHost.setAttribute('role','tabpanel');sourcesHost.setAttribute('aria-labelledby','ops-tab-sources');governanceHost.after(sourcesHost);
  const githubHost=document.createElement('div');githubHost.id='github-panel';githubHost.className='ops-content github-panel';githubHost.hidden=true;githubHost.setAttribute('role','tabpanel');githubHost.setAttribute('aria-labelledby','ops-tab-github');sourcesHost.after(githubHost);
  const insertion = document.querySelector('#knowledge-panel') || document.querySelector('.team-section') || document.querySelector('main footer');
  if (insertion) insertion.before(panel); else document.querySelector('main')?.append(panel);
  bindTranslations(panel);
  const dialog = document.createElement('dialog');
  dialog.id = 'operations-dialog';
  dialog.className = 'ops-dialog';
  dialog.setAttribute('aria-labelledby','ops-dialog-title');
  document.body.append(dialog);

  let operations = {projects:[],tasks:[],routines:[]}, workspace = {scopes:[],workflows:[]}, providers = {connections:[],assignments:{},policies:{}};
  let tab = 'projects',scopeId = 'business',filter = 'current',projectId = null,busy = false,loading = true,mutating = false,loadError = '',pollTimer = null,polling = false,loadNumber = 0;
  let localizeDialog = null,dialogView = null,artifactSelection = new Map();
  const $ = selector => panel.querySelector(selector);
  const projectFor = id => operations.projects.find(project => project.id === id);
  const taskFor = id => operations.tasks.find(task => task.id === id);
  const scopeName = id => workspace.scopes.find(scope => scope.id === id)?.name || id || t('Ambito');
  const agentName = id => agents.find(agent => agent.id === id)?.name || id || agents.find(agent => agent.id === 'nova')?.name || t('Coordinatore');
  const connectionName = id => providers.connections.find(connection => connection.id === id)?.name || (id === 'codex' ? t('Codex locale') : id) || t('Non assegnato');
  const locked = () => busy || loading || mutating || Boolean(loadError);
  let repositoryRuns=[];
  const reportActivity=()=>onActivity({...operations,repositoryRuns});
  const governance=createGovernancePanel({host:governanceHost,settingsHost:governanceSettings,toast,onSettingsChange:()=>render()});
  const repositories=createRepositoriesPanel({host:repositoryHost,toast,onRefreshMemory,onOutcome:target=>governance.openOutcome(target),onNewProject:()=>projectForm(),onActivity:value=>{repositoryRuns=value.runs;governance.setContext({tasks:operations.tasks,runs:repositoryRuns,workflows:workspace.workflows});reportActivity();onRepositoryActivity(value);const count=$('[data-count="repositories"]');if(count)count.textContent=value.repositories.filter(item=>filter==='all'||item.scopeId===scopeId).length;if(tab==='review'&&!loading)render();}});
  const planning=createPlanningPanel({toast,onCommit:value=>{acceptOperations(value);tab='projects';render();schedulePoll();}});
  const sources=createSourcesPanel({host:sourcesHost,toast,onCount:count=>{const element=$('[data-count="sources"]');if(element)element.textContent=count;},onProviders:()=>{tab='providers';render();},onChanged:()=>void governance.load()});
  const github=createGithubPanel({host:githubHost,toast,onSourcesChanged:()=>void sources.load()});
  window.addEventListener('studio-open-github',event=>{tab='github';render();panel.scrollIntoView({block:'start',behavior:'smooth'});void github.open(event.detail||{});});
  const taskDependencies=task=>(task.dependencies||[]).map(id=>taskFor(id)||{id,title:t('Incarico precedente non disponibile'),status:'missing'});
  const dependencyApproved=task=>task.status==='completed'&&task.artifacts?.at(-1)?.decision==='approved';
  const pendingDependencies=task=>taskDependencies(task).filter(item=>!dependencyApproved(item));
  const allowedProject = project => project && (filter === 'all' || project.scopeId === scopeId);
  const visibleProjects = () => operations.projects.filter(allowedProject).sort((a,b) => Number(b.kind === 'owned')-Number(a.kind === 'owned') || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const projectTasks = id => operations.tasks.filter(task => task.projectId === id).sort((a,b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  const artifacts = task => Array.isArray(task.artifacts) ? task.artifacts : [];
  const activeTask = task => task.status === 'running';
  const needsDecision = task => ['review','failed','paused'].includes(task.status);
  const state = value => t(states[value] || value || 'Da avviare');
  const badge = (value,label) => ui`<span class="ops-state state-${html(value || 'queued')}">${html(label || state(value))}</span>`;
  const scopeOptions = (selected,scopes = workspace.scopes.filter(scope => !['shared','archive'].includes(scope.kind))) => scopes.map(scope => ui`<option value="${html(scope.id)}"${selected === scope.id ? ' selected' : ''}>${html(scope.name)}</option>`).join('');
  const agentOptions = selected => agents.map(agent => ui`<option value="${html(agent.id)}"${agent.id === (selected || 'nova') ? ' selected' : ''}>${html(agent.name)}</option>`).join('');
  const workflowOptions = (project,selected) => ui`<option value="">Incarico libero</option>${workspace.workflows.filter(workflow => workflow.status === 'ready' && (workflow.scopeId === project?.scopeId || workflow.scopeId === 'shared' || workflow.sharedWith?.includes(project?.scopeId))).map(workflow => ui`<option value="${html(workflow.id)}"${workflow.id === selected ? ' selected' : ''}>${html(workflow.title)}</option>`).join('')}`;
  const taskWorkflowOptions = project => ui`<option value="__product__" selected>Dal brief alla proposta di prodotto · 4 agenti</option><option value="__single__">Un incarico al solo responsabile</option>${workflowOptions(project).replace(ui`<option value="">Incarico libero</option>`,'')}`;
  const projectOptions = selected => operations.projects.slice().sort((a,b)=>Number(b.kind === 'owned')-Number(a.kind === 'owned')).map(project => ui`<option value="${html(project.id)}"${project.id === selected ? ' selected' : ''}>${html(project.title)} · ${html(scopeName(project.scopeId))}</option>`).join('');

  async function request(path,body) {
    const response = await fetch(path,body ? {method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify(body)} : {cache:'no-store'});
    let value;
    try { value = await response.json(); } catch { throw Error(t('Lo studio non ha risposto correttamente. Verifica che il server sia avviato.')); }
    if (!response.ok) {
      const error = Error(value.error || t('Non è stato possibile completare l’operazione.'));
      error.status = response.status;
      throw error;
    }
    return value;
  }
  function acceptOperations(value) {
    if (!value || !Array.isArray(value.projects) || !Array.isArray(value.tasks) || !Array.isArray(value.routines)) throw Error(t('I dati dei progetti non sono validi. Riprova a caricarli.'));
    operations = value;
    reportActivity();
  }
  function acceptProviders(value) {
    if (!value || !Array.isArray(value.connections)) throw Error(t('I servizi AI non sono disponibili. Riprova.'));
    providers = {...value,assignments:value.assignments || {},policies:value.policies || {}};
  }
  function syncLocks() {
    panel.setAttribute('aria-busy',String(loading));
    repositories.setBusy(busy||loading||mutating);planning.setBusy(busy||loading||mutating);governance.setBusy(busy||loading||mutating);sources.setBusy(busy||loading||mutating);github.setBusy(busy||loading||mutating);
    panel.querySelectorAll('[data-mutation]').forEach(element => {element.disabled = locked();});
    panel.querySelectorAll('[data-action="refresh"]').forEach(element => {element.disabled = loading || mutating;});
    if (dialog.open) dialog.querySelectorAll('[data-mutation],button[type="submit"]').forEach(element => {element.disabled = locked();});
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (document.visibilityState === 'visible') {
      if(operations.tasks.some(activeTask))pollTimer=setTimeout(poll,3000);
      else if(operations.routines.some(routine=>routine.enabled))pollTimer=setTimeout(poll,20000);
    }
  }
  async function poll() {
    if (polling || loading || mutating || document.visibilityState !== 'visible') {schedulePoll();return;}
    polling = true;
    try {
      acceptOperations(await request('/api/operations'));
      render();
      if (dialogView?.kind === 'task' && dialog.open) renderTaskDialog(dialogView.id);
    } catch { $('.ops-status').textContent = t('Aggiornamento temporaneamente interrotto. Il lavoro sul server può proseguire; usa Aggiorna per verificarlo.'); }
    finally {polling = false;schedulePoll();}
  }
  document.addEventListener('visibilitychange',schedulePoll);

  async function load() {
    const version = ++loadNumber;
    loading = true;loadError = '';render();void repositories.load();void governance.load();void sources.load();
    try {
      const result = await Promise.all([request('/api/operations'),request('/api/workspace'),request('/api/providers')]);
      if (version !== loadNumber) return;
      acceptOperations(result[0]);
      if (!Array.isArray(result[1].scopes) || !Array.isArray(result[1].workflows)) throw Error(t('Gli ambiti dello studio non sono disponibili.'));
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
    return ui`<div class="ops-empty"><span aria-hidden="true">◎</span><h3>${html(title)}</h3><p>${html(copy)}</p>${action ? ui`<button type="button" class="ops-button is-primary" data-action="${html(action)}" data-mutation>${html(label)}</button>` : ''}</div>`;
  }
  function taskRow(task,showProject = false) {
    const completedSteps = (task.steps || []).filter(step => ['completed','done'].includes(step.status)).length;
    const latest = artifacts(task).at(-1);
    return ui`<button type="button" class="ops-task-row" data-action="task" data-id="${html(task.id)}"><span class="ops-task-summary">${showProject ? ui`<small>${html(projectFor(task.projectId)?.title || t('Progetto'))}</small>` : ''}<strong>${html(task.title)}</strong><span>${html(agentName(task.agentId))}${task.steps?.length ? t(" · {0}/{1} passaggi", {0: completedSteps, 1: task.steps.length}) : ''}${latest ? t(" · consegna v{0}", {0: html(latest.version || artifacts(task).length)}) : ''}</span>${task.planTitle?ui`<small>Piano: ${html(task.planTitle)}</small>`:''}${pendingDependencies(task).length?ui`<small class="ops-dependency-note">Attende ${pendingDependencies(task).length} consegne approvate</small>`:''}</span><span class="ops-task-side">${badge(task.status)}<span aria-hidden="true">↗</span></span></button>`;
  }
  function projectCard(project) {
    const identity = scopeIdentity(workspace.scopes.find(scope => scope.id === project.scopeId));
    const tasks = projectTasks(project.id),review = tasks.filter(task => task.status === 'review').length;
    return ui`<article class="ops-project-card" style="--scope-color:${identity.color}"><div class="ops-card-top"><span class="ops-kind${project.kind === 'owned' ? ' is-owned' : ''}">${project.kind === 'owned' ? t('PROGETTO PROPRIO') : t('PER UN CLIENTE')}</span><span class="ops-scope-tag scope-badge" data-scope-kind="${html(identity.kind)}">${icon(identity.icon)}${html(scopeName(project.scopeId))}</span></div><h3>${html(project.title)}</h3><p>${html(shorten(project.description || t('Aggiungi obiettivo e contesto per orientare i prossimi incarichi.')))}</p><div class="ops-project-stats"><span>${t(tasks.length===1?'{0} incarico':'{0} incarichi',{0:tasks.length})}</span><span${review ? ' class="has-review"' : ''}>${review ? t("{0} da approvare", {0: review}) : tasks.some(activeTask) ? t('Il team è al lavoro') : tasks.some(task=>task.status === 'completed') ? t('Consegne conservate') : t('Pronto per il prossimo passo')}</span></div><div class="ops-card-actions"><button type="button" class="ops-button" data-action="project" data-id="${html(project.id)}">Apri progetto ↗</button><button type="button" class="ops-button is-primary" data-action="new-task" data-project-id="${html(project.id)}" data-mutation>＋ Incarico</button></div></article>`;
  }
  function projectsView() {
    const selected = projectFor(projectId);
    if (selected && allowedProject(selected)) {
      const tasks = projectTasks(selected.id);
      return ui`<div class="ops-project-detail"><button type="button" class="ops-text-button" data-action="back-projects">← Tutti i progetti</button><div class="ops-detail-heading"><div><span class="ops-kind${selected.kind === 'owned' ? ' is-owned' : ''}">${selected.kind === 'owned' ? t('PROGETTO PROPRIO') : t('PER UN CLIENTE')} · ${html(scopeName(selected.scopeId))}</span><h3>${html(selected.title)}</h3><p>${html(selected.description || '')}</p></div><button type="button" class="ops-button" data-action="edit-project" data-id="${html(selected.id)}" data-mutation>Modifica</button></div><div class="ops-detail-actions"><button type="button" class="ops-button is-primary" data-action="new-task" data-project-id="${html(selected.id)}" data-mutation>＋ Nuovo incarico</button><button type="button" class="ops-button" data-action="plan-project" data-project-id="${html(selected.id)}" data-mutation>Pianifica con il coordinatore</button><button type="button" class="ops-button" data-action="new-routine" data-project-id="${html(selected.id)}" data-mutation>Crea una routine</button><button type="button" class="ops-text-button" data-action="open-scope" data-id="${html(selected.scopeId)}" data-mutation>Apri questo ambito in chat ↗</button></div>${tasks.length ? ui`<div class="ops-task-list">${tasks.map(task => taskRow(task)).join('')}</div>` : empty(t('Il primo incarico fa partire il progetto.'),t('Descrivi un risultato concreto e fornisci i materiali necessari. L’agente preparerà una bozza che potrai rivedere.'))}</div>`;
    }
    const projects = visibleProjects();
    return projects.length ? ui`<div class="ops-project-grid">${projects.map(projectCard).join('')}</div>` : empty(t('Dai spazio a un tuo progetto.'),t('Crea un progetto reale, chiarisci l’obiettivo e affidagli il primo incarico. Puoi tenere distinti i progetti personali e quelli dei clienti.'),'new-project',t('Crea il primo progetto'));
  }
  const pendingRepositoryReviews=()=>repositoryRuns.filter(run=>run.decision?.status!=='changes_requested'&&['review','failed','paused'].includes(run.status)&&(filter==='all'||run.scopeId===scopeId));
  function reviewView() {
    const tasks = operations.tasks.filter(task => needsDecision(task) && allowedProject(projectFor(task.projectId)));
    const runs=pendingRepositoryReviews();
    return tasks.length||runs.length ? ui`<div class="ops-view-intro"><h3>Il prossimo passo spetta a te.</h3><p>Controlla le consegne da approvare e gli incarichi in pausa o interrotti. Puoi chiedere una revisione o riprendere il lavoro, conservando le versioni precedenti.</p></div><div class="ops-task-list">${tasks.map(task => taskRow(task,true)).join('')}${runs.map(run=>ui`<button type="button" class="ops-button" data-action="review-repository" data-id="${html(run.id)}"><strong>${html(run.title)}</strong> · Repository · ${html(state(run.status))} ↗</button>`).join('')}</div>` : empty(t('Nessuna decisione in attesa.'),t('Le consegne da controllare e gli incarichi che richiedono attenzione appariranno qui. I risultati approvati rimangono nel loro progetto.'));
  }
  function routinesView() {
    const routines = operations.routines.filter(routine => allowedProject(projectFor(routine.projectId)));
    return ui`<div class="ops-view-intro"><div><h3>Un buon metodo, a intervalli regolari.</h3><p>${governance.getSettings()?.autonomousRoutines?t('Le routine abilitate possono avviare gli incarichi testuali automaticamente, nei limiti che hai autorizzato qui sotto. Le chiamate AI possono generare consumo.'):t('Le routine preparano nuovi incarichi da avviare. L’avvio automatico resta disattivato finché non lo autorizzi nelle impostazioni qui sotto.')}</p></div><button type="button" class="ops-button is-primary" data-action="new-routine" data-mutation>＋ Nuova routine</button></div>${routines.length ? ui`<div class="ops-project-grid">${routines.map(routine => ui`<article class="ops-routine-card"><div class="ops-card-top"><span class="ops-scope-tag">${html(projectFor(routine.projectId)?.title || t('Progetto'))}</span><span class="ops-state ${routine.enabled ? 'state-completed' : 'state-paused'}">${routine.enabled ? t('Attiva') : t('Sospesa')}</span></div><h3>${html(routine.title)}</h3><p>${html(shorten(routine.brief))}</p><dl class="ops-routine-facts"><div><dt>Responsabile</dt><dd>${html(agentName(routine.agentId))}</dd></div><div><dt>Frequenza</dt><dd>Ogni ${html(routine.intervalHours)} ore</dd></div><div><dt>Prossimo incarico</dt><dd>${routine.enabled ? html(date(routine.nextRunAt)) : t('Routine sospesa')}</dd></div></dl><div class="ops-card-actions"><button type="button" class="ops-button" data-action="edit-routine" data-id="${html(routine.id)}" data-mutation>Modifica</button><button type="button" class="ops-button" data-action="toggle-routine" data-id="${html(routine.id)}" data-mutation>${routine.enabled ? t('Sospendi') : t('Attiva')}</button></div></article>`).join('')}</div>` : empty(t('Le attività ricorrenti possono aspettarti già organizzate.'),t('Una revisione settimanale, una verifica di progetto o la preparazione di un incontro: scegli cosa ricordare allo studio e quando.'))}`;
  }
  function providersView() {
    const connections = providers.connections;
    const codex = connections.find(connection => connection.type === 'codex' || connection.id === 'codex');
    const effectivePolicy = providers.policies[scopeId] || (codex ? [codex.id] : ['codex']);
    return ui`<div class="ops-view-intro"><div><h3>Un team, diversi motori.</h3><p>Il ruolo dell’agente resta nello studio. Scegli il servizio che lo fa lavorare e in quali ambiti può ricevere informazioni.</p></div><button type="button" class="ops-button is-primary" data-action="new-provider" data-mutation>＋ Collega servizio</button></div><div class="ops-provider-grid">${connections.map(connection => ui`<article class="ops-provider-card"><div class="ops-card-top"><span class="ops-kind">${html(t(providerTypes[connection.type] || connection.type))}</span><span class="ops-state ${connection.configured ? 'state-completed' : 'state-paused'}">${connection.configured ? t('Configurato') : t('Da configurare')}</span></div><h3>${html(connection.name)}</h3><p class="ops-model-name">${html(connection.type === 'codex' || connection.id === 'codex' ? t('Modello della sessione Codex') : connection.model)}</p><p class="ops-provider-note">${connection.type === 'codex' ? t('Usa l’accesso Codex di questo computer.') : connection.hasKey ? t('Chiave salvata sul server locale. Non viene restituita al browser.') : t('Nessuna chiave API salvata.')}</p>${connection.type !== 'codex' ? ui`<div class="ops-card-actions"><button type="button" class="ops-button" data-action="edit-provider" data-id="${html(connection.id)}" data-mutation>Modifica</button><button type="button" class="ops-button" data-action="test-provider" data-id="${html(connection.id)}" data-mutation>Test a consumo</button><button type="button" class="ops-text-button is-danger" data-action="delete-provider" data-id="${html(connection.id)}" data-mutation>Rimuovi</button></div>` : ''}</article>`).join('')}</div><div class="ops-provider-settings"><section aria-labelledby="ops-assignments-title"><h3 id="ops-assignments-title">Il motore di ciascun agente</h3><p>Una connessione configurata può essere usata da più agenti. L’accesso effettivo dipende anche dall’ambito dell’incarico.</p><div class="ops-assignments">${agents.map(agent => ui`<label><span>${html(agent.name)}<small>${html(t(agent.role))}</small></span><select data-assignment="${html(agent.id)}" data-mutation aria-label="Servizio AI di ${html(agent.name)}">${connections.map(connection => ui`<option value="${html(connection.id)}"${(providers.assignments[agent.id] || codex?.id || 'codex') === connection.id ? ' selected' : ''}${!connection.configured && connection.type !== 'codex' ? ' disabled' : ''}>${html(connection.name)}</option>`).join('')}</select></label>`).join('')}</div></section><section aria-labelledby="ops-policy-title"><h3 id="ops-policy-title">Servizi consentiti per ${html(scopeName(scopeId))}</h3><p>Solo i servizi selezionati possono elaborare questo ambito. Le note condivise mantengono la regola dell’ambito di origine: un servizio esterno deve essere consentito in entrambi.</p><form id="ops-policy-form"><div class="ops-policy-options">${connections.map(connection => ui`<label><input type="checkbox" name="connectionIds" value="${html(connection.id)}"${effectivePolicy.includes(connection.id) ? ' checked' : ''}${!connection.configured && connection.type !== 'codex' ? ' disabled' : ''}><span>${html(connection.name)}<small>${html(t(providerTypes[connection.type] || connection.type))}</small></span></label>`).join('')}</div><button type="submit" class="ops-button" data-mutation>Salva servizi consentiti</button></form><p class="ops-small-note">Per modificare un altro ambito, selezionalo nel menu della chat. Le assegnazioni degli agenti sono comuni allo studio.</p></section></div>`;
  }
  function render() {
    repositories.setContext({projects:operations.projects,scopes:workspace.scopes,scopeId,filter,projectId});repositories.setVisible(tab==='repositories');
    governance.setContext({tasks:operations.tasks,runs:repositoryRuns,workflows:workspace.workflows});governance.setVisible({dashboard:tab==='results',settings:tab==='routines'});
    sources.setContext({scopeId,scopes:workspace.scopes,providers});sources.setVisible(tab==='sources');
    github.setContext({scopeId,scopes:workspace.scopes,runs:repositoryRuns,filter});github.setVisible(tab==='github');
    $('#ops-content').hidden=['repositories','results','sources','github'].includes(tab);
    $('.ops-footnote').textContent=governance.getSettings()?.autonomousRoutines?t('Gli incarichi generano bozze da approvare. Le routine abilitate possono avviarsi automaticamente entro i limiti scelti.'):t('Gli incarichi generano bozze dai materiali forniti. Ogni avvio è esplicito; approvi tu le consegne.');
    $('[data-count="repositories"]').textContent=repositories.getSnapshot().repositories.filter(item=>filter==='all'||item.scopeId===scopeId).length;
    const projects = visibleProjects();
    $('[data-count="projects"]').textContent = projects.length;
    $('[data-count="review"]').textContent = operations.tasks.filter(task => needsDecision(task) && allowedProject(projectFor(task.projectId))).length+pendingRepositoryReviews().length;
    $('[data-count="routines"]').textContent = operations.routines.filter(routine => allowedProject(projectFor(routine.projectId))).length;
    panel.querySelectorAll('[data-tab]').forEach(button => {const selected = button.dataset.tab === tab;button.setAttribute('aria-selected',String(selected));button.tabIndex = selected ? 0 : -1;});
    $('#ops-content').setAttribute('aria-labelledby',`ops-tab-${tab}`);
    $('#ops-scope-filter').hidden = ['providers','results','sources'].includes(tab);
    $('#ops-scope-filter option[value="current"]').textContent = scopeName(scopeId);
    if (loading) {$('.ops-status').textContent = t('Caricamento dei progetti…');$('#ops-content').innerHTML = '';}
    else if (loadError) {$('.ops-status').textContent = loadError;$('#ops-content').innerHTML = empty(t('Non è stato possibile caricare lo studio.'),t('Le informazioni salvate non sono state modificate. Usa il pulsante Aggiorna per riprovare.'));}
    else {
      const running = operations.tasks.filter(activeTask).length;
      $('.ops-status').textContent = `${tab === 'providers' ? scopeName(scopeId) : filter === 'all' ? t('Tutti gli ambiti') : scopeName(scopeId)}${running ? t(running===1?' · {0} incarico in lavorazione · aggiornamento automatico':' · {0} incarichi in lavorazione · aggiornamento automatico',{0:running}) : t(' · salvato nello studio')}`;
      $('#ops-content').innerHTML = tab === 'projects' ? projectsView() : tab === 'review' ? reviewView() : tab === 'routines' ? routinesView() : tab === 'providers' ? providersView() : '';
      if (operations.scheduler?.error) {
        const warning = document.createElement('p');warning.className='ops-error';warning.textContent=t("Una routine richiede attenzione: {0}", {0: operations.scheduler.error});
        $('#ops-content').prepend(warning);
      }
    }
    if(tab==='routines'&&!loading&&!loadError)$('#ops-content').append(governanceSettings);
    syncLocks();
  }

  function field(label,name,value = '',{area = false,required = false,max = 8000,type = 'text',hint = '',min,step} = {}) {
    const id = `ops-field-${name}`;
    return ui`<div class="ops-field"><label for="${id}">${html(label)}</label>${area ? ui`<textarea id="${id}" name="${name}" rows="5" maxlength="${max}"${required ? ' required' : ''}>${html(value)}</textarea>` : ui`<input id="${id}" name="${name}" type="${type}" value="${html(value)}"${['text','password'].includes(type) ? ` maxlength="${max}"` : ''}${required ? ' required' : ''}${min !== undefined ? ` min="${min}"` : ''}${type === 'number' ? ` max="${max}"` : ''}${step !== undefined ? ` step="${step}"` : ''}${type === 'password' ? ' autocomplete="off" spellcheck="false" data-secret' : ''}>`}${hint ? ui`<p class="ops-hint">${html(hint)}</p>` : ''}</div>`;
  }
  function reopenProjectSelection(open) {
    const project=dialog.querySelector('[name="projectId"]')?.value;open();
    const input=dialog.querySelector('[name="projectId"]');if(input&&project){input.value=project;input.dispatchEvent(new Event('change'));}
  }
  function dialogShell(title,body,footer) {
    dialog.innerHTML = ui`<div class="ops-dialog-heading"><div><div class="eyebrow">LO STUDIO OPERATIVO</div><h2 id="ops-dialog-title">${html(title)}</h2></div><button type="button" class="ops-icon" data-close aria-label="Chiudi finestra">✕</button></div>${body}<div class="ops-dialog-footer">${footer || ui`<button type="button" class="ops-button" data-close>Chiudi</button>`}</div>`;
    dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',() => {if (!mutating) dialog.close();}));
    if (!dialog.open) dialog.showModal();
    syncLocks();
  }
  function showForm(title,body,submitLabel,onSubmit,{danger = false,afterSave} = {}) {
    dialogView = {kind:'form'};
    dialogShell(title,ui`<form id="ops-dialog-form" class="ops-form"><div class="ops-form-body">${body}</div><p class="ops-form-error" role="alert" hidden></p></form>`,ui`<button type="button" class="ops-button" data-close>Annulla</button><button type="submit" form="ops-dialog-form" class="ops-button ${danger ? 'is-danger-button' : 'is-primary'}" data-mutation>${html(submitLabel)}</button>`);
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
        errorBox.textContent = error.status === 409 ? t("{0} Il modulo conserva i tuoi dati. Aggiorna il progetto prima di riprovare.", {0: error.message}) : error.message;
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
    localizeDialog = () => projectForm(project);
    if (locked()) return;
    const selectedScope = workspace.scopes.some(scope => scope.id === (project.scopeId || scopeId) && !['shared','archive'].includes(scope.kind)) ? project.scopeId || scopeId : 'business';
    showForm(project.id ? t('Rivedi il progetto') : t('Un progetto da portare avanti'),ui`<p class="ops-form-intro">Dagli un obiettivo riconoscibile. Gli incarichi e le consegne resteranno associati a questo progetto.</p>${field(t('Titolo'),'title',project.title,{required:true,max:project.id ? 160 : 100})}${field(t('Obiettivo e contesto'),'description',project.description,{area:true,max:8000})}<div class="ops-form-grid"><div class="ops-field"><label for="ops-field-kind">Tipo di progetto</label><select id="ops-field-kind" name="kind"><option value="owned"${project.kind !== 'client' ? ' selected' : ''}>Un mio progetto</option><option value="client"${project.kind === 'client' ? ' selected' : ''}>Lavoro per un cliente</option></select></div><div class="ops-field"><label for="ops-field-scope">${project.id ? t('Ambito') : t('Ambito di riferimento')}</label><select id="ops-field-scope" name="scopeId">${scopeOptions(selectedScope)}</select></div></div>${!project.id ? ui`<label class="ops-check"><input type="checkbox" name="createScope" checked><span>Memoria e conversazione dedicate al progetto<small>Crea un ambito separato sotto quello scelto. Disattiva solo per usare esplicitamente la memoria dell’ambito esistente.</small></span></label>` : ''}`,project.id ? t('Salva modifiche') : t('Crea progetto'),async data => {
      const before = new Set(operations.projects.map(item => item.id));
      await operation(project.id ? 'saveProject' : 'createProject',{...(project.id ? {id:project.id,expectedVersion:project.version} : {}),title:data.get('title').trim(),description:data.get('description').trim(),scopeId:data.get('scopeId'),kind:data.get('kind'),...(!project.id ? {createScope:data.has('createScope')} : {})});
      const savedProject = project.id ? projectFor(project.id) : operations.projects.find(item=>!before.has(item.id));
      if (!project.id && savedProject) {
        workspace = await request('/api/workspace');
        try {await onScopeChange(savedProject.scopeId);scopeId=savedProject.scopeId;filter='current';}
        catch {filter='all';toast(t('Progetto creato. Seleziona il suo ambito per aprire la chat dedicata.'));}
      }
      projectId = savedProject?.id || null;
      if (projectFor(projectId)?.scopeId !== scopeId) filter = 'all';
      $('#ops-scope-filter').value = filter;tab = 'projects';render();toast(t('Progetto salvato.'));
    });
  }
  function taskForm(selectedProjectId,selectedWorkflowId) {
    localizeDialog = () => reopenProjectSelection(()=>taskForm(selectedProjectId,selectedWorkflowId));
    if (locked()) return;
    const project = projectFor(selectedProjectId) || visibleProjects()[0] || operations.projects[0];
    if (!project) {toast(t('Crea prima il progetto a cui affidare l’incarico.'));projectForm();return;}
    showForm(t('Un incarico con un risultato chiaro'),ui`<p class="ops-form-intro">Il lavoro viene preparato come bozza. Dopo aver salvato scegli quando avviare il modello AI; le chiamate API possono avere un costo.</p><div class="ops-field"><label for="ops-field-project">Progetto</label><select id="ops-field-project" name="projectId">${projectOptions(project.id)}</select></div>${field(t('Titolo dell’incarico'),'title','',{required:true,max:160})}${field(t('Brief e materiali da usare'),'brief','',{area:true,required:true,max:12000,hint:t('Includi informazioni, vincoli e criteri di accettazione. Il team ragiona sui materiali forniti: non può accedere automaticamente al web, ai tuoi file o ai repository.')})}<div class="ops-form-grid"><div class="ops-field"><label for="ops-field-agent">Responsabile</label><select id="ops-field-agent" name="agentId">${agentOptions('nova')}</select></div><div class="ops-field"><label for="ops-field-workflow">Procedura</label><select id="ops-field-workflow" name="workflowId">${taskWorkflowOptions(project)}</select><p class="ops-hint">Il percorso prodotto coinvolge il coordinatore e gli specialisti di ricerca, sviluppo e contenuti sui materiali forniti. Le altre procedure devono essere pronte e disponibili nell’ambito.</p></div></div>`,t('Salva incarico'),async data => {
      await operation('createTask',{projectId:data.get('projectId'),title:data.get('title').trim(),brief:data.get('brief').trim(),agentId:data.get('agentId'),...(data.get('workflowId') === '__product__' ? {template:'product-brief',workflowId:null} : {workflowId:data.get('workflowId') === '__single__' ? null : data.get('workflowId') || null})});
      projectId = data.get('projectId');tab = 'projects';render();toast(t('Incarico salvato. Aprilo per avviare il lavoro.'));
    });
    if(selectedWorkflowId&&[...dialog.querySelector('[name="workflowId"]').options].some(option=>option.value===selectedWorkflowId))dialog.querySelector('[name="workflowId"]').value=selectedWorkflowId;
    dialog.querySelector('[name="projectId"]').addEventListener('change',event => {dialog.querySelector('[name="workflowId"]').innerHTML = taskWorkflowOptions(projectFor(event.target.value));});
  }
  function routineForm(routine = {},selectedProjectId) {
    localizeDialog = () => reopenProjectSelection(()=>routineForm(routine,selectedProjectId));
    if (locked()) return;
    const project = projectFor(routine.projectId || selectedProjectId) || visibleProjects()[0] || operations.projects[0];
    if (!project) {toast(t('Crea prima un progetto per organizzare la routine.'));projectForm();return;}
    showForm(routine.id ? t('Rivedi la routine') : t('Un appuntamento con il tuo lavoro'),ui`<p class="ops-form-intro">${governance.getSettings()?.autonomousRoutines?t('Quando arriva la scadenza, una routine abilitata può creare e avviare automaticamente un incarico testuale, entro i limiti autorizzati. Le chiamate AI possono generare consumo.'):t('Quando arriva la scadenza, lo studio crea un incarico da avviare. L’avvio automatico è attualmente disattivato.')} Lo studio deve essere in esecuzione.</p><div class="ops-field"><label for="ops-field-project">Progetto</label><select id="ops-field-project" name="projectId">${projectOptions(project.id)}</select></div>${field(t('Titolo della routine'),'title',routine.title,{required:true,max:160})}${field(t('Brief dell’incarico ricorrente'),'brief',routine.brief,{area:true,required:true,max:12000})}<div class="ops-form-grid"><div class="ops-field"><label for="ops-field-agent">Responsabile</label><select id="ops-field-agent" name="agentId">${agentOptions(routine.agentId)}</select></div><div class="ops-field"><label for="ops-field-workflow">Procedura</label><select id="ops-field-workflow" name="workflowId">${workflowOptions(project,routine.workflowId)}</select></div></div><div class="ops-form-grid">${field(t('Intervallo in ore'),'intervalHours',routine.intervalHours || 168,{type:'number',required:true,min:1,max:720,step:1})}${field(t('Prossimo incarico · ora locale'),'nextRunAt',localDate(routine.nextRunAt),{type:'datetime-local',required:true})}</div><label class="ops-check"><input type="checkbox" name="enabled"${routine.enabled ? ' checked' : ''}><span>Routine attiva<small>${governance.getSettings()?.autonomousRoutines?t('Può avviare automaticamente gli incarichi entro i limiti autorizzati.'):t('Prepara incarichi da avviare manualmente.')}</small></span></label>`,routine.id ? t('Salva routine') : t('Crea routine'),async data => {
      await operation(routine.id ? 'updateRoutine' : 'createRoutine',{...(routine.id ? {id:routine.id,expectedVersion:routine.version} : {}),projectId:data.get('projectId'),title:data.get('title').trim(),brief:data.get('brief').trim(),agentId:data.get('agentId'),workflowId:data.get('workflowId') || null,intervalHours:Number(data.get('intervalHours')),nextRunAt:new Date(data.get('nextRunAt')).toISOString(),enabled:data.has('enabled')});
      tab = 'routines';render();toast(t('Routine salvata.'));
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
    if (!known) return ui`<span>Token: non disponibili</span>`;
    const number = value => new Intl.NumberFormat(locale()).format(value);
    return ui`<span>Token ${unknown ? t('noti ') : ''}in ingresso: ${inputKnown ? number(input) : t('non disponibili')}</span><span>In uscita: ${outputKnown ? number(output) : t('non disponibili')}</span>${unknown ? ui`<span>Conteggio parziale: alcuni valori non sono disponibili.</span>` : ''}`;
  }
  function contextDetails(context) {
    if (!context) return '';
    const documentSources=context.sources||[];
    const sourceLinks=documentSources.map(source=>{let url=null;try{const value=new URL(source.url);if(value.protocol==='https:'||value.protocol==='http:')url=value.href;}catch{}return ui`<li><strong>${html(source.title||t('Fonte'))}</strong> · v${html(source.version||source.sourceVersion||1)}${source.page?t(" · pagina {0}", {0: html(source.page)}):''}${source.lineStart?t(" · righe {0}{1}", {0: html(source.lineStart), 1: source.lineEnd?`–${html(source.lineEnd)}`:''}):''}${url?ui`<span><a href="${html(url)}" target="_blank" rel="noopener noreferrer">Apri origine ↗</a></span>`:''}</li>`;}).join('');
    const memories = context.memories || [],workflows = context.workflows || (context.workflow ? [context.workflow] : []);
    return ui`<details class="ops-context"><summary>Contesto utilizzato · ${memories.length} memorie${workflows.length ? t(" · {0} procedure", {0: workflows.length}) : ''}${documentSources.length?t(" · {0} fonti", {0: documentSources.length}):''}</summary><p>Ambito: ${html(context.scopeName || scopeName(context.scopeId))}. Le fonti indicano la provenienza delle note, non una verifica indipendente.</p>${memories.length ? ui`<ul>${memories.map(memory=>ui`<li><strong>${html(memory.title)}</strong> · v${html(memory.version)} · ${html(scopeName(memory.scopeId))}<span>Fonte: ${html(memory.source || t('Annotazione manuale'))}</span></li>`).join('')}</ul>` : ui`<p>Nessuna memoria aggiuntiva utilizzata.</p>`}${documentSources.length?ui`<ul>${sourceLinks}</ul>${context.scopeId===scopeId?ui`<button type="button" class="ops-text-button" data-dialog-action="sources">Consulta le fonti di questo ambito ↗</button>`:''}`:''}${workflows.length ? ui`<ul>${workflows.map(workflow=>ui`<li>Procedura: <strong>${html(workflow.title)}</strong> · v${html(workflow.version)}</li>`).join('')}</ul>` : ''}</details>`;
  }
  function dependencyMarkup(task) {
    if(!task.planId&&!task.dependencies?.length)return '';
    const parents=taskDependencies(task),pending=pendingDependencies(task);
    return ui`<section class="ops-dependencies"><h3>${html(task.planTitle||t('Dipendenze dell’incarico'))}</h3><p>${pending.length?t('Questo incarico attende che tutte le consegne precedenti siano completate e approvate.'):parents.length?t('Le consegne precedenti sono approvate: puoi avviare questo incarico.'):t('Questo è un punto di partenza del piano: non attende altri incarichi.')}</p>${parents.length?ui`<div>${parents.map(parent=>ui`<button type="button" data-dialog-action="dependency" data-id="${html(parent.id)}"${parent.status==='missing'?' disabled':''}><span>${html(parent.title)}</span>${badge(parent.status,dependencyApproved(parent)?t('Approvato'):state(parent.status))}</button>`).join('')}</div>`:''}</section>`;
  }
  function taskActions(task) {
    if(['queued','paused','failed'].includes(task.status)&&pendingDependencies(task).length)return ui`<button type="button" class="ops-button" disabled>Attende le consegne precedenti</button>`;
    if (task.status === 'running') return ui`<button type="button" class="ops-button" data-dialog-action="pause" data-id="${html(task.id)}" data-mutation>Metti in pausa</button>`;
    if (['queued','paused','failed'].includes(task.status)) return ui`<button type="button" class="ops-button is-primary" data-dialog-action="run" data-id="${html(task.id)}" data-mutation>${task.status === 'queued' ? t('Avvia il lavoro') : t('Riprendi il lavoro')}</button>${['paused','failed'].includes(task.status) ? ui`<button type="button" class="ops-button" data-dialog-action="restart" data-id="${html(task.id)}" data-mutation>Riparti dall’inizio</button>` : ''}`;
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
    dialogShell(task.title,ui`<div class="ops-task-body"><div class="ops-task-meta">${badge(task.status)}<span>${html(project?.title || '')} · ${html(scopeName(project?.scopeId))}</span><span>${html(agentName(task.agentId))}</span></div>${dependencyMarkup(task)}<details class="ops-disclosure"><summary>Brief e materiali di partenza</summary><p class="ops-prewrap">${html(task.brief)}</p></details>${task.error ? ui`<p class="ops-error" role="status">${html(typeof task.error === 'string' ? task.error : task.error.message || t('L’esecuzione richiede una verifica.'))}</p>` : ''}${task.steps?.length ? ui`<ol class="ops-steps">${task.steps.map((step,index) => ui`<li><span class="ops-step-number">${index + 1}</span><div><div class="ops-step-title"><strong>${html(step.title)}</strong>${badge(step.status,step.status === 'completed' ? t('Completato') : '')}</div><p>${html(agentName(step.agentId))}${step.execution?.provider ? ` · ${html(connectionName(step.execution.provider.id))}${step.execution.provider.model && step.execution.provider.model !== 'local-default' ? ` · ${html(step.execution.provider.model)}` : ''}` : ''}${Number.isFinite(step.execution?.durationMs) ? ` · ${Math.max(0,Math.round(step.execution.durationMs / 1000))} s` : ''}</p>${step.output ? ui`<details><summary>Leggi il risultato del passaggio</summary><div class="ops-prewrap">${html(step.output)}</div></details>` : ''}${contextDetails(step.context)}${step.error ? ui`<p class="ops-step-error">${html(typeof step.error === 'string' ? step.error : step.error.message)}</p>` : ''}</div></li>`).join('')}</ol>` : ui`<p class="ops-hint">I passaggi saranno disponibili quando il lavoro viene preparato.</p>`}<div class="ops-usage">${usageSummary(task)}</div>${artifact ? ui`<section class="ops-delivery" aria-labelledby="ops-delivery-title"><div class="ops-delivery-heading"><div><span class="ops-kind">${artifact.decision === 'approved' ? t('CONSEGNA APPROVATA') : artifact.decision === 'changes_requested' ? t('REVISIONE RICHIESTA') : t('CONSEGNA DA RIVEDERE')}</span><h3 id="ops-delivery-title">${html(artifact.title || task.title)}</h3></div><label class="ops-version-label">Versione<select id="ops-artifact-version">${versions.map((item,index) => ui`<option value="${index}"${index === selected ? ' selected' : ''}>${html(item.version || index + 1)} · ${html(state(item.decision || 'pending'))}</option>`).join('')}</select></label></div><div class="ops-artifact-text">${html(artifact.content || '')}</div>${contextDetails(artifact.context)}${artifact.feedback ? ui`<div class="ops-feedback"><strong>Feedback ricevuto</strong><p class="ops-prewrap">${html(artifact.feedback)}</p></div>` : ''}<div class="ops-delivery-actions"><button type="button" class="ops-button" data-dialog-action="download" data-id="${html(id)}">Scarica .md ↓</button>${latest && task.status === 'review' ? ui`<button type="button" class="ops-button is-primary" data-dialog-action="approve" data-id="${html(id)}" data-mutation>Approva consegna</button><button type="button" class="ops-button" data-dialog-action="changes" data-id="${html(id)}" data-mutation>Chiedi una revisione</button>` : ''}${latest && task.status === 'completed' && artifact.decision === 'approved' ? ui`<button type="button" class="ops-button" data-dialog-action="memory" data-id="${html(id)}" data-mutation>Proponi una memoria</button><button type="button" class="ops-button" data-dialog-action="outcome" data-id="${html(id)}" data-mutation>Valuta risultato</button><button type="button" class="ops-button" data-dialog-action="workflow" data-id="${html(id)}" data-mutation>Crea procedura</button>` : ''}</div></section>` : ui`<div class="ops-run-note">${task.status === 'running' ? t('Il lavoro continua sul server anche se aggiorni la pagina. Troverai qui la consegna da controllare.') : t('Avviando il lavoro autorizzi le chiamate al servizio assegnato agli agenti. Le API esterne possono generare consumi. Il risultato sarà una bozza da approvare.')}</div>`}${task.events?.length ? ui`<details class="ops-disclosure ops-events"><summary>Storico dell’incarico · ${task.events.length} eventi</summary><ol>${task.events.slice().reverse().map(event => ui`<li><time>${html(date(event.createdAt))}</time><span>${html(event.message || event.type)}</span></li>`).join('')}</ol></details>` : ''}</div>`,ui`<button type="button" class="ops-button" data-close>Chiudi</button>${taskActions(task)}`);
    if (wasOpen) {openDetails.forEach(index=>{const detail=dialog.querySelectorAll('details')[index];if (detail) detail.open=true;});dialog.scrollTop = oldScroll;if (focusedId) dialog.querySelector(`#${CSS.escape(focusedId)}`)?.focus({preventScroll:true});}
    dialog.querySelector('#ops-artifact-version')?.addEventListener('change',event => {artifactSelection.set(id,Number(event.target.value));renderTaskDialog(id);});
  }
  async function runTask(task,action) {
    await inlineMutation(async () => {
      await request(`/api/tasks/${action}`,{id:task.id,expectedVersion:task.version});
      await refreshOperations();renderTaskDialog(task.id);
      toast(action === 'pause' ? t('Pausa richiesta. I risultati già salvati rimangono disponibili.') : t('Lavoro avviato. Puoi continuare a usare lo studio.'));
    });
  }
  function restartTask(task) {
    localizeDialog = () => restartTask(task);
    showForm(t('Ripartire dall’inizio?'),ui`<p class="ops-form-intro">${html(task.title)}</p><p>I risultati intermedi salvati saranno rimossi e i passaggi verranno preparati di nuovo con il contesto attuale. Le versioni delle consegne restano conservate.</p><p class="ops-hint">Questa azione rimette l’incarico in attesa. Dovrai avviarlo esplicitamente.</p>`,t('Prepara un nuovo avvio'),async () => {await operation('restartTask',{id:task.id,expectedVersion:task.version});toast(t('Incarico pronto per ripartire.'));},{afterSave:()=>renderTaskDialog(task.id)});
  }
  function approveTask(task) {
    localizeDialog = () => approveTask(task);
    showForm(t('Approva questa consegna'),ui`<p class="ops-form-intro"><strong>${html(task.title)}</strong> · versione ${html(artifacts(task).at(-1)?.version || artifacts(task).length)}</p><p>Confermi di aver controllato la consegna. L’incarico sarà completato e il risultato rimarrà consultabile nel progetto.</p><p class="ops-hint">Approvare non pubblica, non invia messaggi e non modifica file esterni.</p>`,t('Approva consegna'),async () => {await operation('approveTask',{id:task.id,expectedVersion:task.version});toast(t('Consegna approvata.'));},{afterSave:()=>renderTaskDialog(task.id)});
  }
  function requestChanges(task) {
    localizeDialog = () => requestChanges(task);
    showForm(t('Cosa deve cambiare?'),ui`<p class="ops-form-intro">La versione attuale rimane conservata. Descrivi le modifiche necessarie; il prossimo avvio preparerà una nuova consegna.</p>${field(t('Feedback per il team'),'feedback','',{area:true,required:true,max:6000})}`,t('Richiedi revisione'),async data => {await operation('requestChanges',{id:task.id,feedback:data.get('feedback').trim(),expectedVersion:task.version});toast(t('Revisione richiesta. Avvia il lavoro quando sei pronto.'));},{afterSave:()=>renderTaskDialog(task.id)});
  }
  function memoryFromTask(task) {
    localizeDialog = () => memoryFromTask(task);
    const version = artifacts(task)[artifactSelection.get(task.id) ?? artifacts(task).length - 1];
    if (!version) return;
    showForm(t('Cosa vuoi conservare?'),ui`<p class="ops-form-intro">Dalla consegna approvata puoi ricavare una decisione o un metodo riutilizzabile. Sarà salvato come <strong>proposta da verificare</strong> nella memoria del progetto.</p>${field(t('Titolo della memoria'),'title',shorten(version.title || task.title,140),{required:true,max:160})}<div class="ops-field"><label for="ops-field-memory-type">Tipo</label><select id="ops-field-memory-type" name="type"><option value="pattern">Metodo riutilizzabile</option><option value="decision">Decisione</option></select></div>${field(t('Contenuto da conservare'),'content',String(version.content || '').slice(0,8000),{area:true,required:true,max:8000,hint:t('Rivedi il testo e conserva soltanto quello che può aiutare i prossimi incarichi.')})}`,t('Salva proposta'),async data => {await request('/api/tasks/memory',{id:task.id,title:data.get('title').trim(),content:data.get('content').trim(),type:data.get('type')});await onRefreshMemory();toast(t('Proposta salvata. Confermala nella memoria per renderla disponibile agli agenti.'));});
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
    localizeDialog = () => providerForm(connection);
    if (locked()) return;
    showForm(connection.id ? t('Modifica il servizio AI') : t('Collega un servizio AI'),ui`<p class="ops-form-intro">Usa una tua chiave API. Viene inviata al server locale e non viene conservata nel browser. Il collegamento non esegue chiamate al modello.</p>${field(t('Nome della connessione'),'name',connection.name,{required:true,max:100})}<div class="ops-form-grid"><div class="ops-field"><label for="ops-field-provider-type">Servizio</label><select id="ops-field-provider-type" name="type"${connection.id ? ' disabled' : ''}>${['openrouter','openai','anthropic','deepseek'].map(type=>ui`<option value="${type}"${connection.type === type ? ' selected' : ''}>${t(providerTypes[type])}</option>`).join('')}</select></div>${field(t('ID esatto del modello'),'model',connection.model,{required:true,max:200,hint:t('Copia l’identificativo del modello dalla documentazione del servizio.')})}</div>${field(connection.id ? t('Nuova chiave API · facoltativa') : t('Chiave API'),'apiKey','',{type:'password',required:!connection.id,max:1000,hint:connection.id ? t('Lascia vuoto per conservare la chiave già salvata. Il campo viene svuotato dopo l’invio.') : t('Il campo viene svuotato dopo l’invio.')})}<div class="ops-run-note">Per usare questa connessione assegna un agente e consenti il servizio negli ambiti pertinenti. Le chiamate vengono addebitate dal tuo fornitore.</div>`,t('Salva connessione'),async data => {
      const payload = {...(connection.id ? {id:connection.id} : {}),name:data.get('name').trim(),type:connection.type || data.get('type'),model:data.get('model').trim()};
      const secret = data.get('apiKey')?.trim();if (secret) payload.apiKey = secret;
      try {await providerMutation('saveConnection',payload);} finally {delete payload.apiKey;}
      toast(t('Connessione salvata. Non è stata eseguita alcuna chiamata al modello.'));
    });
  }
  function testProvider(connection) {
    localizeDialog = () => testProvider(connection);
    showForm(t('Verifica la connessione'),ui`<p class="ops-form-intro"><strong>${html(connection.name)}</strong> · ${html(connection.model)}</p><p>Il test invia una breve richiesta al modello. <strong>Può generare un piccolo consumo a pagamento</strong> sul tuo account presso il fornitore.</p><p class="ops-hint">Non invia memorie, documenti o contenuti dei tuoi progetti.</p>`,t('Esegui test a consumo'),async () => {
      const result = await request('/api/providers/test',{id:connection.id});
      acceptProviders(await request('/api/providers'));render();await onProviderChange();
      const usage = result.usage;
      toast(t("Connessione verificata.{0}", {0: Number.isFinite(usage?.inputTokens) || Number.isFinite(usage?.outputTokens) ? ` Token: ${Number.isFinite(usage.inputTokens) ? usage.inputTokens : t('non disponibili')} in ingresso, ${Number.isFinite(usage.outputTokens) ? usage.outputTokens : t('non disponibili')} in uscita.` : ''}));
    });
  }
  function deleteProvider(connection) {
    localizeDialog = () => deleteProvider(connection);
    showForm(t('Rimuovi la connessione?'),ui`<p class="ops-form-intro"><strong>${html(connection.name)}</strong></p><p>La configurazione e la chiave salvata saranno rimosse dallo studio. Controlla gli agenti assegnati a questo servizio prima di avviare altri incarichi.</p><p class="ops-hint">Questa azione non revoca la chiave presso il fornitore.</p>`,t('Rimuovi connessione'),async () => {await providerMutation('deleteConnection',{id:connection.id});toast(t('Connessione rimossa.'));},{danger:true});
  }

  panel.addEventListener('click',event => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) {tab = tabButton.dataset.tab;render();return;}
    const button = event.target.closest('[data-action]');if (!button || button.disabled) return;
    const {action,id} = button.dataset;
    if (action === 'refresh') {load();return;}
    if (action === 'new-project') {projectForm();return;}
    if (action === 'review-repository') {tab='repositories';render();repositories.openRun(id);return;}
    if (action === 'project') {projectId = id;render();return;}
    if (action === 'back-projects') {projectId = null;render();return;}
    if (action === 'edit-project') {projectForm(projectFor(id));return;}
    if (action === 'plan-project') {const selected=projectFor(button.dataset.projectId);if(selected&&!locked())planning.open(selected);return;}
    if (action === 'new-task') {taskForm(button.dataset.projectId);return;}
    if (action === 'task') {renderTaskDialog(id);return;}
    if (action === 'new-routine') {routineForm({},button.dataset.projectId);return;}
    if (action === 'edit-routine') {routineForm(operations.routines.find(routine=>routine.id === id));return;}
    if (action === 'toggle-routine') {const routine = operations.routines.find(item=>item.id === id);if (routine) inlineMutation(async()=>{await operation('updateRoutine',{id,expectedVersion:routine.version,enabled:!routine.enabled});toast(routine.enabled ? t('Routine sospesa.') : t('Routine attiva: preparerà incarichi da avviare.'));});return;}
    if (action === 'open-scope') {inlineMutation(async()=>{await onScopeChange(id);scopeId=id;filter='current';$('#ops-scope-filter').value=filter;render();toast(t("Chat aperta in {0}.", {0: scopeName(id)}));});return;}
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
    if (agentId) inlineMutation(async()=>{try {await providerMutation('assignAgent',{agentId,connectionId:event.target.value});toast(t('Servizio dell’agente aggiornato.'));} catch(error) {render();throw error;}});
  });
  panel.addEventListener('submit',event => {
    if (event.target.id !== 'ops-policy-form') return;
    event.preventDefault();const connectionIds=new FormData(event.target).getAll('connectionIds');
    inlineMutation(async()=>{await providerMutation('setScopePolicy',{scopeId,connectionIds});toast(t("Servizi consentiti aggiornati per {0}.", {0: scopeName(scopeId)}));});
  });
  panel.querySelector('[role="tablist"]').addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();const tabs=['projects','review','routines','repositories','github','sources','results','providers'];
    const index=tabs.indexOf(tab);tab=tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (index+(event.key === 'ArrowRight' ? 1 : -1)+tabs.length)%tabs.length];
    render();$(`[data-tab="${tab}"]`).focus();
  });
  dialog.addEventListener('click',event => {
    const button=event.target.closest('[data-dialog-action]');if (!button || button.disabled) return;
    if(button.dataset.dialogAction==='sources'){dialog.close();tab='sources';render();return;}
    const task=taskFor(button.dataset.id);if (!task) return;
    const action=button.dataset.dialogAction;
    if(action==='workflow'&&!locked()){dialog.close();onCreateWorkflow(task);return;}
    if(action==='outcome'){dialog.close();void governance.openOutcome({taskId:task.id,title:task.title});return;}
    if (action === 'dependency') {renderTaskDialog(task.id);return;}
    if ((action === 'run'&&!pendingDependencies(task).length) || action === 'pause') runTask(task,action);
    if (action === 'restart') restartTask(task);
    if (action === 'approve') approveTask(task);
    if (action === 'changes') requestChanges(task);
    if (action === 'memory') memoryFromTask(task);
    if (action === 'download') downloadArtifact(task);
  });
  onLanguageChange(() => { render(); if(dialog.open&&!mutating){if(dialogView?.kind==='task')renderTaskDialog(dialogView.id);else localizeDialog?.();} });
  async function newTask(workflow){
    if(workflow){await load();if(locked())return;const eligible=[projectFor(projectId),...visibleProjects()].filter(Boolean).find(project=>workflow.scopeId===project.scopeId||workflow.scopeId==='shared'||workflow.sharedWith?.includes(project.scopeId))||operations.projects.find(project=>workflow.scopeId===project.scopeId||workflow.scopeId==='shared'||workflow.sharedWith?.includes(project.scopeId));if(!eligible){toast(t('Scegli un progetto di questo ambito prima di usare la procedura.'));projectForm({scopeId:workflow.scopeId==='shared'?scopeId:workflow.scopeId});return;}taskForm(eligible.id,workflow.id);}
    else if(!locked()){const selected=projectFor(projectId)||operations.projects.find(project=>project.scopeId===scopeId);if(selected)taskForm(selected.id);else projectForm({scopeId});}
  }
  return {load,newTask,getRepositorySnapshot:()=>repositories.getSnapshot(),openSection(section) {if (!['projects','review','routines','repositories','github','sources','results','providers'].includes(section)) return;tab=section;projectId=null;render();},openTask(id) {if (taskFor(id)) renderTaskDialog(id);},setScope(id) {if (!id) return;scopeId=id;projectId=null;render();},setBusy(value) {busy=Boolean(value);syncLocks();}};
}
