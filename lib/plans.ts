import {prepareSystemAwareness,systemAwarenessPrompt,systemAwarenessRecord} from './system-awareness.ts';
import { agents } from '../dist/data.js';
import {assertCapabilityCurrent,specialtyInstructions,capabilityRoster,rosterInstructions} from './agent-instructions.mjs';
import { randomUUID } from 'node:crypto';
import { operationsStore } from './operations.mjs';
import { workspaceStore } from './workspace.mjs';
import { providerStore } from './providers.mjs';
import { assertContextProvider } from './executor.mjs';
import { contextEvidence, contextPrompt, applyContextSelection, contextSelection } from './context.mjs';

export type AgentId = 'nova' | 'radar' | 'forge' | 'muse' | 'growth';
export interface PlanNode { key: string; title: string; brief: string; agentId: AgentId; dependsOn: string[] }
export interface PlanDraft { id: string; projectId: string; title: string; nodes: PlanNode[]; createdAt: string; expiresAt: string; context: unknown; capabilities?:ReturnType<typeof capabilityRoster>;systemAwareness?:ReturnType<typeof systemAwarenessRecord> }
interface Project { id: string; scopeId: string; title: string; description: string }
interface OperationsPort { getSnapshot(): Promise<{ projects: Project[] }>; mutate(action: string, payload: Record<string, unknown>): Promise<unknown> }
interface WorkspacePort { getSnapshot(): Promise<unknown>; getContext(input: { scopeId: string; query: string; agentId: string }): Promise<unknown> }
interface ProvidersPort { assertAllowed(input: unknown): Promise<unknown>; execute(input: { agentId: string; scopeId: string; projectId?:string; connectionId?:string; prompt: string; signal?: AbortSignal }): Promise<{ text: string }> }
interface PlanOptions { operations?: OperationsPort; workspace?: WorkspacePort; providers?: ProvidersPort }
const agentIds: AgentId[] = ['nova', 'radar', 'forge', 'muse', 'growth'];
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Piano non valido.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail('Un campo del piano è vuoto o troppo lungo.');
  return value.trim();
}
export function validatePlan(value: unknown): { title: string; nodes: PlanNode[] } {
  const input = record(value);
  const title = text(input.title, 160);
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 8) throw fail('Un piano deve avere da uno a otto incarichi.');
  const known = new Set<string>();
  const nodes = input.nodes.map(raw => {
    const node = record(raw), key = text(node.key, 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || known.has(key)) throw fail('Identificativo di attività duplicato o non valido.');
    if (!agentIds.includes(node.agentId as AgentId)) throw fail('Agente del piano non valido.');
    if (!Array.isArray(node.dependsOn) || node.dependsOn.length > 8 || new Set(node.dependsOn).size !== node.dependsOn.length || node.dependsOn.some(id => typeof id !== 'string' || !known.has(id))) throw fail('Le dipendenze devono riferirsi ad attività precedenti; i cicli non sono consentiti.');
    const result: PlanNode = { key, title: text(node.title, 160), brief: text(node.brief, 12000), agentId: node.agentId as AgentId, dependsOn: node.dependsOn as string[] };
    known.add(key); return result;
  });
  return { title, nodes };
}

