import { t, ui, locale, bindText, onLanguageChange } from './i18n.js';
import { agents } from './data.js';
import { daylightMode, isNight, scopeIdentity } from './experience-state.js';
import { icon } from './studio-icons.js';

const labels = {chat:'Conversazione',projects:'Progetti',memory:'Memoria',workflows:'Procedure',context:'Contesto',meeting:'Riunioni'};
const help = {
  camera: 'Trascina per ruotare. Rotella o pizzico per avvicinarti. Shift + trascina, oppure due dita, per spostarti. Le postazioni e i nomi dei colleghi si possono aprire con un clic.',
  daylight: 'Automatico segue l’ora locale del dispositivo: giorno dalle 07:00 alle 19:00. Puoi scegliere sempre giorno o sempre notte. Di notte il fuoco e le lampade illuminano ogni scenario.',
  load: 'L’attività segue agenti attivi, passaggi da svolgere e durata del lavoro. È un indicatore visivo, non una misura della difficoltà del ragionamento. Solo errori reali fanno arrivare un intruso; revisioni e approvazioni sono normali.',
  immersive: 'Espandi lo scenario e continua a lavorare: le postazioni aprono progetti, memoria e conversazione in un pannello laterale. Esc torna alla pagina.',
  memory: 'Conserva informazioni, decisioni e preferenze. Le proposte entrano nel contesto degli agenti dopo la tua conferma. Ogni memoria mantiene ambito, fonte e versioni.',
  context: 'Ogni ambito ha una propria conversazione e memoria. Il profilo comune attraversa gli ambiti; le altre informazioni si condividono soltanto tramite collegamenti espliciti. Colori e postazioni non cambiano questi permessi.',
  workflows: 'Una procedura descrive un metodo riutilizzabile: passaggi, agenti e risultato atteso. Puoi applicarla in chat o usarla per organizzare un incarico.',
  projects: 'Raccogli obiettivi, incarichi e consegne dei tuoi prodotti. Scegli un ambito dedicato per conservare il contesto del progetto. Avvii il lavoro e approvi tu il risultato.',
  meeting: 'Quando più agenti partecipano allo stesso incarico o alla stessa risposta, si ritrovano qui. Il pannello mostra chi lavora e il passaggio attuale. Aprirlo non avvia chiamate AI.',
  chat: 'Il coordinatore coinvolge gli specialisti necessari. La risposta usa il contesto autorizzato dell’ambito selezionato e il servizio AI assegnato a ciascun agente.',
  review: 'Una consegna da approvare non è un errore. Puoi accettarla o chiedere una revisione; le versioni precedenti restano conservate.',
  providers: 'Assegna un servizio AI a ogni agente e scegli quali servizi possono ricevere il contesto di questo ambito. Le credenziali restano nella configurazione locale del server.',
  routines: 'Le routine preparano incarichi a intervalli regolari. Il lavoro AI parte soltanto con il tuo avvio esplicito.',
  quiet: 'Ferma movimenti di animali, personaggi e fuoco. La luce notturna resta accesa. Lo studio rispetta anche la preferenza del dispositivo per il movimento ridotto.'
};

