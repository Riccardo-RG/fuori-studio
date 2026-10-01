import {createConversationTasks} from './conversation-tasks.js';
import {createExecutionPreviewDialog} from './execution-preview.js';
import {createRepositoryAnalysisDialog,repositoryAnalysisDraftMatches} from './repository-analysis.js';
import {createSearchPanel} from './search.js';
import {createQuickActions} from './quick-actions.js';
import {renameAgent, teamVersion} from './team.js';
import {capabilityFormHTML,bindCapabilityForm} from './agent-capabilities.js';
import {t, ui, locale, onLanguageChange, bindText} from './i18n.js';
import { createOfficeWorld } from './world.js';
import { createExplorationControls } from './exploration.js';
import { projects,agents } from './data.js';
import { createKnowledgePanel } from './knowledge.js';
import { createOperationsPanel } from './operations.js';
import { createStudioExperience } from './experience.js';
import { deriveActivity, repositoryActivityTasks } from './experience-state.js';
import { createAccessPanel } from './access.js';
const $=s=>document.querySelector(s);
const escapeHTML=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let exploration=null;
let officeWorld=null,running=false,taskRunning=false,ready=false,controller=null,toastTimer=null;
let currentConversationId=null,currentProjectId=null;
let knowledge=null,operations=null,currentScopeName='Imprenditoria',currentScope='business',selectedWorkflow=null,studioPoll=null;
let chatStarting=false,analysisOpening=false,pendingRepositoryAnalysis=null;
const executionPreview=createExecutionPreviewDialog();
const repositoryAnalysis=createRepositoryAnalysisDialog({getScopeId:()=>currentScope,getBusy:()=>running||taskRunning||chatStarting,toast});
let search=null,workspaceScopes=[],workspaceWorkflows=[],selectedWorkflowInputs=null;
let conversationTasks=null,quickActions=null,experience=null,activitySnapshot={tasks:[]},chatStartedAt=null,chatProblemKey=null;
const chatParticipants=new Set();
const activeAgents=new Map(),seenMessages=new Set(),messageRecords=new Map(),agentStates=new Map();
let shownAgent=null,lastProvider=null,agentNameSaving=false,agentEditVersion=1;
function activityTasks(){return [...(activitySnapshot.tasks||[]),...repositoryActivityTasks(activitySnapshot.repositoryRuns||[])];}
function syncExperience(){quickActions?.setContext({scopeName:currentScopeName,reviewCount:activityTasks().filter(task=>task.scopeId===currentScope&&task.decision?.status!=='changes_requested'&&['review','failed','paused'].includes(task.status)).length,busy:running||activityTasks().some(task=>task.status==='running')});experience?.setActivity(deriveActivity({tasks:activityTasks(),chat:{running,activeAgentIds:running?[...activeAgents.keys()]:[],participantIds:[...chatParticipants],startedAt:chatStartedAt,problemKey:chatProblemKey}}));}
export function getStudioDiagnostics(){return {experience:experience?.getDiagnostics(),world:officeWorld?.getDiagnostics()};}
const avatar=a=>ui`<span class="avatar-window" style="--agent-color:${a.color}" aria-hidden="true">${escapeHTML(a.name.slice(0,1))}</span>`;
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=t(message);$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3400);}
function renderText(text){return escapeHTML(text).replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g,'<pre><code>$1</code></pre>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`\n]+)`/g,'<code>$1</code>');}
function renderAgents(){$('#agent-grid').innerHTML=agents.map(a=>ui`<button class="agent-card${a.id==='nova'?' is-leader':''}" style="--agent-color:${a.color}" data-agent="${a.id}" aria-label="Conosci ${escapeHTML(a.name)}, ${a.role}"><div class="agent-card-head">${avatar(a)}<div><h3>${escapeHTML(a.name)}${a.id==='nova'?ui`<span class="leader-badge">Leader</span>`:''}</h3><p class="agent-role">${a.role}</p></div></div><p class="agent-task">${a.task}</p><div class="agent-foot"><span class="agent-state">Disponibile</span><span class="agent-link" aria-hidden="true">↗</span></div></button>`).join('');for(const [id,value] of agentStates) updateAgent(id,value.status,value.task);}
renderAgents();
agents.forEach(a=>{const button=document.createElement('button');button.className='office-agent';button.dataset.agent=a.id;button.setAttribute('aria-label',t('Conosci {name}, {role}',{name:a.name,role:a.role}));button.style.setProperty('--agent-color',a.color);button.innerHTML=ui`<span class="agent-nameplate"><span class="person-dot"></span>${escapeHTML(a.name)}${a.id==='nova'?ui`<span class="leader-badge">Leader</span>`:''}<span class="person-plus">＋</span></span>`;$('#office-world').append(button);});
function focusChat(text){experience?.openPanel('chat');if(typeof text==='string')$('#chat-input').value=text;$('#chat-input').scrollIntoView({behavior:'smooth',block:'center'});$('#chat-input').focus({preventScroll:true});}
$('#new-mission').addEventListener('click',()=>focusChat());
document.querySelectorAll('[data-chat-prompt]').forEach(button=>button.addEventListener('click',()=>focusChat(button.dataset.chatPrompt)));
document.querySelectorAll('[data-project]').forEach(button=>button.addEventListener('click',()=>{const p=projects.find(p=>p.id===button.dataset.project);focusChat(t('Parliamo di {name}: ',{name:p.name}));}));
function openDialog(eyebrow,content){$('#dialog-eyebrow').textContent=t(eyebrow);$('#dialog-body').innerHTML=content;if(!$('#detail-dialog').open)$('#detail-dialog').showModal();}
function showAgent(id){
 const a=agents.find(a=>a.id===id);if(!a||agentNameSaving)return;
 const opening=shownAgent!==id||!$('#detail-dialog').open;
 if(opening)agentEditVersion=teamVersion();
 shownAgent=id;
 openDialog('IL TUO TEAM · COLLEGA AI',ui`<div class="dialog-agent-header">${avatar(a)}<div><h2 id="dialog-title" class="dialog-title" style="color:${a.color}">${escapeHTML(a.name)}</h2><p class="muted">${a.role}</p></div></div><p class="agent-quote">“${a.quote}”</p><p class="dialog-description">${a.description}</p><div class="dialog-section"><h3>Cosa porta al team</h3><ul>${a.skills.map(s=>ui`<li>${s}</li>`).join('')}</ul></div><p class="dialog-note">In chat e negli incarichi il team analizza i materiali forniti e prepara testi. Usa Repository per modificare codice e Fonti per raccogliere ricerca web.</p>${capabilityFormHTML(a.id,{reset:opening})}<form id="agent-name-form" class="agent-name-editor"><label for="agent-display-name">Nome del membro del team</label><div class="agent-name-row"><input id="agent-display-name" name="name" value="${escapeHTML(a.name)}" required maxlength="60" autocomplete="off" aria-describedby="agent-name-help"><button type="submit" class="button primary">Salva nome</button></div><p id="agent-name-help">Da 1 a 60 caratteri. Il nome è condiviso tra i dispositivi che accedono a questo studio.</p><p id="agent-name-error" role="alert" hidden></p></form><div class="dialog-actions"><button class="button primary" id="talk-to-agent">Parla con ${escapeHTML(a.name)} ↗</button></div>`);
 $('#talk-to-agent').addEventListener('click',()=>{$('#detail-dialog').close();focusChat(`@${a.name} `);});
 bindCapabilityForm(a.id,{isBusy:()=>agentNameSaving,onSaving:value=>{agentNameSaving=value;},onSaved:()=>{toast(t('Specializzazione aggiornata.'));showAgent(a.id);}});
 const form=$('#agent-name-form');
 form.addEventListener('submit',async event=>{
   event.preventDefault();if(agentNameSaving||!form.reportValidity())return;
   const input=form.querySelector('input'),button=form.querySelector('button'),error=form.querySelector('[role="alert"]');
   agentNameSaving=true;input.disabled=true;button.disabled=true;error.hidden=true;
   try{await renameAgent(a.id,input.value,agentEditVersion);agentEditVersion=teamVersion();toast(t('Nome del team aggiornato.'));}
   catch(failure){error.textContent=failure.message;error.hidden=false;}
   finally{agentNameSaving=false;input.disabled=false;button.disabled=false;if(error.hidden&&$('#detail-dialog').open)showAgent(a.id);}
 });
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-agent]');if(button)showAgent(button.dataset.agent);});
$('#close-dialog').addEventListener('click',()=>$('#detail-dialog').close());$('#detail-dialog').addEventListener('click',e=>{if(e.target!==$('#detail-dialog'))return;const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();});
function updateAgent(id,status,task){const agent=agents.find(a=>a.id===id);if(!agent)return;const card=$(`.agent-card[data-agent="${id}"]`),badge=$(`.office-agent[data-agent="${id}"]`);agentStates.set(id,{status,task});const active=status==='Al lavoro';officeWorld?.setAgentStatus(id,status);card.classList.toggle('busy',active);badge.classList.toggle('busy',active);card.querySelector('.agent-state').textContent=t(status);card.querySelector('.agent-task').textContent=task===undefined||task===null||status!=='Al lavoro'?agent.task:task;if(active){activeAgents.set(id,agent.name);if(running)chatParticipants.add(id);}else activeAgents.delete(id);const names=[...activeAgents.values()];$('#chat-thinking').hidden=names.length===0;$('#chat-thinking').textContent=names.length?t(names.length===1?'{names} sta pensando…':'{names} stanno collaborando…',{names:names.join(', ')}):'';$('#team-status').textContent=names.length?t(names.length===1?'{count} collega al lavoro':'{count} colleghi al lavoro',{count:names.length}):t('5 colleghi pronti');if(names.length)$('#office-message').textContent=names.length===1?t('{name} sta preparando una risposta.',{name:names[0]}):t('{names} si dividono il lavoro.',{names:new Intl.ListFormat(locale(),{type:'conjunction'}).format(names)});syncExperience();}
function addMessage(message){if(seenMessages.has(message.id))return;seenMessages.add(message.id);messageRecords.set(message.id,message);const agent=agents.find(a=>a.id===message.agentId);const element=document.createElement('article');element.className='chat-message '+(message.role==='user'?'from-user':'from-team');element.dataset.messageId=message.id;const stamp=new Date(message.createdAt).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit'});element.innerHTML=ui`<div class="chat-message-head"><span class="chat-person" style="--person-color:${agent?.color||'#4e6843'}">${message.role==='user'?t('Tu'):escapeHTML(agent?.name||'Studio')}</span><time>${stamp}</time></div><div class="chat-message-body">${renderText(message.text)}</div>`;$('#chat-messages').append(element);$('#chat-messages').scrollTop=$('#chat-messages').scrollHeight;$('#chat-starters')?.remove();$('.chat-starters').hidden=seenMessages.size>1;decorateMessage(element,message);}
function updateContext(projectId){if(projectId!==undefined)currentProjectId=projectId||null;$('#chat-context').textContent=currentScopeName;}
function setRunning(value){running=value;conversationTasks?.setBusy(value||taskRunning);document.querySelectorAll('.create-task-button').forEach(b=>b.disabled=value||taskRunning);knowledge?.setBusy(value||taskRunning);operations?.setBusy(value);document.querySelectorAll('.save-memory-button').forEach(b=>b.disabled=value);$('#clear-workflow')&&( $('#clear-workflow').disabled=value );$('#chat-send').hidden=value;$('#chat-send').disabled=!ready||taskRunning;$('#chat-stop').hidden=!value;$('#new-chat').disabled=value||taskRunning;$('#chat-input').disabled=value||taskRunning;document.querySelectorAll('.chat-starters button').forEach(b=>b.disabled=value);if(!value){for(const a of agents)if(activeAgents.has(a.id))updateAgent(a.id,'Disponibile',a.task);bindText($('#office-message'),'La conversazione continua. Le idee anche.');}renderRepositoryAnalysisDraft();syncExperience();}
async function loadStudio(){try{const res=await fetch('/api/studio');if(!res.ok)throw Error(t('Non riesco a collegarmi allo studio locale.'));const data=await res.json();lastProvider=data.provider;currentConversationId=data.id||data.conversationId||null;currentProjectId=data.projectId||null;currentScope=data.scopeId||'business';selectedWorkflow=data.workflowId||null;const workspace=await knowledge?.load({scopeId:currentScope});workspaceScopes=workspace?.scopes||[];workspaceWorkflows=workspace?.workflows||[];search?.setContext({scopeId:currentScope,scopes:workspaceScopes});const scope=workspace?.scopes.find(s=>s.id===currentScope);currentScopeName=scope?.name||currentScope;experience?.setScope(scope||{id:currentScope,name:currentScopeName});operations?.setScope(currentScope);renderWorkflow();ready=!!data.provider.ready;chatProblemKey=ready?null:'provider:unavailable';$('#provider-badge').textContent=ready?t('{provider} collegato',{provider:data.provider.provider}):t('Servizio da collegare');$('#provider-note').textContent=ready?`${data.provider.provider} · ${data.provider.auth}`:(data.provider.reason||t('Servizio non disponibile'));$('#chat-send').disabled=!ready;$('#chat-messages').replaceChildren();seenMessages.clear();messageRecords.clear();data.messages.forEach(addMessage);updateContext(data.projectId);setRunning(!!data.busy);clearTimeout(studioPoll);if(data.busy)studioPoll=setTimeout(loadStudio,1200);if(!ready){$('#chat-error').hidden=false;$('#chat-error').textContent=data.provider.reason;}}catch(error){$('#provider-badge').textContent=t('Connessione non disponibile');$('#provider-note').textContent=t('Avvia l’app con npm start');$('#chat-error').hidden=false;$('#chat-error').textContent=error.message;chatProblemKey='studio:connection';syncExperience();}}
function handleEvent(event){if(event.type==='memory'){knowledge?.load({scopeId:currentScope});if(event.saved?.length)toast(t(event.saved.length===1?'{count} ricordo salvato. Puoi rivederli e annullarli in Memoria.':'{count} ricordi salvati. Puoi rivederli e annullarli in Memoria.',{count:event.saved.length}));}else if(event.type==='message')addMessage(event.message);else if(event.type==='status')updateAgent(event.agentId,event.status,event.task);else if(event.type==='context')updateContext(event.projectId);else if(event.type==='error'){$('#chat-error').hidden=false;$('#chat-error').textContent=event.message;chatProblemKey=`chat:${chatStartedAt}:error`;syncExperience();}else if(event.type==='notice')toast(event.message);else if(event.type==='done')updateContext(event.projectId);}
async function sendMessage(event,options={}){
 event?.preventDefault();if(running||taskRunning||chatStarting)return false;if(!ready){toast(t('Servizio da collegare'));return false;}
 renderRepositoryAnalysisDraft();
 const text=String(options.message??$('#chat-input').value).trim();if(!text){$('#chat-input').focus();return false;}
 const repositoryAnalysisId=options.repositoryAnalysisId||pendingRepositoryAnalysis?.id||null;
 if(repositoryAnalysisId&&(!repositoryAnalysisDraftMatches(pendingRepositoryAnalysis,{scopeId:currentScope,conversationId:currentConversationId,message:text})||pendingRepositoryAnalysis.id!==repositoryAnalysisId)){toast(t('Hai modificato l’obiettivo. Prepara di nuovo l’analisi dei repository.'));return false;}
 const scopeId=currentScope,conversationId=currentConversationId,workflowId=repositoryAnalysisId?null:selectedWorkflow;
 const workflow=repositoryAnalysisId?null:knowledge?.getWorkflow(workflowId)||workspaceWorkflows.find(item=>item.id===workflowId),inputs=!repositoryAnalysisId&&selectedWorkflowInputs?.workflowId===workflowId?selectedWorkflowInputs:{};
 chatStarting=true;let started=false;
 try{
  const receipt=await executionPreview.open({kind:'chat',message:text,scopeId,projectId:currentProjectId,workflowId,workflow,inputValues:inputs.inputValues||{},expectedWorkflowVersion:inputs.expectedWorkflowVersion,...(repositoryAnalysisId?{repositoryAnalysisId,agentIds:['forge','growth','nova']}:{})});
  if(!receipt)return false;
  if(scopeId!==currentScope||conversationId!==currentConversationId||running||taskRunning||(!repositoryAnalysisId&&workflowId!==selectedWorkflow))throw Error(t('Il contesto è cambiato durante l’anteprima. Rivedi il lavoro prima di avviare.'));
  $('#chat-error').hidden=true;chatProblemKey=null;chatParticipants.clear();chatStartedAt=Date.now();setRunning(true);started=true;controller=new AbortController();
  const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify({message:text,scopeId,workflowId,...(repositoryAnalysisId?{repositoryAnalysisId}:{}),...receipt}),signal:controller.signal});
  if(!res.ok){const failure=await res.json();throw Error(failure.error||t('Invio non riuscito.'));}
  $('#chat-input').value='';if(repositoryAnalysisId){pendingRepositoryAnalysis=null;renderRepositoryAnalysisDraft();}
  const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='';
  while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);for(const line of frame.split('\n'))if(line.startsWith('data: '))handleEvent(JSON.parse(line.slice(6)));}}
  return true;
 }catch(error){if(error.name==='AbortError')toast(t('Richiesta interrotta. I messaggi ricevuti restano salvati.'));else{$('#chat-error').hidden=false;$('#chat-error').textContent=error.message;chatProblemKey=`chat:${chatStartedAt}:error`;syncExperience();}return false;}
 finally{chatStarting=false;if(started){setRunning(false);controller=null;}renderRepositoryAnalysisDraft();}
}
function renderRepositoryAnalysisDraft(){
 if(pendingRepositoryAnalysis&&!repositoryAnalysisDraftMatches(pendingRepositoryAnalysis,{scopeId:currentScope,conversationId:currentConversationId}))pendingRepositoryAnalysis=null;
 const host=$('#repository-analysis-draft');host.hidden=!pendingRepositoryAnalysis;host.innerHTML=pendingRepositoryAnalysis?ui`<span>Analisi repository pronta da rivedere. Le fonti acquisite restano salvate anche se annulli.</span><button type="button" data-analysis-discard${running||chatStarting?' disabled':''}>Annulla analisi preparata</button>`:'';
 $('#repository-analysis-open').disabled=running||taskRunning||chatStarting||analysisOpening;
}
async function openRepositoryAnalysis(){
 if(analysisOpening||running||taskRunning||chatStarting){toast(t('Attendi la fine del lavoro prima di avviare l’analisi.'));return;}
 analysisOpening=true;renderRepositoryAnalysisDraft();
 try{
  const scopeId=currentScope,conversationId=currentConversationId;
  const prepared=await repositoryAnalysis.open({scopeId,scopeName:currentScopeName,goal:$('#chat-input').value});
  if(!prepared)return;
  if(currentScope!==scopeId||currentConversationId!==conversationId||prepared.scopeId!==scopeId){toast(t('L’ambito è cambiato. Riapri l’analisi nell’ambito desiderato.'));return;}
  pendingRepositoryAnalysis={id:prepared.id,scopeId,goal:prepared.goal,conversationId};renderRepositoryAnalysisDraft();focusChat(prepared.goal);
  await sendMessage(null,{repositoryAnalysisId:prepared.id,message:prepared.goal});
 }finally{analysisOpening=false;renderRepositoryAnalysisDraft();}
}
$('#repository-analysis-open').addEventListener('click',()=>void openRepositoryAnalysis());
$('#repository-analysis-draft').addEventListener('click',event=>{if(event.target.closest('[data-analysis-discard]')&&!running&&!chatStarting){pendingRepositoryAnalysis=null;renderRepositoryAnalysisDraft();}});
window.addEventListener('studio-repository-analysis',()=>void openRepositoryAnalysis());
window.addEventListener('studio-session-expired',()=>{pendingRepositoryAnalysis=null;repositoryAnalysis.cancel();renderRepositoryAnalysisDraft();});
$('#chat-form').addEventListener('submit',sendMessage);$('#chat-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendMessage();}});$('#chat-stop').addEventListener('click',()=>controller?.abort());
$('#new-chat').addEventListener('click',async()=>{if(running||taskRunning)return;try{const res=await fetch('/api/conversation/new',{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:'{}'});if(!res.ok){const data=await res.json();throw Error(data.error);}await loadStudio();toast(t('Nuova conversazione. La precedente è conservata sul Mac.'));}catch(error){toast(error.message);}});
$('#focus-toggle').addEventListener('click',()=>{const enabled=document.body.classList.toggle('focus-mode');$('#focus-toggle').setAttribute('aria-pressed',String(enabled));officeWorld?.setQuiet(enabled);toast(enabled?t('Quiet mode: movimenti in pausa.'):t('Il team torna in movimento.'));});
const landscapes={anthill:{title:'Lo studio nel formicaio',label:'FORMICAIO · STUDIO 01',description:'Ufficio 3D al centro di un grande formicaio, con sentieri e formiche laboriose attorno ai lavoratori.'},forest:{title:'Lo studio nel bosco',label:'BOSCO · STUDIO 02',description:'Diorama di uno studio tra querce, ruscello, scoiattoli e uccelli.'},beach:{title:'Lo studio sulla spiaggia',label:'SPIAGGIA · STUDIO 03',description:'Diorama di uno studio tra palme, laguna, granchi e tartarughe.'},mountain:{title:'Lo studio in montagna',label:'MONTAGNA · STUDIO 04',description:'Diorama di uno studio tra pini, lago alpino, marmotte e stambecchi.'}};
function setLandscape(name){const scene=landscapes[name];document.body.dataset.landscape=name;$('#office-illustration').setAttribute('aria-label',t(scene.description));$('#office-title').textContent=t(scene.title);$('#landscape-label').textContent=t(scene.label);document.querySelectorAll('.landscape-button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.landscape===name)));officeWorld?.setLandscape(name);exploration?.setTheme(name==='mountain'?'mountains':name);}
document.querySelectorAll('.landscape-button').forEach(b=>b.addEventListener('click',()=>setLandscape(b.dataset.landscape)));$('#reset-camera').addEventListener('click',()=>officeWorld?.resetCamera());
$('#zoom-in').addEventListener('click',()=>officeWorld?.zoomBy(1.2));$('#zoom-out').addEventListener('click',()=>officeWorld?.zoomBy(1/1.2));$('#world-overview').addEventListener('click',()=>officeWorld?.showOverview());
try{officeWorld=createOfficeWorld($('#office-illustration'),{onSelect:showAgent,onInteract:station=>experience?.openPanel(station.kind),onStationPositions:positions=>experience?.updateStations(positions),onCameraChange:state=>{const {overview,zoom}=state;$('#world-overview').setAttribute('aria-pressed',String(overview));$('#office-world').classList.toggle('distant-view',zoom<.68);exploration?.updateCamera(state);},onPositions:positions=>{for(const p of positions){const badge=$(`.office-agent[data-agent="${p.id}"]`);if(badge){badge.hidden=!p.visible;badge.style.left=p.x+'px';badge.style.top=p.y+'px';}}}});const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');if(reduced.matches){document.body.classList.add('focus-mode');$('#focus-toggle').setAttribute('aria-pressed','true');officeWorld.setQuiet(true);}reduced.addEventListener('change',event=>{document.body.classList.toggle('focus-mode',event.matches);$('#focus-toggle').setAttribute('aria-pressed',String(event.matches));officeWorld?.setQuiet(event.matches);});setLandscape('anthill');}catch(error){$('#office-illustration').innerHTML=ui`<div class="graphics-error"><strong>Il mondo 3D non è riuscito ad aprirsi.</strong><p>Riapri questa pagina in un browser con WebGL attivo. La chat resta utilizzabile.</p></div>`;document.querySelectorAll('.office-agent').forEach(b=>b.hidden=true);document.querySelectorAll('.camera-controls button').forEach(b=>b.disabled=true);console.error('Avvio del mondo 3D non riuscito:',error);}
function decorateMessage(element,message){
 if(message.welcome)return;
 const tools=document.createElement('div');tools.className='message-memory-tools';
 const save=document.createElement('button');save.type='button';save.className='save-memory-button';save.textContent=t(message.role==='user'?'Ricorda questo':'Crea una nota');save.disabled=running;save.addEventListener('click',()=>knowledge?.captureMessage(message));tools.append(save);
 const origin={scopeId:currentScope,conversationId:currentConversationId,messageId:message.id};
 const assign=document.createElement('button');assign.type='button';assign.className='create-task-button';assign.textContent=t('Crea incarico ↗');assign.disabled=running||taskRunning;assign.addEventListener('click',()=>{if(origin.conversationId)void conversationTasks?.open(origin);});tools.append(assign);
 const evidence=message.context;
 if(evidence){const details=document.createElement('details');details.className='message-context-evidence';const summary=document.createElement('summary');summary.textContent=t('Contesto fornito · {memories} memorie · {sources} fonti',{memories:evidence.memories.length,sources:(evidence.sources||[]).length});details.append(summary);const description=document.createElement('p');description.textContent=t('Ambito: {scope}. Informazioni fornite all’agente, anche attraverso la cronologia; non sono citazioni verificate.',{scope:evidence.scopeName});details.append(description);const list=document.createElement('ul');for(const memory of evidence.memories){const item=document.createElement('li');item.textContent=`${memory.title} · v${memory.version}${memory.source?' · '+memory.source:''}`;list.append(item);}for(const workflow of evidence.workflows||(evidence.workflow?[evidence.workflow]:[])){const item=document.createElement('li');item.textContent=t('Procedura: {title} · v{version}',{title:workflow.title,version:workflow.version});list.append(item);}for(const source of evidence.sources||[]){const item=document.createElement('li');item.textContent=t('Fonte: {title} · v{version} ',{title:source.title,version:source.version});if(source.url){try{const url=new URL(source.url);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password){const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent=t('Apri originale');item.append(link);}}catch{}}list.append(item);}details.append(list);if(evidence.sources?.length){const consult=document.createElement('button');consult.type='button';consult.className='save-memory-button';consult.textContent=t('Consulta le fonti');consult.addEventListener('click',()=>{experience?.openPanel('projects');operations?.openSection('sources');});details.append(consult);}tools.append(details);}
 element.append(tools);
}
function renderWorkflow(){
 let chip=$('#selected-workflow');
 if(!chip){chip=document.createElement('div');chip.id='selected-workflow';chip.className='selected-workflow';$('#chat-form').before(chip);}
 chip.replaceChildren();chip.hidden=!selectedWorkflow;if(!selectedWorkflow)return;
 const label=document.createElement('span');label.textContent=t('Procedura collegata alla conversazione');const clear=document.createElement('button');clear.id='clear-workflow';clear.type='button';clear.textContent=t('Rimuovi');clear.disabled=running;clear.addEventListener('click',()=>{selectedWorkflow=null;renderWorkflow();toast(t('Il prossimo messaggio non applicherà la procedura.'));});chip.append(label,clear);
}
knowledge=createKnowledgePanel({onCreateTask:workflow=>{experience?.openPanel('projects');void operations.newTask(workflow);},
 toast,getConversationId:()=>currentConversationId,
 onScopeChange:async scopeId=>{if(running)throw Error(t('Attendi la risposta del team.'));const res=await fetch('/api/conversation/scope',{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify({scopeId})});const result=await res.json();if(!res.ok)throw Error(result.error||t('Cambio ambito non riuscito.'));$('#chat-input').value='';$('#chat-error').hidden=true;await loadStudio();},
 onUseWorkflow:({scopeId,workflowId,prompt,inputValues,expectedWorkflowVersion})=>{if(running||scopeId!==currentScope)throw Error(t('Attendi la risposta del team e verifica l’ambito.'));selectedWorkflow=workflowId;selectedWorkflowInputs={workflowId,inputValues,expectedWorkflowVersion};renderWorkflow();focusChat(prompt);}
});
operations=createOperationsPanel({toast,onOpenConversation:origin=>search?.openOriginal(origin),onReviewMemory:()=>{experience?.openPanel('memory');void knowledge.openReview();},onPreview:input=>executionPreview.open(input),onCreateWorkflow:task=>{experience?.openPanel('workflows');void knowledge.fromApproved(task);},onScopeChange:async scopeId=>{const res=await fetch('/api/conversation/scope',{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify({scopeId})});const result=await res.json();if(!res.ok)throw Error(result.error);await loadStudio();},onRefreshMemory:()=>knowledge.load({scopeId:currentScope}),onProviderChange:()=>loadStudio(),onActivity:snapshot=>{activitySnapshot=snapshot;syncExperience();taskRunning=activityTasks().some(t=>t.status==='running');conversationTasks?.setBusy(running||taskRunning);document.querySelectorAll('.create-task-button').forEach(b=>b.disabled=running||taskRunning);$('#chat-send').disabled=!ready||taskRunning;$('#chat-input').disabled=running||taskRunning;$('#new-chat').disabled=running||taskRunning;if(running)return;const working=new Map(activityTasks().filter(t=>t.status==='running').flatMap(t=>t.steps.filter(s=>s.status==='running').map(s=>[s.agentId,s.title])));for(const a of agents)updateAgent(a.id,working.has(a.id)?'Al lavoro':'Disponibile',working.get(a.id)||a.task);knowledge?.setBusy(taskRunning);}});
conversationTasks=createConversationTasks({toast,onCreated:async result=>{experience?.openPanel('projects');await operations.load();operations.openTask(result.taskId);},onProjectsChanged:()=>operations.load()});
experience=createStudioExperience({world:officeWorld,knowledge,operations});
if(officeWorld)exploration=createExplorationControls({world:officeWorld,host:$('#office-world')});
search=createSearchPanel({onOpenOriginal:async result=>{const target=result.target;if(target.archived)return false;if(target.scopeId&&target.scopeId!==currentScope){const res=await fetch('/api/conversation/scope',{method:'POST',headers:{'Content-Type':'application/json','X-Fuori-Studio':'local'},body:JSON.stringify({scopeId:target.scopeId})});if(!res.ok){toast(t('Attendi la fine del lavoro prima di cambiare ambito.'));return false;}await loadStudio();}search.close();if(['memory','decision','workflow'].includes(target.kind)){experience.openPanel(target.kind==='workflow'?'workflows':'memory');return knowledge.openEntry(target.kind==='workflow'?'workflows':'memories',target.id);}if(target.kind==='conversation'){experience.openPanel('chat');const message=document.querySelector(`[data-message-id="${CSS.escape(target.messageId||target.id)}"]`);(message||document.querySelector('#chat-messages')).scrollIntoView({block:'center',behavior:'smooth'});return true;}experience.openPanel('projects');await operations.load();if(target.kind==='document')return operations.openSource(target.id);if(target.kind==='repository'){operations.openRepositoryRun(target.id);return true;}operations.openTask(target.taskId||target.id);return true;}});
quickActions=createQuickActions({onAction:action=>{if(action==='search')search.open({scopeId:currentScope,scopes:workspaceScopes});else if(action==='memory-review'){experience.openPanel('memory');void knowledge.openReview();}else if(action==='memory'){experience.openPanel('memory');knowledge.newMemory();}else if(action==='workflows')experience.openPanel('workflows');else{experience.openPanel('projects');if(action==='task')void operations.newTask();else operations.openSection(action);}}});
window.addEventListener('studio-open-operations',event=>{const section=event.detail?.section;if(!['routines','budgets'].includes(section))return;for(const id of ['operations-dialog','repositories-dialog','plans-dialog'])document.getElementById(id)?.close();experience?.openPanel('projects');operations?.openSection(section);});
createAccessPanel({toast,getScopeId:()=>currentScope,onAISettings:()=>{experience?.openPanel('projects');operations?.openSection('providers');},onWorkspaceChanged:()=>{knowledge?.load({scopeId:currentScope});operations?.load();}});
window.addEventListener('studio-session-expired',()=>{controller?.abort();clearTimeout(studioPoll);ready=false;});
syncExperience();
operations.load();
window.addEventListener('studio-workspace-changed',()=>operations.load());
const memoryNav=document.createElement('a');memoryNav.href='#knowledge-title';bindText(memoryNav,'Memoria');$('.top-nav').append(memoryNav);
loadStudio();

function renderLeaderCaption(){bindText($('.chat-subtitle'),'{name} guida, il team collabora.',{name:agents.find(a=>a.id==='nova').name});}
renderLeaderCaption();
onLanguageChange(()=>{
 renderRepositoryAnalysisDraft();
 renderLeaderCaption();
 renderAgents();
 for(const a of agents){const badge=$(`.office-agent[data-agent="${a.id}"]`);if(badge){badge.setAttribute('aria-label',t('Conosci {name}, {role}',{name:a.name,role:a.role}));badge.innerHTML=ui`<span class="agent-nameplate"><span class="person-dot"></span>${escapeHTML(a.name)}${a.id==='nova'?ui`<span class="leader-badge">Leader</span>`:''}<span class="person-plus">＋</span></span>`;}}
 setLandscape(document.body.dataset.landscape||'anthill');
 renderWorkflow();
 if(lastProvider){$('#provider-badge').textContent=lastProvider.ready?t('{provider} collegato',{provider:lastProvider.provider}):t('Servizio da collegare');if(!lastProvider.ready&&!lastProvider.reason)$('#provider-note').textContent=t('Servizio non disponibile');}
 if($('#detail-dialog').open&&shownAgent)showAgent(shownAgent);
 for(const element of document.querySelectorAll('.chat-message')){
   const message=messageRecords.get(element.dataset.messageId);if(!message)continue;
   element.querySelector('.chat-person').textContent=message.role==='user'?t('Tu'):(agents.find(a=>a.id===message.agentId)?.name||'Studio');
   element.querySelector('time').textContent=new Date(message.createdAt).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit'});
   element.querySelector('.message-memory-tools')?.remove();decorateMessage(element,message);
 }
 $('#toast').hidden=true;
});