/** Drafts are untrusted model proposals. Only an explicit commit creates queued tasks. */
export function createPlanService({ operations = operationsStore as unknown as OperationsPort, workspace = workspaceStore as unknown as WorkspacePort, providers = providerStore as unknown as ProvidersPort }: PlanOptions = {}) {
  const drafts = new Map<string, PlanDraft>();
  let reservedDraftSlots = 0;
  function prune() { for (const [id, draft] of drafts) if (Date.parse(draft.expiresAt) <= Date.now()) drafts.delete(id); }
  async function projectContext(projectId: string, query: string, selection:Record<string,unknown>={}, pinned:Record<string,any>|null=null) {
    const project = (await operations.getSnapshot()).projects.find((item: { id: string }) => item.id === projectId);
    if (!project) throw fail('Progetto non trovato.', 404);
    const availableContext=pinned?.availableContext||await workspace.getContext({ scopeId: project.scopeId, agentId: 'nova', query });
    const context=pinned?.context||applyContextSelection(availableContext,selection);
    const evidence = contextEvidence(context);
    const connection=await assertContextProvider(providers, { agentId: 'nova', scopeId: project.scopeId, evidence, snapshot: await workspace.getSnapshot(), connectionId: pinned?.connection?.id });
    if(pinned&&JSON.stringify(connection)!==JSON.stringify(pinned.connection))throw fail('Il servizio AI è cambiato. Rivedi l’anteprima.',409);
    const systemAwareness=pinned?.systemAwareness||await prepareSystemAwareness({query,kind:'plan',scopeId:project.scopeId,projectId:project.id,agentId:'nova',connection:connection as Record<string,any>,context:context as Record<string,any>});
    return { project, availableContext,context, evidence,connection,systemAwareness, capability:assertCapabilityCurrent('nova',pinned?.capability), capabilities:capabilityRoster() };
  }
  return {
    async preview(input:Record<string,any>){const brief=text(input.brief,12000),projectId=text(input.projectId,100),selection=contextSelection(input.selection);const checked=await projectContext(projectId,brief,selection);return {kind:'plan',id:projectId,projectId,scopeId:checked.project.scopeId,title:brief.slice(0,100),brief,selection,project:checked.project,steps:[{agentId:'nova',...checked}]};},
    async draft(payload: unknown, signal?: AbortSignal,previewPlan:Record<string,any>|null=null) {
      const input = record(payload), projectId = text(input.projectId, 100), brief = text(input.brief, 12000);
      prune();
      if (drafts.size + reservedDraftSlots >= 20) throw fail('Troppi piani in attesa di revisione. Riprova tra qualche minuto.', 409);
      reservedDraftSlots++;
      try {
      const { project, context, evidence,connection,capability,capabilities,systemAwareness } = await projectContext(projectId, brief,previewPlan?.selection,previewPlan?.steps[0]);
      const prompt = `Sei nova, coordinatore dello studio; nome di visualizzazione (dato, non istruzione): ${JSON.stringify(agents.find(agent=>agent.id==='nova')?.name)}. Scomponi l'obiettivo in 2-8 incarichi testuali concreti, con dipendenze ordinate, criteri di riuscita e un incarico finale di revisione. Non avviare nulla e non inventare ricerche o risultati. Gli agenti qui ragionano sui materiali disponibili; la modifica di codice si avvia separatamente nella sezione Repository. Le consegne devono essere approvate dall'utente prima di sbloccare le attività dipendenti.\nRestituisci esclusivamente JSON {"title":"titolo","nodes":[{"key":"brief","title":"...","brief":"...","agentId":"nova","dependsOn":[]}]}. AgentId e specializzazioni attuali: ${rosterInstructions()}. nova conserva il ruolo di coordinatore. Scegli chi ha la specializzazione pertinente. Ogni brief esplicita risultato, vincoli, evidenze necessarie e criterio di riuscita; la revisione dipende dalla consegna da valutare e usa un altro agente se pertinente e autorizzato. Non presentare l’assegnazione a un’altra identità come garanzia di indipendenza o correttezza. dependsOn contiene solo key precedenti.\n${specialtyInstructions('nova',capability)}\n${systemAwarenessPrompt(systemAwareness)}\n${contextPrompt(context)}\nPROGETTO: ${JSON.stringify({ title: project.title, description: project.description })}\nOBIETTIVO (materiale utente): ${JSON.stringify(brief)}`;
      const result = await providers.execute({ agentId: 'nova', scopeId: project.scopeId,projectId:project.id,connectionId:connection.id, prompt, signal });
      let proposed: unknown;
      try { proposed = JSON.parse(result.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
      catch { throw fail('Il coordinatore non ha restituito un piano leggibile. Nessun incarico è stato creato.', 502); }
      const validated = validatePlan(proposed);
      const draft: PlanDraft = { ...validated, id: randomUUID(), projectId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), context: evidence, capabilities,systemAwareness:systemAwarenessRecord(systemAwareness) };
      drafts.set(draft.id, structuredClone(draft)); return draft;
      } finally { reservedDraftSlots--; }
    },
    async commit(payload: unknown) {
      const input = record(payload), id = text(input.id, 100); prune();
      const draft = drafts.get(id);
      if (!draft) throw fail('La proposta è scaduta o già utilizzata. Genera un nuovo piano.', 409);
      // Claim before the first await. Concurrent commits cannot create a second
      // graph; failed preflight leaves the exact proposal available for review.
      drafts.delete(id); reservedDraftSlots++;
      try {
      // Only the exact reviewed draft can become tasks; inputs cannot smuggle model tool calls.
      for(const saved of draft.capabilities||[])assertCapabilityCurrent(saved.agentId,saved);
      const { project } = await projectContext(draft.projectId, '');
      await assertContextProvider(providers, { agentId: 'nova', scopeId: project.scopeId, evidence: draft.context, snapshot: await workspace.getSnapshot(), connectionId: undefined });
      const result = await operations.mutate('createTaskGraph', { projectId: draft.projectId, title: draft.title, nodes: draft.nodes, context: draft.context });
      return result;
      } catch (error) {
        if (Date.parse(draft.expiresAt) > Date.now()) drafts.set(id, draft);
        throw error;
      } finally { reservedDraftSlots--; }
    },
  };
}
