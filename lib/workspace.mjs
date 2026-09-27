import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const AGENT_IDS = ['nova', 'radar', 'forge', 'muse', 'growth'];
const BASE_SCOPES = [
  { id: 'shared', name: 'Profilo condiviso', kind: 'shared', parentId: null },
  { id: 'personal', name: 'Personale', kind: 'personal', parentId: null },
  { id: 'business', name: 'Imprenditoria', kind: 'business', parentId: null },
  { id: 'development', name: 'Sviluppo', kind: 'development', parentId: null },
  { id: 'consulting', name: 'Consulenza', kind: 'consulting', parentId: null },
  { id: 'legacy', name: 'Conversazione iniziale', kind: 'archive', parentId: null, description: 'Storico precedente alla separazione degli ambiti: può contenere temi diversi.' },
];
const MEMORY_FIELDS = ['scopeId', 'type', 'title', 'content', 'status', 'source', 'sharedWith', 'agentIds'];
const WORKFLOW_FIELDS = ['scopeId', 'title', 'description', 'input', 'steps', 'output', 'sharedWith', 'status', 'source'];
const RECORD_FIELDS = ['id', 'version', 'createdAt', 'updatedAt'];
const STOPWORDS = new Set('the and for with from this that have your sono delle della dello degli nella nello negli per con che una uno del dei gli non come cosa fare alla allo alle tra nel un di da il lo la le si mi ti su ed or of to in is it an'.split(' '));
const clone = value => JSON.parse(JSON.stringify(value));
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function failure(message, code = 'VALIDATION_ERROR', status = 400) {
  return Object.assign(new Error(message), { code, status, statusCode: status });
}
function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw failure(`${label}: oggetto non valido.`);
  }
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || (keys && !keys.includes(key))) throw failure(`${label}: campo non consentito (${key}).`);
  }
  return value;
}
function string(value, label, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\u0000')) {
    throw failure(`${label}: usa ${allowEmpty ? '0' : '1'}–${max} caratteri.`);
  }
  return value.trim();
}
function identifier(value, label = 'Identificativo') {
  const id = string(value, label, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw failure(`${label} non valido.`);
  return id;
}
function choice(value, values, label) {
  if (!values.includes(value)) throw failure(`${label} non valido.`);
  return value;
}
function array(value, label, max = 2000) {
  if (!Array.isArray(value) || value.length > max) throw failure(`${label}: elenco non valido o troppo lungo.`);
  return value;
}
function knownScope(snapshot, id) {
  identifier(id, 'Ambito');
  const scope = snapshot.scopes.find(item => item.id === id);
  if (!scope) throw failure('Ambito non trovato.', 'NOT_FOUND', 404);
  return scope;
}
function scopeList(snapshot, value) {
  const ids = array(value, 'Ambiti condivisi', 200).map(id => knownScope(snapshot, id).id);
  if (new Set(ids).size !== ids.length) throw failure('Gli ambiti condivisi devono essere univoci.');
  // Global sharing is explicit through the record's scope, never through an alias.
  if (ids.includes('shared')) throw failure('Per condividere con tutti scegli Profilo condiviso come ambito.');
  return ids;
}
function memoryFields(snapshot, value) {
  return {
    scopeId: knownScope(snapshot, value.scopeId).id,
    type: choice(value.type, ['fact', 'preference', 'decision', 'pattern'], 'Tipo memoria'),
    title: string(value.title, 'Titolo', 160),
    content: string(value.content, 'Contenuto', 8000),
    status: choice(value.status, ['confirmed', 'proposed'], 'Stato memoria'),
    source: string(value.source, 'Fonte', 1000, true),
    sharedWith: scopeList(snapshot, value.sharedWith),
    agentIds: array(value.agentIds, 'Agenti', 5).map(id => choice(id, AGENT_IDS, 'Agente')),
  };
}
function workflowFields(snapshot, value) {
  const steps = array(value.steps, 'Passaggi', 12).map(step => {
    object(step, 'Passaggio', ['title', 'agentId', 'output']);
    return { title: string(step.title, 'Titolo passaggio', 160), agentId: choice(step.agentId, AGENT_IDS, 'Agente'), output: string(step.output, 'Risultato passaggio', 2000) };
  });
  if (!steps.length) throw failure('La procedura deve contenere almeno un passaggio.');
  return {
    scopeId: knownScope(snapshot, value.scopeId).id,
    title: string(value.title, 'Titolo', 160),
    description: string(value.description, 'Descrizione', 4000, true),
    input: string(value.input, 'Materiali iniziali', 4000, true),
    steps,
    output: string(value.output, 'Consegna', 4000),
    sharedWith: scopeList(snapshot, value.sharedWith),
    status: choice(value.status, ['draft', 'ready'], 'Stato procedura'),
    source: string(value.source, 'Fonte', 1000, true),
  };
}
function metadata(record) {
  identifier(record.id);
  if (!Number.isSafeInteger(record.version) || record.version < 1) throw failure('Versione record non valida.');
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof record[field] !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(record[field]) || !Number.isFinite(Date.parse(record[field]))) throw failure('Data record non valida.');
  }
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) throw failure('Ordine delle date non valido.');
}
function validateRecord(snapshot, record, fields, validateFields) {
  object(record, 'Record', [...RECORD_FIELDS, ...fields, 'revisions']);
  metadata(record);
  validateFields(snapshot, record);
  const revisions = array(record.revisions, 'Revisioni', 10000);
  if (revisions.length !== record.version - 1) throw failure('Storico revisioni non coerente.');
  revisions.forEach((revision, index) => {
    object(revision, 'Revisione', [...RECORD_FIELDS, ...fields]);
    metadata(revision);
    validateFields(snapshot, revision);
    if (revision.id !== record.id || revision.version !== index + 1 || revision.createdAt !== record.createdAt) throw failure('Storico revisioni non valido.');
  });
  if (record.agentIds && new Set(record.agentIds).size !== record.agentIds.length) throw failure('Gli agenti devono essere univoci.');
}
function validateSnapshot(snapshot) {
  object(snapshot, 'Archivio', ['version', 'scopes', 'memories', 'workflows']);
  if (snapshot.version !== SCHEMA_VERSION) throw failure('Versione archivio non supportata.');
  array(snapshot.scopes, 'Ambiti', 200);
  array(snapshot.memories, 'Memorie', 2000);
  array(snapshot.workflows, 'Procedure', 300);
  const ids = new Set();
  for (const scope of snapshot.scopes) {
    object(scope, 'Ambito', ['id', 'name', 'kind', 'parentId', 'description']);
    identifier(scope.id);
    string(scope.name, 'Nome ambito', 100);
    if (has(scope, 'description')) string(scope.description, 'Descrizione ambito', 1000, true);
    choice(scope.kind, [...BASE_SCOPES.map(item => item.kind), 'client', 'project'], 'Tipo ambito');
    if (ids.has(scope.id)) throw failure('Ambiti duplicati.');
    ids.add(scope.id);
  }
  for (const base of BASE_SCOPES) {
    const scope = snapshot.scopes.find(item => item.id === base.id);
    if (!scope || scope.kind !== base.kind || scope.parentId !== null) throw failure('Ambiti di base mancanti o modificati.');
  }
  for (const scope of snapshot.scopes) {
    if (BASE_SCOPES.some(base => base.id === scope.id)) continue;
    if (!['client', 'project'].includes(scope.kind)) throw failure('Tipo di ambito personalizzato non valido.');
    validParent(snapshot, scope.kind, scope.parentId);
    const visited = new Set([scope.id]);
    let parentId = scope.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) throw failure('Gerarchia degli ambiti circolare.');
      visited.add(parentId);
      parentId = knownScope(snapshot, parentId).parentId;
    }
  }
  for (const [records, fields, validateFields] of [[snapshot.memories, MEMORY_FIELDS, memoryFields], [snapshot.workflows, WORKFLOW_FIELDS, workflowFields]]) {
    const recordIds = new Set();
    for (const record of records) {
      validateRecord(snapshot, record, fields, validateFields);
      if (recordIds.has(record.id)) throw failure('Record duplicati.');
      recordIds.add(record.id);
    }
  }
  return snapshot;
}
function validParent(snapshot, kind, parentId) {
  const parent = knownScope(snapshot, parentId);
  if (['shared', 'archive'].includes(parent.kind) || (kind === 'client' && !['business', 'development', 'consulting'].includes(parent.kind))) throw failure('Il contenitore scelto non è valido per questo ambito.');
  return parent.id;
}
function seed() {
  const now = new Date().toISOString();
  const procedure = (id, scopeId, title, description, input, steps, output) => ({
    id, scopeId, title, description, input, steps: steps.map(([title, agentId, output]) => ({ title, agentId, output })), output,
    sharedWith: [], status: 'draft', source: 'Modello iniziale modificabile di Fuori Studio; nessuna esecuzione effettuata.',
    version: 1, createdAt: now, updatedAt: now, revisions: [],
  });
  return {
    version: SCHEMA_VERSION, scopes: clone(BASE_SCOPES), memories: [], workflows: [
      procedure('weekly-business-review', 'business', 'Revisione settimanale imprenditore', 'Rivedere obiettivi, risultati e scelte della settimana.', 'Obiettivi, attività svolte, risultati disponibili e ostacoli.', [
        ['Raccogliere risultati e ostacoli', 'nova', 'Riepilogo basato sui materiali forniti.'],
        ['Valutare opportunità e priorità', 'growth', 'Proposte motivate, con ipotesi esplicite.'],
        ['Preparare le decisioni', 'nova', 'Decisioni da approvare e piano della prossima settimana.'],
      ], 'Una revisione e un piano proposto da approvare.'),
      procedure('consulting-brief-delivery', 'consulting', 'Dal brief alla consegna di consulenza', 'Strutturare un incarico, preparare una bozza e verificarla sul brief.', 'Brief del cliente, materiali autorizzati, vincoli e criteri di accettazione.', [
        ['Chiarire obiettivo e vincoli', 'nova', 'Brief operativo con questioni aperte.'],
        ['Analizzare i materiali', 'radar', 'Evidenze dai materiali e informazioni da verificare.'],
        ['Preparare la consegna', 'muse', 'Bozza strutturata adatta al destinatario.'],
        ['Rivedere rispetto al brief', 'nova', 'Controllo dei criteri e richiesta di approvazione.'],
      ], 'Una consegna proposta con fonti e questioni aperte.'),
      procedure('development-problem-review', 'development', 'Dal problema al piano di sviluppo', 'Trasformare un problema in una proposta tecnica verificabile.', 'Problema, comportamento atteso, contesto tecnico e vincoli.', [
        ['Definire il problema', 'nova', 'Obiettivo e criteri di accettazione.'],
        ['Preparare una soluzione', 'forge', 'Piano tecnico, alternative e verifiche necessarie.'],
        ['Rivedere piano e rischi', 'nova', 'Piano rivisto da approvare prima dell’esecuzione.'],
      ], 'Un piano di sviluppo con verifiche e decisioni esplicite.'),
    ],
  };
}
function accessible(record, scopeId) {
  return record.scopeId === scopeId || record.scopeId === 'shared' || record.sharedWith.includes(scopeId);
}
function tokens(value, limit = 40) {
  return [...new Set(value.toLocaleLowerCase('it').normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]{3,}/gu) || [])].filter(token => !STOPWORDS.has(token)).slice(0, limit);
}
function memoryContext(snapshot, scopeId, query, agentId) {
  const queryTokens = tokens(query);
  const ranked = snapshot.memories.filter(record => record.status === 'confirmed' && accessible(record, scopeId) && (!record.agentIds.length || record.agentIds.includes(agentId))).map(record => {
    const titleTokens = new Set(tokens(record.title));
    const bodyTokens = new Set(tokens(record.content, 2000));
    const matches = queryTokens.reduce((score, token) => score + (titleTokens.has(token) ? 4 : 0) + (bodyTokens.has(token) ? 1 : 0), 0);
    const constraint = ['preference', 'decision'].includes(record.type);
    return { record, matches, constraint, score: matches + (record.scopeId === scopeId ? 1 : 0) };
  }).filter(item => !queryTokens.length || item.matches > 0 || item.constraint);
  const order = (a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt) || a.record.id.localeCompare(b.record.id);
  ranked.sort(order);
  // Reserve room for up to three explicit preferences/decisions even on unrelated queries.
  const selected = ranked.filter(item => item.constraint).slice(0, 3);
  for (const item of ranked) if (selected.length < 8 && !selected.includes(item)) selected.push(item);
  return selected.sort(order).map(({ record }) => {
    const { revisions, sharedWith, ...context } = record;
    return { ...clone(context), content: record.content.slice(0, 1500), source: record.source.slice(0, 300), truncated: record.content.length > 1500 || record.source.length > 300 };
  });
}
function workflowContext(record) {
  if (!record) return null;
  const { revisions, sharedWith, ...context } = record;
  return {
    ...clone(context), description: record.description.slice(0, 1200), input: record.input.slice(0, 1500), output: record.output.slice(0, 1500), source: record.source.slice(0, 300),
    steps: record.steps.map(step => ({ ...step, output: step.output.slice(0, 500) })),
    truncated: record.description.length > 1200 || record.input.length > 1500 || record.output.length > 1500 || record.source.length > 300 || record.steps.some(step => step.output.length > 500),
  };
}

