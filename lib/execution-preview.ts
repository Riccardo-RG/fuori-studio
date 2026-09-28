import {createHash,randomUUID} from 'node:crypto';
import {contextSelection} from './context.mjs';

type Data = Record<string,any>;
type Plan = Data & {kind:string;id:string;scopeId:string;steps:Data[];selection:Data};
type Options = {prepare:Record<string,(input:Data)=>Promise<Plan>>;budget:(plan:Plan)=>Promise<Data>;destinations?:(plan:Plan)=>Promise<Plan>;now?:()=>number};
const fail=(message:string,statusCode=409)=>Object.assign(Error(message),{statusCode});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=<T>(value:T):T=>structuredClone(value);

/** An expiring, single-use receipt binds owner review to the exact authorized data. */
export function createExecutionPreview({prepare,budget,destinations=async plan=>plan,now=Date.now}:Options){
  const receipts=new Map<string,{input:Data;hash:string;expires:number}>();
  async function build(input:Data){
    if(!input||typeof input!=='object'||Array.isArray(input)||!Object.hasOwn(prepare,input.kind))throw fail('Tipo di anteprima non valido.',400);
    const plan=await destinations(await prepare[input.kind](copy(input)));
    const allowance=await budget(plan);
    return {plan,allowance};
  }
  function display(plan:Plan,allowance:Data){
    const locked=(step:Data)=>({
      memories:(step.inherited||[]).filter((item:Data)=>item.persisted||item.completed||item.taskId).flatMap((item:Data)=>item.context?.memories||[]),
      sources:(step.inherited||[]).filter((item:Data)=>item.persisted||item.completed||item.taskId).flatMap((item:Data)=>item.context?.sources||[]),
    });
    return {
      kind:plan.kind,id:plan.id,version:plan.version,scopeId:plan.scopeId,title:plan.title,projectId:plan.projectId,
      project:plan.project?{id:plan.project.id,title:plan.project.title}:null,
      projects:(plan.projects||[]).map((item:Data)=>({id:item.id,title:item.title})),
      selection:plan.selection,agentIds:plan.agentIds||[...new Set(plan.steps.map(step=>step.agentId))],
      requiredCalls:plan.kind==='chat'?Math.min(4,plan.steps.length):plan.steps.length,
      budget:allowance,reviewUnavailable:plan.reviewUnavailable||null,
      steps:plan.steps.map(step=>{
        const available=step.availableContext||step.context,required=locked(step);
        return {agentId:step.agentId,title:step.title,provider:step.connection,destination:step.destination,
          memories:(available?.memories||[]).map((item:Data)=>({...item,included:step.context.memories.some((chosen:Data)=>chosen.id===item.id),locked:required.memories.some((ref:Data)=>ref.id===item.id)})),
          sources:(available?.sources||[]).map((item:Data)=>({...item,included:(step.context.sources||[]).some((chosen:Data)=>chosen.id===item.id),locked:required.sources.some((ref:Data)=>ref.id===item.id),passages:(available.passages||[]).filter((passage:Data)=>passage.sourceId===item.id)})),
          workflow:step.context?.workflow||null,history:(step.history||[]).map((message:Data)=>({id:message.id,role:message.role,agentId:message.agentId,text:message.text.slice(0,9000)})),
          requiredEvidence:required,dependencies:(step.dependencies||[]).map((item:Data)=>({taskId:item.taskId,title:item.title,version:item.version,content:item.content})),
        };
      }),
    };
  }
  return {
    async preview(input:Data){
      if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Tipo di anteprima non valido.',400);
      const safe=copy(input);if(safe.selection!==undefined)safe.selection=contextSelection(safe.selection);
      if(safe.kind==='chat')safe.workflowId??=null;
      const value=await build(safe),time=now();
      for(const [id,receipt]of receipts)if(receipt.expires<=time)receipts.delete(id);
      while(receipts.size>=100)receipts.delete(receipts.keys().next().value!);
      const previewId=randomUUID(),expires=time+10*60*1000;
      receipts.set(previewId,{input:safe,hash:digest(value),expires});
      return {...display(value.plan,value.allowance),previewId,expiresAt:new Date(expires).toISOString()};
    },
    async consume(previewId:unknown,expected:Data){
      const receipt=typeof previewId==='string'?receipts.get(previewId):null;
      if(!receipt||receipt.expires<=now())throw fail('L’anteprima è scaduta o manca. Rivedi il contesto prima di avviare.');
      for(const [key,value]of Object.entries(expected))if(value!==undefined&&receipt.input[key]!==value)throw fail('L’anteprima riguarda un altro lavoro. Rivedi il contesto.');
      // Claim before asynchronous revalidation so even concurrent consumers
      // cannot authorize the same reviewed execution twice.
      receipts.delete(previewId as string);
      const current=await build(receipt.input);
      if(digest(current)!==receipt.hash)throw fail('Contesto, servizi o budget sono cambiati. Aggiorna l’anteprima prima di avviare.');
      if(!current.allowance.allowed)throw fail('Il budget disponibile non copre le chiamate previste. Rivedi i limiti prima di avviare.');
      return current.plan;
    },
  };
}
