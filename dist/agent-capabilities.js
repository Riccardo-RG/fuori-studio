import {t,ui} from './i18n.js';
import {agentCapability} from './data.js';
import {agentProfiles,defaultAgentProfiles,findAgentProfile} from './agent-profiles.js';
import {assignAgentProfile,agentCapabilitiesVersion} from './team.js';
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let draft=null;
export function capabilityFormHTML(id,{reset=false}={}) {
  if(reset||draft?.id!==id)draft={id,selected:agentCapability(id).profileId,version:agentCapabilitiesVersion(),dirty:false};
  const selected=draft.selected,profile=findAgentProfile(selected);
  return ui`<form id="agent-capability-form" class="agent-capability-editor"><label for="agent-specialty">Specializzazione</label><p id="agent-specialty-help">Scegli come contribuisce questo collega</p><select id="agent-specialty" aria-describedby="agent-specialty-help agent-specialty-note">${agentProfiles.map(profile=>ui`<option value="${profile.id}"${profile.id===selected?' selected':''}>${escape(t(profile.title))}</option>`).join('')}</select><div class="agent-specialty-preview" aria-live="polite"><p data-specialty-description>${escape(t(profile.description))}</p><strong>Consegna attesa</strong><p data-specialty-deliverable>${escape(t(profile.deliverable))}</p></div><p id="agent-specialty-note">La specializzazione orienta chat, piani e incarichi. Non aggiunge strumenti o permessi. Il leader continua a coordinare.</p><div class="agent-specialty-actions"><button type="submit" class="button primary">Salva specializzazione</button><button type="button" class="button secondary" data-specialty-reset>Ripristina ruolo iniziale</button></div><p role="alert" hidden></p></form>`;
}
export function bindCapabilityForm(id,{onSaving=()=>{},onSaved=()=>{},isBusy=()=>false}={}) {
  const form=document.getElementById('agent-capability-form'),select=form.querySelector('select'),error=form.querySelector('[role="alert"]'),expectedVersion=draft.version;
  let saving=false;
  const preview=()=>{draft={id,selected:select.value,version:expectedVersion,dirty:true};const profile=findAgentProfile(select.value);form.querySelector('[data-specialty-description]').textContent=t(profile.description);form.querySelector('[data-specialty-deliverable]').textContent=t(profile.deliverable);};
  select.addEventListener('change',preview);
  form.querySelector('[data-specialty-reset]').addEventListener('click',()=>{select.value=defaultAgentProfiles[id];preview();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(saving||isBusy())return;
    saving=true;onSaving(true);error.hidden=true;form.querySelectorAll('button,select').forEach(field=>field.disabled=true);
    try{await assignAgentProfile(id,select.value,expectedVersion);draft=null;onSaving(false);onSaved();}
    catch(failure){error.textContent=failure.message;error.hidden=false;}
    finally{saving=false;onSaving(false);form.querySelectorAll('button,select').forEach(field=>field.disabled=false);}
  });
}
