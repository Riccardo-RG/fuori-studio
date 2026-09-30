import {createHash,randomUUID} from 'node:crypto';
import {accessible,assertSourceEvidence} from './context.mjs';

type Data=Record<string,any>;
type Identity={scopeId:string;conversationId:string;messageId:string};
type Options={
  conversations:{original(input:{scopeId:string;conversationId:string}):Promise<Data>};
  workspace:{getSnapshot():Promise<Data>};
  operations:{getSnapshot():Promise<Data>;mutate(action:string,payload:Data):Promise<Data>};
  checkSources?:(evidence:Data,scopeId:string)=>Promise<unknown>;
  now?:()=>number;
};
const agents=['nova','radar','forge','muse','growth'];
const fail=(message:string,statusCode=400)=>Object.assign(Error(message),{statusCode});
function object(value:unknown,keys?:string[]):asserts value is Data{
  if(!value||typeof value!=='object'||Array.isArray(value)||![null,Object.prototype].includes(Object.getPrototypeOf(value))||Object.keys(value).some(key=>['__proto__','constructor','prototype'].includes(key)||(keys&&!keys.includes(key))))throw fail('Dati dell’incarico non validi.');
}
function text(value:unknown,max:number){if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw fail(`Usa un testo tra 1 e ${max.toLocaleString('it-IT')} caratteri.`);return value.trim();}
function id(value:unknown){const result=text(value,100);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result))throw fail('Identificativo dell’incarico non valido.');return result;}
function canonical(value:any):any{return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function normalizedEvidence(value:unknown,scopeId:string):Data{
  if(value===undefined||value===null)return {scopeId,memories:[],workflows:[],sources:[]};
  object(value);
  if(Buffer.byteLength(JSON.stringify(value))>96000)throw fail('Il contesto del messaggio è troppo grande per un incarico.');
  if(value.scopeId!==undefined&&value.scopeId!==scopeId)throw fail('Il contesto del messaggio appartiene a un altro ambito.',409);
  const evidence=structuredClone(value);
  for(const key of ['memories','workflows','sources']){
    if(evidence[key]===undefined)evidence[key]=[];
    if(!Array.isArray(evidence[key])||evidence[key].length>1000)throw fail('Il contesto del messaggio non è valido.',409);
  }
  if(evidence.workflow){object(evidence.workflow);if(!evidence.workflows.some((ref:Data)=>ref.id===evidence.workflow.id&&ref.version===evidence.workflow.version))evidence.workflows.push(evidence.workflow);}
  for(const ref of [...evidence.memories,...evidence.workflows,...evidence.sources]){object(ref);id(ref.id);if(!Number.isSafeInteger(ref.version)||ref.version<1)throw fail('Una versione del contesto del messaggio non è valida.',409);}
  evidence.scopeId=scopeId;
  return evidence;
}

/** Owner-edited queued work from saved conversation data; no inference occurs here. */
export function createConversationTasks({conversations,workspace,operations,checkSources=assertSourceEvidence,now=Date.now}:Options){
  const drafts=new Map<string,{source:Identity;sourceDigest:string;expires:number}>();
  let queue:Promise<unknown>=Promise.resolve();
  const serial=<T>(work:()=>Promise<T>):Promise<T>=>{const next=queue.then(work);queue=next.catch(()=>{});return next;};
  const prune=()=>{for(const [key,draft]of drafts)if(draft.expires<=now())drafts.delete(key);};
  async function source(identity:Identity){
    const snapshot=await workspace.getSnapshot();
    if(!snapshot.scopes.some((scope:Data)=>scope.id===identity.scopeId&&!['shared','archive'].includes(scope.kind)))throw fail('Scegli un ambito operativo disponibile.',409);
    const conversation=await conversations.original(identity);
    const message=conversation.messages.find((item:Data)=>item.id===identity.messageId);
    if(conversation.id!==identity.conversationId||conversation.scopeId!==identity.scopeId||!message||message.welcome||!['user','assistant'].includes(message.role))throw fail('Il messaggio salvato non è più disponibile in questo ambito.',409);
    const brief=text(message.text,16000),evidence=normalizedEvidence(message.context,identity.scopeId);
    await checkSources(evidence,identity.scopeId);
    const records:Data[]=[];
    for(const [key,status]of [['memories','confirmed'],['workflows','ready']])for(const ref of evidence[key]){
      const record=snapshot[key].find((item:Data)=>item.id===ref.id);
      if(!record||record.version!==ref.version||record.status!==status)throw fail('Una memoria o procedura del messaggio è cambiata o non è più disponibile.',409);
      records.push(record);
    }
    const agentIds=agents.filter(agentId=>records.every(record=>accessible(record,identity.scopeId,agentId)));
    if(!agentIds.length)throw fail('Nessun responsabile può utilizzare tutto il contesto del messaggio.',409);
    const agentId=agents.includes(message.agentId)?message.agentId:null;
    const createdAt=typeof message.createdAt==='string'&&Number.isFinite(Date.parse(message.createdAt))?new Date(message.createdAt).toISOString():null;
    return {brief,evidence,agentIds,source:{...identity,agentId,createdAt},sourceDigest:digest({...identity,role:message.role,agentId:message.agentId??null,createdAt:message.createdAt??null,text:message.text,context:message.context??null})};
  }
  return {
    preview:(input:unknown)=>serial(async()=>{
      object(input,['scopeId','conversationId','messageId']);
      const identity={scopeId:id(input.scopeId),conversationId:id(input.conversationId),messageId:id(input.messageId)};
      prune();
      const checked=await source(identity),state=await operations.getSnapshot();
      const receiptId=randomUUID(),expires=now()+15*60000;
      if(drafts.size>=20)drafts.delete(drafts.keys().next().value!);
      drafts.set(receiptId,{source:identity,sourceDigest:checked.sourceDigest,expires});
      return {id:receiptId,expiresAt:new Date(expires).toISOString(),sourceDigest:checked.sourceDigest,title:checked.brief.split('\n')[0].slice(0,160),brief:checked.brief,source:checked.source,projects:state.projects.filter((project:Data)=>project.scopeId===identity.scopeId&&project.kind==='owned'),agentIds:checked.agentIds,agentId:checked.agentIds.includes(checked.source.agentId)?checked.source.agentId:checked.agentIds.includes('nova')?'nova':checked.agentIds[0]};
    }),
    create:(input:unknown)=>serial(async()=>{
      object(input,['draftId','projectId','title','brief','agentId']);
      const receiptId=id(input.draftId),fields={projectId:id(input.projectId),title:text(input.title,160),brief:text(input.brief,16000),agentId:text(input.agentId,100)};
      if(!agents.includes(fields.agentId))throw fail('Responsabile non valido.');
      const requestDigest=digest(fields),state=await operations.getSnapshot();
      const existing=state.tasks.find((task:Data)=>task.origin?.kind==='conversation'&&task.origin.receiptId===receiptId);
      if(existing){if(existing.origin.requestDigest!==requestDigest)throw fail('Questa bozza è già stata salvata con dati diversi. Apri l’incarico esistente.',409);return {taskId:existing.id,operations:state};}
      prune();const draft=drafts.get(receiptId);
      if(!draft)throw fail('La bozza è scaduta. Riapri il messaggio per prepararla di nuovo.',409);
      const checked=await source(draft.source);
      if(checked.sourceDigest!==draft.sourceDigest)throw fail('Il messaggio sorgente è cambiato. Riapri la bozza prima di salvarla.',409);
      const project=state.projects.find((project:Data)=>project.id===fields.projectId);
      if(!project||project.kind!=='owned'||project.scopeId!==draft.source.scopeId)throw fail('Scegli un tuo progetto nello stesso ambito del messaggio.',409);
      if(!checked.agentIds.includes(fields.agentId))throw fail('Il responsabile scelto non può utilizzare tutto il contesto del messaggio.',409);
      const origin={kind:'conversation',receiptId,...checked.source,sourceDigest:checked.sourceDigest,requestDigest};
      const saved=await operations.mutate('createConversationTask',{...fields,scopeId:draft.source.scopeId,inputContext:checked.evidence,origin});
      const task=saved.tasks.find((task:Data)=>task.origin?.receiptId===receiptId);
      if(!task)throw fail('Non è stato possibile ritrovare l’incarico salvato.',500);
      drafts.delete(receiptId);
      return {taskId:task.id,operations:saved};
    }),
  };
}
