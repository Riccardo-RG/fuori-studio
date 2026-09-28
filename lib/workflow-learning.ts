import { starterWorkflowFields, hydrateWorkflowFromSnapshot } from './workflow-inputs.mjs';
import { accessible, assertSourceEvidence } from './context.mjs';

type Ref = {id:string;version:number};
type Evidence = {memories?:Ref[];workflows?:Ref[];sources?:unknown[]};
type Field = {key:string;label:string;required:boolean;defaultValue:string};
type Task = {id:string;version:number;scopeId:string;title:string;brief:string;status:string;workflowId?:string|null;workflowInputs?:{version:number;workflowVersion:number;fields:Field[];values:Record<string,string>;originalBrief?:string};steps:Array<{title:string;agentId:string;instruction:string}>;artifacts:Array<{version:number;decision:string;context?:Evidence}>};
type ScopedRecord = {id:string;scopeId:string;version:number;status:string;sharedWith:string[]};
type Workflow = ScopedRecord & {description:string;input:string;output:string;inputFields?:Field[];steps:Array<{title:string;agentId:string;output:string}>};
type Snapshot = {scopes:Array<{id:string;kind:string}>;memories:Array<ScopedRecord & {agentIds:string[]}>;workflows:Workflow[]};
type Options = {operations:{getSnapshot():Promise<{tasks:Task[]}>};workspace:{getSnapshot():Promise<Snapshot>;mutate(action:string,payload:Record<string,unknown>):Promise<Snapshot>};checkSources?:(evidence:Evidence|undefined,scopeId:string)=>Promise<unknown>};
const agents=['nova','radar','forge','muse','growth'];
const fail=(message:string,statusCode=400)=>Object.assign(Error(message),{statusCode});
function object(value:unknown,keys:string[]):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail('Dati della procedura non validi.');}

/** A reviewed recipe, never an automatic conversion of model output into instructions. */
export function createWorkflowLearning({operations,workspace,checkSources=assertSourceEvidence}:Options){
  async function source(input:unknown){
    object(input,['taskId','expectedVersion']);
    if(typeof input.taskId!=='string'||!Number.isSafeInteger(input.expectedVersion))throw fail('Scegli un incarico e la sua versione attuale.');
    const task=(await operations.getSnapshot()).tasks.find(task=>task.id===input.taskId);
    if(!task)throw fail('Incarico non trovato.',404);
    if(task.version!==input.expectedVersion)throw fail('La consegna è cambiata. Riaprila prima di creare la procedura.',409);
    const artifact=task.artifacts.at(-1);
    if(task.status!=='completed'||artifact?.decision!=='approved')throw fail('Approva la consegna più recente prima di creare una procedura.',409);
    const snapshot=await workspace.getSnapshot();
    if(!snapshot.scopes.some(scope=>scope.id===task.scopeId&&!['shared','archive'].includes(scope.kind)))throw fail('L’ambito della consegna non è più disponibile.',409);
    await checkSources(artifact.context,task.scopeId);
    for(const ref of artifact.context?.memories||[]){
      const memory=snapshot.memories.find(item=>item.id===ref.id);
      if(!memory||memory.version!==ref.version||memory.status!=='confirmed'||!agents.every(id=>accessible(memory,task.scopeId,id)))throw fail('La consegna usa memorie riservate o cambiate. Prepara una procedura manuale senza quelle informazioni.',409);
    }
    for(const ref of artifact.context?.workflows||[]){
      const workflow=snapshot.workflows.find(item=>item.id===ref.id);
      if(!workflow||workflow.version!==ref.version||workflow.status!=='ready'||!accessible(workflow,task.scopeId))throw fail('Una procedura della consegna è cambiata. Rivedi il lavoro prima di riutilizzarlo.',409);
    }
    let template:Workflow|undefined;
    if(task.workflowInputs){
      template=snapshot.workflows.find(item=>item.id===task.workflowId);
      if(!template||template.status!=='ready'||!accessible(template,task.scopeId))throw fail('La procedura originale non è più disponibile. Rivedi il lavoro prima di riutilizzarlo.',409);
      // Revalidate the complete original template before copying its method. The
      // populated step instructions belong to one use and must not become defaults.
      hydrateWorkflowFromSnapshot(template,task.workflowInputs);
    }
    return {task,artifact,template,provenance:`Approved task: ${task.title} · delivery v${artifact.version} · task ${task.id}`};
  }
  return {
    async preview(input:unknown){
      const {task,artifact,template,provenance}=await source(input),truncated:string[]=[];
      const clip=(value:string,max:number,field:string)=>{if(value.length>max)truncated.push(field);return value.slice(0,max);};
      const steps=template?.steps||task.steps.map(step=>({title:step.title,agentId:step.agentId,output:step.instruction}));
      return {origin:{taskId:task.id,expectedVersion:task.version,artifactVersion:artifact.version},truncated,workflow:{scopeId:task.scopeId,title:clip(task.title,140,'title'),description:template?.description||'',input:clip(template?.input??task.workflowInputs?.originalBrief??task.brief,4000,'input'),output:clip(template?.output??task.title,4000,'output'),status:'draft',inputFields:template?.inputFields?.map(field=>({...field,defaultValue:''}))??starterWorkflowFields(),sharedWith:[],source:provenance,steps:steps.map((step,index)=>({title:clip(step.title,140,`steps.${index}.title`),agentId:step.agentId,output:clip(step.output,2000,`steps.${index}.output`)}))}};
    },
    async save(input:unknown){
      object(input,['taskId','expectedVersion','workflow']);
      const {task,provenance}=await source({taskId:input.taskId,expectedVersion:input.expectedVersion});
      object(input.workflow,['title','description','input','output','steps','status','inputFields']);
      const before=await workspace.getSnapshot();
      const snapshot=await workspace.mutate('saveWorkflow',{...input.workflow,scopeId:task.scopeId,sharedWith:[],source:provenance});
      const workflow=snapshot.workflows.find(item=>!before.workflows.some(old=>old.id===item.id));
      return {snapshot,workflowId:workflow?.id};
    }
  };
}