export function createStudioExperience({world, knowledge, operations}) {
  const $ = selector => document.querySelector(selector);
  const body = document.body, workspace = $('.workspace'), worldHost = $('#office-world');
  let mode = 'auto', immersive = false, currentPanel = null, currentScope = null, lastActivity = null, returnFocus = null, meetingSignature = null;
  const moved = new Map(), markers = new Map();
  try { mode = daylightMode(localStorage.getItem('fuori-studio-daylight')); } catch { /* Storage is optional. */ }

  const controls = document.createElement('div');
  controls.className = 'studio-controls';
  controls.innerHTML = ui`<div class="studio-context-strip"><span class="scope-identity" id="studio-scope"></span><span class="studio-clock"><time id="studio-clock"></time><span id="studio-day-label"></span></span></div><div class="studio-control-actions"><label class="studio-theme-control" for="daylight-mode"><span id="daylight-icon">${icon('sun')}</span><span class="visually-hidden">Illuminazione dello studio</span><select id="daylight-mode"><option value="auto">Ora locale</option><option value="day">Sempre giorno</option><option value="night">Sempre notte</option></select></label><button class="studio-controls-button" type="button" id="toggle-chat" aria-pressed="true" aria-label="Mostra o nascondi la conversazione">${icon('chat')}<span>Chat</span></button><button class="studio-controls-button" type="button" id="toggle-immersive" aria-pressed="false">${icon('expand')}<span>Tutto schermo</span></button></div>`;
  worldHost.before(controls);
  const activity = document.createElement('div');
  activity.className = 'world-activity';
  activity.innerHTML = ui('<span class="activity-meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span id="world-load-label">Spazio alle idee</span>');
  worldHost.append(activity);
  const nav = document.createElement('nav');
  nav.className = 'world-dock';
  nav.setAttribute('aria-label',t('Postazioni dello studio'));
  const renderNav=()=>{nav.innerHTML=Object.entries(labels).map(([kind,label])=>ui`<button type="button" data-studio-open="${kind}" aria-label="Apri ${t(label)}">${icon(kind)}<span>${t(label)}</span></button>`).join('');nav.setAttribute('aria-label',t('Postazioni dello studio'));};
  renderNav();
  worldHost.append(nav);
  const dock = document.createElement('aside');
  dock.id = 'studio-dock';dock.hidden = true;dock.setAttribute('aria-label',t('Pannello di lavoro'));
  dock.innerHTML = ui('<div class="studio-dock-head"><strong id="studio-dock-title"></strong><button type="button" class="icon-button" id="studio-dock-close" aria-label="Chiudi pannello di lavoro">✕</button></div><div class="studio-dock-body"></div>');
  workspace.append(dock);
  const meeting = document.createElement('section');
  meeting.id = 'meeting-panel';meeting.className = 'meeting-panel';meeting.hidden = true;
  meeting.setAttribute('aria-labelledby','meeting-title');
  meeting.innerHTML = ui`<div class="section-title"><div><div class="eyebrow">IL TAVOLO DELLO STUDIO</div><h2 id="meeting-title">Le idee si incontrano.</h2></div>${icon('meeting')}</div><div id="meeting-content"></div>`;
  $('.team-section').before(meeting);

  const tooltip = document.createElement('div');
  tooltip.className = 'help-popover';tooltip.id = 'studio-help-popover';tooltip.setAttribute('role','tooltip');tooltip.hidden = true;
  body.append(tooltip);
  let helpOwner = null, helpPinned = false, helpDismissTimer = null;
  function closeHelp() {
    clearTimeout(helpDismissTimer);
    if (helpOwner) {helpOwner.removeAttribute('aria-describedby');helpOwner.setAttribute('aria-expanded','false');}
    helpOwner = null;helpPinned = false;tooltip.hidden = true;
  }
  function positionHelp() {
    if (!helpOwner) return;
    const rect = helpOwner.getBoundingClientRect();
    tooltip.style.left = `${Math.max(12,Math.min(rect.left,innerWidth-tooltip.offsetWidth-12))}px`;
    tooltip.style.top = `${rect.bottom + tooltip.offsetHeight + 12 < innerHeight ? rect.bottom + 8 : Math.max(12,rect.top-tooltip.offsetHeight-8)}px`;
  }
  function showHelp(button, pinned = false) {
    closeHelp();helpOwner = button;helpPinned = pinned;
    bindText(tooltip,help[button.dataset.help]);tooltip.hidden = false;
    button.setAttribute('aria-describedby',tooltip.id);button.setAttribute('aria-expanded','true');positionHelp();
  }
  function addHelp(selector, key, title) {
    const target = $(selector);
    if (!target) return;
    const button = document.createElement('button');
    button.type = 'button';button.className = 'help-button';button.dataset.help = key;button.textContent = '?';
    button.dataset.helpTitle=title;button.setAttribute('aria-label',t('Aiuto: {title}',{title:t(title)}));button.setAttribute('aria-expanded','false');
    // A sibling button keeps the heading/label semantics while staying visually compact.
    if (target.matches('h2, select, .knowledge-tabs')) {
      const wrapper = document.createElement('div');wrapper.className = target.matches('h2') ? 'help-heading' : 'help-field';
      target.before(wrapper);wrapper.append(target,button);
    } else target.after(button);
  }
  addHelp('#office-title','camera','esplora lo scenario');
  addHelp('.studio-theme-control','daylight','giorno e notte');
  addHelp('#world-load-label','load','attività e animali');
  addHelp('#toggle-immersive','immersive','tutto schermo');
  addHelp('#chat-title','chat','conversazione');
  addHelp('#knowledge-title','memory','memoria');
  addHelp('#knowledge-scope','context','ambiti e contesto');
  addHelp('.knowledge-tabs','workflows','procedure');
  addHelp('#operations-title','projects','progetti');
  addHelp('#meeting-title','meeting','riunioni');
  // Tab help lives outside tablists so arrow-key navigation retains tab semantics.
  const legend = document.createElement('div');legend.className = 'studio-legend';
  legend.innerHTML = ui('<span>Conosci lo studio</span>');
  for (const key of ['review','providers','routines','quiet']) {
    const item=document.createElement('span'),label=document.createElement('span'),title={review:'Consegne',providers:'Servizi AI',routines:'Routine',quiet:'Animazioni'}[key];bindText(label,title);item.append(label);
    const button=document.createElement('button');button.type='button';button.className='help-button';button.dataset.help=key;button.dataset.helpTitle=title;button.textContent='?';button.setAttribute('aria-label',t('Aiuto: {title}',{title:t(title)}));button.setAttribute('aria-expanded','false');item.append(button);legend.append(item);
  }
  $('#operations-panel').append(legend);
  document.addEventListener('pointerover',event => {const button = event.target.closest('.help-button');if (button && !helpPinned && button !== helpOwner && event.pointerType !== 'touch') showHelp(button);});
  document.addEventListener('pointerout',event => {if (!helpPinned && helpOwner && event.target.closest('.help-button') === helpOwner && !helpOwner.contains(event.relatedTarget) && !tooltip.contains(event.relatedTarget)) helpDismissTimer = setTimeout(closeHelp,180);});
  tooltip.addEventListener('pointerenter',() => clearTimeout(helpDismissTimer));
  tooltip.addEventListener('pointerleave',() => {if (!helpPinned) closeHelp();});
  document.addEventListener('focusin',event => {if (event.target.matches('.help-button')) showHelp(event.target);else if (!helpPinned) closeHelp();});
  document.addEventListener('click',event => {
    const button = event.target.closest('.help-button');
    if (button) {if (button === helpOwner && helpPinned) closeHelp();else showHelp(button,true);return;}
    if (!tooltip.contains(event.target)) closeHelp();
    const open = event.target.closest('[data-studio-open]');
    if (open) openPanel(open.dataset.studioOpen);
  });
  window.addEventListener('resize',positionHelp);
  document.addEventListener('scroll',closeHelp,true);

  function syncDaylight() {
    const date = new Date(), night = isNight(mode,date);
    body.dataset.theme = night ? 'night' : 'day';document.documentElement.dataset.theme = body.dataset.theme;
    $('#daylight-mode').value = mode;
    $('#studio-clock').textContent = date.toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit'});
    $('#studio-clock').dateTime = date.toISOString();
    $('#studio-day-label').textContent = `${night ? t('Notte') : t('Giorno')}${mode === 'auto' ? t(' · ora locale') : t(' · manuale')}`;
    $('#daylight-icon').innerHTML = icon(night ? 'moon' : 'sun');
    document.querySelector('meta[name="theme-color"]').content = night ? '#111315' : '#f2f0e9';
    world?.setNight(night);
  }
  $('#daylight-mode').addEventListener('change',event => {mode = daylightMode(event.target.value);try {localStorage.setItem('fuori-studio-daylight',mode);} catch { /* Optional persistence. */ }syncDaylight();});
  const clockTimer = setInterval(syncDaylight,30000);
  document.addEventListener('visibilitychange',() => {if (!document.hidden) syncDaylight();});
  window.addEventListener('storage',event => {if (event.key === 'fuori-studio-daylight') {mode = daylightMode(event.newValue);syncDaylight();}});

  function restorePanels() {
    for (const [panel,placeholder] of moved) {placeholder.replaceWith(panel);}
    moved.clear();dock.hidden = true;
  }
  function syncButtons() {
    $('#toggle-immersive').setAttribute('aria-pressed',String(immersive));
    bindText($('#toggle-immersive span'),immersive?'Esci':'Tutto schermo');
    $('#toggle-chat').setAttribute('aria-pressed',String(immersive ? currentPanel === 'chat' : !body.classList.contains('chat-collapsed')));
    nav.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(currentPanel === button.dataset.studioOpen)));
  }
  function closePanel({focus = true} = {}) {
    const closing = currentPanel;restorePanels();currentPanel = null;delete body.dataset.studioPanel;
    meeting.hidden = true;syncButtons();
    if (focus && closing) nav.querySelector(`[data-studio-open="${closing}"]`)?.focus({preventScroll:true});
  }
  function openPanel(kind) {
    if (!labels[kind]) return;
    closeHelp();restorePanels();currentPanel = kind;body.dataset.studioPanel = kind;
    if (kind === 'projects') operations.openSection('projects');
    if (kind === 'memory' || kind === 'context') knowledge.openSection('memories');
    if (kind === 'workflows') knowledge.openSection('workflows');
    const panel = kind === 'chat' ? $('.chat-panel') : kind === 'projects' ? $('#operations-panel') : kind === 'meeting' ? meeting : $('#knowledge-panel');
    meeting.hidden = kind !== 'meeting';
    if (kind === 'chat') body.classList.remove('chat-collapsed');
    if (immersive && kind !== 'chat') {
      const placeholder = document.createComment(`studio:${kind}`);panel.before(placeholder);moved.set(panel,placeholder);
      dock.querySelector('.studio-dock-body').append(panel);bindText($('#studio-dock-title'),labels[kind]);dock.hidden = false;dock.querySelector('.studio-dock-body').scrollTop = 0;
    } else if (!immersive) panel.scrollIntoView({behavior:body.classList.contains('focus-mode') ? 'instant' : 'smooth',block:'start'});
    syncButtons();
    const focus = kind === 'chat' ? $('#chat-input') : kind === 'context' ? $('#knowledge-scope') : panel.querySelector('h2');
    if (focus) {if (!['INPUT','SELECT','TEXTAREA'].includes(focus.tagName)) focus.tabIndex = -1;focus.focus({preventScroll:true});}
  }
  function setImmersive(enabled) {
    immersive = enabled;body.classList.toggle('studio-immersive',enabled);closeHelp();
    if (!enabled) {closePanel({focus:false});returnFocus?.focus({preventScroll:true});}
    else {closePanel({focus:false});$('#toggle-immersive').focus({preventScroll:true});}
    syncButtons();window.dispatchEvent(new Event('resize'));
  }
  $('#toggle-immersive').addEventListener('click',async () => {
    if (immersive) {setImmersive(false);if (document.fullscreenElement) await document.exitFullscreen().catch(()=>{});return;}
    returnFocus = document.activeElement;setImmersive(true);
    if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen().catch(()=>{});
  });
  document.addEventListener('fullscreenchange',() => {if (!document.fullscreenElement && immersive) setImmersive(false);});
  document.addEventListener('keydown',event => {
    if (event.key !== 'Escape') return;
    if (helpOwner) {closeHelp();event.preventDefault();return;}
    if (document.querySelector('dialog[open]')) return;
    if (immersive) {setImmersive(false);if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});event.preventDefault();}
  });
  $('#toggle-chat').addEventListener('click',() => {if (immersive) {currentPanel === 'chat' ? closePanel() : openPanel('chat');} else {body.classList.toggle('chat-collapsed');syncButtons();}});
  $('#studio-dock-close').addEventListener('click',() => closePanel());
  document.addEventListener('click',event => {
    const anchor = event.target.closest('a[href="#knowledge-title"],a[href="#operations-title"]');
    if (anchor && immersive) {event.preventDefault();openPanel(anchor.hash === '#knowledge-title' ? 'memory' : 'projects');}
  });

  function setScope(scope) {
    currentScope = scope || {id:'business',get name(){return t('Imprenditoria');}};
    const identity = scopeIdentity(currentScope), badge = $('#studio-scope');
    badge.replaceChildren();badge.insertAdjacentHTML('beforeend',icon(identity.icon));
    const name = document.createElement('span');name.textContent = identity.name;badge.append(name);
    badge.dataset.scopeKind = identity.kind;badge.style.setProperty('--scope-color',identity.color);
    body.style.setProperty('--scope-color',identity.color);
    for (const panel of [$('#knowledge-panel'),$('.knowledge-chat-scope')]) {panel.dataset.scopeKind = identity.kind;panel.style.setProperty('--scope-color',identity.color);}
    world?.setContext({name:identity.name,kind:identity.kind,color:identity.color});
  }
  function setActivity(value) {
    lastActivity = value;world?.setActivity(value);
    bindText($('#world-load-label'),value.label);
    activity.dataset.level = value.problemKey ? 'problem' : value.load >= .7 ? 'busy' : value.load > 0 ? 'working' : 'idle';
    activity.querySelectorAll('i').forEach((bar,index) => bar.classList.toggle('active',index < Math.ceil(value.load*5)));
    const signature = JSON.stringify(value.meeting);
    if (signature === meetingSignature) return;
    meetingSignature = signature;
    const content = $('#meeting-content'), restoreMeetingFocus = content.contains(document.activeElement);
    content.replaceChildren();
    if (!value.meeting) {
      const empty = document.createElement('div');empty.className = 'meeting-empty';empty.innerHTML = ui`${icon('meeting')}<h3>Un posto per pensare insieme.</h3><p>Il tavolo si anima quando due o più colleghi lavorano allo stesso incarico o alla stessa risposta.</p><button type="button" class="button primary" data-studio-open="projects">Apri i progetti</button>`;content.append(empty);if (restoreMeetingFocus) empty.querySelector('button').focus({preventScroll:true});return;
    }
    const title = document.createElement('h3');if(value.meeting.titleSource)bindText(title,value.meeting.titleSource);else title.textContent=value.meeting.title;
    const stage = document.createElement('p');stage.className = 'meeting-stage';if(value.meeting.stageSource)bindText(stage,value.meeting.stageSource);else stage.textContent=value.meeting.stage;
    const list = document.createElement('div');list.className = 'meeting-participants';
    for (const id of value.meeting.participants) {
      const agent = agents.find(item => item.id === id);if (!agent) continue;
      const row = document.createElement('div');row.className = 'meeting-participant';row.style.setProperty('--agent-color',agent.color);
      row.innerHTML = ui('<span class="meeting-avatar" aria-hidden="true"></span><strong></strong><span class="meeting-person-state"></span>');
      row.children[0].textContent = agent.name[0];row.children[1].textContent = agent.name;bindText(row.children[2],value.activeAgentIds.includes(id)?'Al lavoro':'Nel team dell’incarico');list.append(row);
    }
    const note = document.createElement('p');note.className = 'muted';bindText(note,'Il tavolo rappresenta il coordinamento. I passaggi dell’incarico vengono eseguiti in ordine; la chat può coinvolgere più specialisti insieme.');
    const button = document.createElement('button');button.type = 'button';button.className = 'button primary';bindText(button,value.meeting.taskId?'Apri l’incarico':'Apri la conversazione');button.addEventListener('click',() => {if (value.meeting.taskId) operations.openTask(value.meeting.taskId);else openPanel('chat');});
    content.append(title,stage,list,note,button);if (restoreMeetingFocus) button.focus({preventScroll:true});
  }
  function updateStations(positions) {
    for (const station of positions) {
      let button = markers.get(station.id);
      if (!button) {button = document.createElement('button');button.type = 'button';button.className = 'station-marker';button.dataset.studioOpen = station.kind;button.innerHTML = ui`${icon(station.kind)}<span></span>`;worldHost.append(button);markers.set(station.id,button);}
      const source={memory:'Memorie',projects:'Progetti',workflows:'Procedure',context:'Contesto',meeting:'Riunione',chat:'Conversazione'}[station.kind],label=source?t(source):station.label;
      if(button.querySelector('span').textContent!==label){if(source)bindText(button.querySelector('span'),source);else button.querySelector('span').textContent=label;button.setAttribute('aria-label',t('Apri {name}',{name:label}));}button.dataset.stationSource=source||'';
      button.hidden = !station.visible;button.style.left = `${station.x}px`;button.style.top = `${station.y}px`;
    }
  }
  for(const [selector,source] of [['.studio-theme-control .visually-hidden','Illuminazione dello studio'],['#daylight-mode [value=auto]','Ora locale'],['#daylight-mode [value=day]','Sempre giorno'],['#daylight-mode [value=night]','Sempre notte'],['#toggle-chat span','Chat'],['#meeting-title','Le idee si incontrano.'],['#meeting-panel .eyebrow','IL TAVOLO DELLO STUDIO'],['.studio-legend>span:first-child','Conosci lo studio']])bindText($(selector),source);
  onLanguageChange(()=>{renderNav();syncButtons();syncDaylight();dock.setAttribute('aria-label',t('Pannello di lavoro'));$('#studio-dock-close').setAttribute('aria-label',t('Chiudi pannello di lavoro'));$('#toggle-chat').setAttribute('aria-label',t('Mostra o nascondi la conversazione'));for(const button of document.querySelectorAll('.help-button[data-help-title]'))button.setAttribute('aria-label',t('Aiuto: {title}',{title:t(button.dataset.helpTitle)}));for(const button of markers.values())if(button.dataset.stationSource)button.setAttribute('aria-label',t('Apri {name}',{name:t(button.dataset.stationSource)}));if(helpOwner)positionHelp();if(lastActivity){meetingSignature=null;setActivity(lastActivity);}});
  syncDaylight();setScope();setActivity({load:0,label:'Spazio alle idee',problemKey:null,collaboratingIds:[],activeAgentIds:[],meeting:null});
  window.addEventListener('pagehide',event => {if (!event.persisted) clearInterval(clockTimer);});
  window.addEventListener('pageshow',syncDaylight);
  return {openPanel,setScope,setActivity,updateStations,getDiagnostics:() => ({mode,night:isNight(mode),immersive,panel:currentPanel,scope:currentScope?.id,load:lastActivity?.load,meeting:lastActivity?.meeting?.participants || []})};
}