export function createWorkspaceStore({ directory } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw failure('Directory dell’archivio non valida.');
  const dataDirectory = resolve(directory);
  const file = resolve(dataDirectory, 'workspace.json');
  let queue = Promise.resolve();
  const enqueue = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  async function persist(snapshot) {
    validateSnapshot(snapshot);
    const data = JSON.stringify(snapshot, null, 2) + '\n';
    if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw failure('Archivio troppo grande: esporta o elimina alcuni contenuti.', 'WORKSPACE_FULL', 413);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const temporary = resolve(dataDirectory, `.workspace-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(data, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, file);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function load() {
    let raw;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw failure('Archivio troppo grande o non valido.');
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        const snapshot = seed();
        await persist(snapshot);
        return snapshot;
      }
      if (error.code !== 'VALIDATION_ERROR') throw error;
      throw failure('Archivio non leggibile. Il file è stato preservato.', 'WORKSPACE_CORRUPT', 503);
    }
    try {
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw failure('Archivio troppo grande.');
      return validateSnapshot(JSON.parse(raw));
    } catch {
      throw failure('Archivio danneggiato o di versione incompatibile. Il file è stato preservato: ripristina una copia valida.', 'WORKSPACE_CORRUPT', 503);
    }
  }
  function saveRecord(snapshot, collection, payload, fields, validateFields) {
    object(payload, 'Dati', ['id', 'expectedVersion', ...fields]);
    const id = has(payload, 'id') ? identifier(payload.id) : null;
    const existing = id ? snapshot[collection].find(record => record.id === id) : null;
    if (has(payload, 'id') && !existing) throw failure('Record non trovato.', 'NOT_FOUND', 404);
    if (has(payload, 'expectedVersion')) {
      if (!Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion < 1) throw failure('Versione attesa non valida.');
      if (!existing || existing.version !== payload.expectedVersion) throw failure('Il record è cambiato. Ricarica prima di salvare.', 'VERSION_CONFLICT', 409);
    }
    const defaults = collection === 'memories' ? { type: 'fact', status: 'proposed', source: '', sharedWith: [], agentIds: [] } : { description: '', input: '', source: '', sharedWith: [], status: 'draft' };
    const candidate = {};
    for (const field of fields) candidate[field] = has(payload, field) ? payload[field] : existing ? existing[field] : defaults[field];
    const clean = validateFields(snapshot, candidate);
    const now = new Date(Math.max(Date.now(), existing ? Date.parse(existing.updatedAt) : 0)).toISOString();
    if (existing) {
      const { revisions, ...previous } = existing;
      const next = { ...clean, id: existing.id, version: existing.version + 1, createdAt: existing.createdAt, updatedAt: now, revisions: [...revisions, clone(previous)] };
      snapshot[collection][snapshot[collection].indexOf(existing)] = next;
    } else {
      snapshot[collection].push({ ...clean, id: randomUUID(), version: 1, createdAt: now, updatedAt: now, revisions: [] });
    }
  }
  return {
    getSnapshot: () => enqueue(async () => clone(await load())),
    mutate: (action, payload) => enqueue(async () => {
      string(action, 'Azione', 40);
      const snapshot = await load();
      switch (action) {
        case 'createScope': {
          object(payload, 'Ambito', ['name', 'kind', 'parentId']);
          const kind = choice(payload.kind, ['client', 'project'], 'Tipo ambito');
          snapshot.scopes.push({ id: randomUUID(), name: string(payload.name, 'Nome ambito', 100), kind, parentId: validParent(snapshot, kind, payload.parentId) });
          break;
        }
        case 'saveMemory': saveRecord(snapshot, 'memories', payload, MEMORY_FIELDS, memoryFields); break;
        case 'saveWorkflow': saveRecord(snapshot, 'workflows', payload, WORKFLOW_FIELDS, workflowFields); break;
        case 'deleteMemory':
        case 'deleteWorkflow': {
          object(payload, 'Eliminazione', ['id']);
          const collection = action === 'deleteMemory' ? 'memories' : 'workflows';
          const id = identifier(payload.id);
          const index = snapshot[collection].findIndex(record => record.id === id);
          if (index < 0) throw failure('Record non trovato.', 'NOT_FOUND', 404);
          snapshot[collection].splice(index, 1);
          break;
        }
        default: throw failure('Azione non riconosciuta.');
      }
      await persist(snapshot);
      return clone(snapshot);
    }),
    getContext: ({ scopeId, query = '', agentId = 'nova', workflowId = null } = {}) => enqueue(async () => {
      const snapshot = await load();
      const scope = knownScope(snapshot, scopeId);
      string(query, 'Ricerca', 12000, true);
      choice(agentId, AGENT_IDS, 'Agente');
      let workflow = null;
      if (workflowId !== null) {
        identifier(workflowId, 'Procedura');
        workflow = snapshot.workflows.find(record => record.id === workflowId && record.status === 'ready' && accessible(record, scopeId));
        if (!workflow) throw failure('Procedura non disponibile in questo ambito: scegli una procedura pronta e condivisa.', 'NOT_FOUND', 404);
      }
      return { scope: clone(scope), memories: memoryContext(snapshot, scopeId, query, agentId), workflow: workflowContext(workflow) };
    }),
  };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const workspaceStore = createWorkspaceStore({ directory: process.env.FUORI_STUDIO_DATA_DIR || resolve(root, '.local') });
export default workspaceStore;
