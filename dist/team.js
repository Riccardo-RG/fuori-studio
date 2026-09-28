import {agents, applyAgentNames} from './data.js';
import {t, refreshUI} from './i18n.js';
let version = 1;
let channel;
const request = async (body) => {
  const response = await fetch('/api/team', body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {cache:'no-store'});
  const value = await response.json();
  if (!response.ok) throw Object.assign(Error(t(value.error || 'Non è stato possibile salvare il nome.')), {status:response.status});
  if (!Number.isSafeInteger(value.version) || value.version < 1 || !value.names || agents.some(agent=>typeof value.names[agent.id]!=='string')) throw Error(t('Lo studio ha restituito nomi del team non validi.'));
  const changed = version !== value.version || agents.some(agent=>agent.name!==value.names[agent.id]);
  applyAgentNames(value.names);version=value.version;
  return changed;
};
export const teamVersion = () => version;
export async function loadTeam({render = false} = {}) { const changed=await request();if(render&&changed)refreshUI(); }
export async function renameAgent(id, name, expectedVersion) {
  await request({id,name,expectedVersion});
  refreshUI();
  channel?.postMessage({type:'changed'});
}
try { channel = new BroadcastChannel('fuori-studio-team'); channel.onmessage=event=>{if(event.data?.type==='changed')void loadTeam({render:true}).catch(()=>{});}; } catch { /* Cross-tab refresh is optional. */ }
window.addEventListener('focus',()=>void loadTeam({render:true}).catch(()=>{}));
