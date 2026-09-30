import {defaultAgentProfiles, findAgentProfile} from '../dist/agent-profiles.js';

interface Storage { read(key:string,fallback?:unknown):Promise<unknown>; write(key:string,value:unknown):Promise<unknown> }
interface State {schemaVersion:1;version:number;profiles:Record<string,string>}
const key='agent-capabilities',ids=Object.keys(defaultAgentProfiles);
const fail=(message:string,code='CAPABILITIES_INVALID',statusCode=400)=>Object.assign(Error(message),{code,statusCode});
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function validate(value:unknown):State {
  if(!record(value)||value.schemaVersion!==1||!Number.isSafeInteger(value.version)||Number(value.version)<1||!record(value.profiles)||Object.keys(value.profiles).length!==ids.length||ids.some(id=>!Object.hasOwn(value.profiles as object,id)||typeof (value.profiles as Record<string,unknown>)[id]!=='string'||!findAgentProfile((value.profiles as Record<string,unknown>)[id])))throw fail('Impossibile leggere le specializzazioni salvate.','CAPABILITIES_CORRUPT',503);
  return {schemaVersion:1,version:Number(value.version),profiles:{...value.profiles} as Record<string,string>};
}
/** Profile preferences are versioned independently from display names and permissions. */
export function createAgentCapabilitiesStore({storage}:{storage:Storage}) {
  let queue:Promise<unknown>=Promise.resolve();
  const serial=<T>(run:()=>Promise<T>):Promise<T>=>{const operation=queue.then(run,run);queue=operation.catch(()=>{});return operation;};
  const load=async()=>validate(await storage.read(key,{schemaVersion:1,version:1,profiles:{...defaultAgentProfiles}}));
  const view=(state:State)=>({version:state.version,profiles:{...state.profiles}});
  return {
    snapshot:()=>serial(async()=>view(await load())),
    assign:(input:unknown)=>serial(async()=>{
      if(!record(input)||Object.keys(input).some(field=>!['id','profileId','expectedVersion'].includes(field))||typeof input.id!=='string'||!ids.includes(input.id)||typeof input.profileId!=='string'||!findAgentProfile(input.profileId)||!Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<1)throw fail('Specializzazione o versione non valida.');
      const state=await load();
      if(input.expectedVersion!==state.version)throw fail('Le specializzazioni sono cambiate in un’altra scheda. Chiudi e riapri questo collega prima di salvare.','CAPABILITIES_CONFLICT',409);
      if(state.profiles[input.id]===input.profileId)return view(state);
      if(state.version===Number.MAX_SAFE_INTEGER)throw fail('Specializzazione o versione non valida.','CAPABILITIES_VERSION_LIMIT',409);
      const next={...state,version:state.version+1,profiles:{...state.profiles,[input.id]:input.profileId}};
      await storage.write(key,next);
      return view(next);
    }),
  };
}
