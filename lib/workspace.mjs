import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultArchive } from './archive.mjs';
import { initialMemoryAssistant, defaultMemoryPolicy, candidateFromSuggestion, containsMemorySecret, isAutomaticMemorySafe, memoryDigest, memoryFingerprint, memorySourceKey } from './memory-assistant.mjs';
import { syncRecord, recordHash } from './sync-records.mjs';
import { augmentContextSources } from './context.mjs';

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
  object(snapshot, 'Archivio', ['version', 'scopes', 'memories', 'workflows', 'memoryAssistant', 'syncTombstones', 'importReceipts']);
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
  // Schema 1 archives are upgraded additively. Existing records and versions are
  // never rewritten or silently discarded during this migration.
  if (!has(snapshot, 'memoryAssistant')) snapshot.memoryAssistant = initialMemoryAssistant();
  validateMemoryAssistant(snapshot);
  if (!has(snapshot, 'syncTombstones')) snapshot.syncTombstones = [];
  const deletedIds = new Set();
  for (const tombstone of array(snapshot.syncTombstones, 'Record eliminati', 20000)) {
    object(tombstone, 'Record eliminato', ['collection', 'id', 'scopeId', 'deletedAt']);
    choice(tombstone.collection, ['memories', 'workflows'], 'Archivio eliminato');
    identifier(tombstone.id); knownScope(snapshot, tombstone.scopeId);
    if (!Number.isFinite(Date.parse(tombstone.deletedAt))) throw failure('Data eliminazione non valida.');
    const key = `${tombstone.collection}/${tombstone.id}`;
    if (deletedIds.has(key) || snapshot[tombstone.collection].some(item => item.id === tombstone.id)) throw failure('Registro eliminazioni incoerente.');
    deletedIds.add(key);
  }
  if (!has(snapshot, 'importReceipts')) snapshot.importReceipts = [];
  const importIds = new Set();
  for (const receipt of array(snapshot.importReceipts, 'Importazioni completate', 10000)) {
    object(receipt, 'Importazione completata', ['id', 'scopeId', 'createdAt', 'imported', 'skipped']);
    identifier(receipt.id); knownScope(snapshot, receipt.scopeId);
    if (importIds.has(receipt.id) || !Number.isFinite(Date.parse(receipt.createdAt))) throw failure('Ricevuta importazione non valida.');
    importIds.add(receipt.id);
    for (const [key, fields] of [['imported', ['memories', 'workflows']], ['skipped', ['duplicates', 'conflicts']]]) {
      object(receipt[key], 'Conteggi importazione', fields);
      for (const field of fields) if (!Number.isSafeInteger(receipt[key][field]) || receipt[key][field] < 0) throw failure('Conteggio importazione non valido.');
    }
  }
  return snapshot;
}
function validateSource(source) {
  object(source, 'Fonte verificata', ['kind', 'scopeId', 'conversationId', 'messageId', 'version', 'quote']);
  if (source.kind !== 'message') throw failure('Tipo fonte non valido.');
  for (const field of ['scopeId', 'conversationId', 'messageId']) identifier(source[field]);
  if (typeof source.version !== 'string' || !/^[a-f0-9]{64}$/.test(source.version)) throw failure('Versione fonte non valida.');
  string(source.quote, 'Estratto fonte', 12000);
}
function validateMemoryAssistant(snapshot) {
  const assistant = object(snapshot.memoryAssistant, 'Memoria assistita', ['version', 'policies', 'candidates', 'suppressions', 'actions']);
  if (assistant.version !== 1) throw failure('Versione memoria assistita non supportata.');
  const policyScopes = new Set();
  for (const policy of array(assistant.policies, 'Politiche memoria', 200)) {
    object(policy, 'Politica memoria', ['scopeId', 'version', 'mode', 'learningEnabled', 'automaticTypes']);
    knownScope(snapshot, policy.scopeId);
    if (policyScopes.has(policy.scopeId) || !Number.isSafeInteger(policy.version) || policy.version < 1 || typeof policy.learningEnabled !== 'boolean') throw failure('Politica memoria non valida.');
    policyScopes.add(policy.scopeId);
    choice(policy.mode, ['manual', 'assisted', 'automatic'], 'Modalità memoria');
    const types = array(policy.automaticTypes, 'Categorie automatiche', 2);
    types.forEach(type => choice(type, ['preference', 'pattern'], 'Categoria automatica'));
    if (new Set(types).size !== types.length) throw failure('Categorie automatiche duplicate.');
  }
  const ids = new Set();
  for (const candidate of array(assistant.candidates, 'Proposte memoria', 2000)) {
    object(candidate, 'Proposta memoria', ['id', 'version', 'scopeId', 'type', 'title', 'content', 'source', 'sensitivity', 'status', 'conflicts', 'createdAt', 'updatedAt', 'memoryId', 'memoryVersion', 'actionId']);
    metadata(candidate);
    if (ids.has(candidate.id)) throw failure('Proposte duplicate.');
    ids.add(candidate.id);
    knownScope(snapshot, candidate.scopeId);
    choice(candidate.type, ['fact', 'preference', 'decision', 'pattern'], 'Tipo proposta');
    string(candidate.title, 'Titolo proposta', 160);
    string(candidate.content, 'Contenuto proposta', 8000);
    validateSource(candidate.source);
    if (candidate.source.scopeId !== candidate.scopeId) throw failure('Ambito fonte incoerente.');
    choice(candidate.sensitivity, ['ordinary', 'sensitive'], 'Sensibilità');
    choice(candidate.status, ['pending', 'approved', 'rejected'], 'Stato proposta');
    for (const conflict of array(candidate.conflicts, 'Conflitti proposta', 2000)) {
      object(conflict, 'Conflitto proposta', ['id', 'version', 'title', 'content']);
      identifier(conflict.id);
      if (!Number.isSafeInteger(conflict.version) || conflict.version < 1) throw failure('Versione conflitto non valida.');
      string(conflict.title, 'Titolo conflitto', 160);
      string(conflict.content, 'Contenuto conflitto', 8000);
    }
    for (const field of ['memoryId', 'actionId']) if (has(candidate, field)) identifier(candidate[field]);
    if (has(candidate, 'memoryVersion') && (!Number.isSafeInteger(candidate.memoryVersion) || candidate.memoryVersion < 1)) throw failure('Versione memoria non valida.');
  }
  for (const suppression of array(assistant.suppressions, 'Esclusioni memoria', 20000)) {
    object(suppression, 'Esclusione memoria', ['scopeId', 'fingerprint', 'sourceKey', 'createdAt']);
    knownScope(snapshot, suppression.scopeId);
    for (const field of ['fingerprint', 'sourceKey']) if (suppression[field] !== null && (typeof suppression[field] !== 'string' || !/^[a-f0-9]{64}$/.test(suppression[field]))) throw failure('Esclusione memoria non valida.');
    if (!Number.isFinite(Date.parse(suppression.createdAt))) throw failure('Data esclusione non valida.');
  }
  for (const action of array(assistant.actions, 'Azioni memoria', 2000)) {
    object(action, 'Azione memoria', ['id', 'kind', 'memoryId', 'memoryVersion', 'previous', 'source', 'createdAt', 'undoneAt']);
    identifier(action.id); identifier(action.memoryId);
    choice(action.kind, ['create', 'replace'], 'Tipo azione memoria');
    if (!Number.isSafeInteger(action.memoryVersion) || action.memoryVersion < 1 || !Number.isFinite(Date.parse(action.createdAt)) || (action.undoneAt !== null && !Number.isFinite(Date.parse(action.undoneAt)))) throw failure('Azione memoria non valida.');
    validateSource(action.source);
    if (action.previous !== null) validateRecord(snapshot, action.previous, MEMORY_FIELDS, memoryFields);
  }
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
    version: SCHEMA_VERSION, scopes: clone(BASE_SCOPES), memories: [], memoryAssistant: initialMemoryAssistant(), syncTombstones: [], importReceipts: [], workflows: [
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

export function createWorkspaceStore({ directory, storage } = {}) {
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
    if (storage) { await storage.write('workspace', snapshot); return; }
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
    if (storage) return storage.load('workspace', file, seed, validateSnapshot);
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
    if (collection === 'memories' && containsMemorySecret(`${clean.title}\n${clean.content}\n${clean.source}`)) throw failure('Questo contenuto sembra includere credenziali. Salvale nella connessione AI, non nella memoria.', 'MEMORY_SECRET', 400);
    const now = new Date(Math.max(Date.now(), existing ? Date.parse(existing.updatedAt) : 0)).toISOString();
    if (existing) {
      const { revisions, ...previous } = existing;
      const next = { ...clean, id: existing.id, version: existing.version + 1, createdAt: existing.createdAt, updatedAt: now, revisions: [...revisions, clone(previous)] };
      snapshot[collection][snapshot[collection].indexOf(existing)] = next;
      return next;
    } else {
      const next = { ...clean, id: randomUUID(), version: 1, createdAt: now, updatedAt: now, revisions: [] };
      snapshot[collection].push(next);
      return next;
    }
  }
  function currentPolicy(snapshot, scopeId) {
    knownScope(snapshot, scopeId);
    return snapshot.memoryAssistant.policies.find(policy => policy.scopeId === scopeId) || defaultMemoryPolicy(scopeId);
  }
  function publicSnapshot(snapshot) {
    const result = clone(snapshot);
    result.memoryAssistant.policies = result.scopes.map(scope => currentPolicy(result, scope.id));
    return result;
  }
  function suppress(snapshot, { scopeId, content, source }) {
    const fingerprint = content ? memoryFingerprint(scopeId, content) : null;
    const sourceKey = source ? memorySourceKey(source) : null;
    if (!snapshot.memoryAssistant.suppressions.some(item => item.scopeId === scopeId && item.fingerprint === fingerprint && item.sourceKey === sourceKey)) snapshot.memoryAssistant.suppressions.push({ scopeId, fingerprint, sourceKey, createdAt: new Date().toISOString() });
  }
  function tombstone(snapshot, collection, record) {
    if (!snapshot.syncTombstones.some(item => item.collection === collection && item.id === record.id)) snapshot.syncTombstones.push({ collection, id: record.id, scopeId: record.scopeId, deletedAt: new Date().toISOString() });
  }
  function forgetMemory(snapshot, record) {
    tombstone(snapshot, 'memories', record);
    suppress(snapshot, { scopeId: record.scopeId, content: record.content });
    for (const revision of record.revisions) suppress(snapshot, { scopeId: revision.scopeId, content: revision.content });
    const forgotten = new Set([record, ...record.revisions].map(item => memoryFingerprint(item.scopeId, item.content)));
    const related = item => item.memoryId === record.id || forgotten.has(memoryFingerprint(item.scopeId, item.content));
    for (const candidate of snapshot.memoryAssistant.candidates.filter(related)) suppress(snapshot, { scopeId: candidate.scopeId, content: candidate.content, source: candidate.source });
    for (const action of snapshot.memoryAssistant.actions.filter(item => item.memoryId === record.id)) suppress(snapshot, { scopeId: record.scopeId, source: action.source });
    snapshot.memories = snapshot.memories.filter(item => item.id !== record.id);
    snapshot.memoryAssistant.candidates = snapshot.memoryAssistant.candidates.filter(item => !related(item));
    snapshot.memoryAssistant.actions = snapshot.memoryAssistant.actions.filter(item => item.memoryId !== record.id);
    // Conflict previews are derivative copies; deleting their source removes
    // those previews as well. Suppression stores only irreversible hashes.
    for (const candidate of snapshot.memoryAssistant.candidates) candidate.conflicts = candidate.conflicts.filter(item => item.id !== record.id);
  }
  function conflictsFor(snapshot, candidate) {
    const titleTokens = new Set(tokens(candidate.title, 100));
    const contentTokens = new Set(tokens(candidate.content, 300));
    return snapshot.memories.filter(record => record.scopeId === candidate.scopeId && record.status === 'confirmed' && record.type === candidate.type && memoryFingerprint(record.scopeId, record.content) !== memoryFingerprint(candidate.scopeId, candidate.content)).filter(record => {
      const sameTitle = memoryFingerprint('', record.title) === memoryFingerprint('', candidate.title);
      const otherTitle = tokens(record.title, 100), otherContent = tokens(record.content, 300);
      const titleOverlap = otherTitle.filter(token => titleTokens.has(token)).length / Math.max(1, Math.min(titleTokens.size, otherTitle.length));
      const contentOverlap = otherContent.filter(token => contentTokens.has(token)).length / Math.max(1, Math.min(contentTokens.size, otherContent.length));
      return sameTitle || titleOverlap >= 0.6 || contentOverlap >= 0.6;
    }).map(({ id, version, title, content }) => ({ id, version, title, content }));
  }
  function applyCandidate(snapshot, candidate, { replaceMemoryId, replaceExpectedVersion } = {}) {
    const previous = replaceMemoryId ? snapshot.memories.find(item => item.id === replaceMemoryId) : null;
    if (replaceMemoryId && (!previous || previous.scopeId !== candidate.scopeId)) throw failure('La memoria da sostituire non appartiene a questo ambito.', 'NOT_FOUND', 404);
    if (previous && previous.version !== replaceExpectedVersion) throw failure('La memoria è cambiata. Rivedi il confronto prima di sostituirla.', 'VERSION_CONFLICT', 409);
    // Replacing preserves the old access restrictions. Automatic capture never
    // replaces anything and never acquires a sharing permission from a model.
    const memory = saveRecord(snapshot, 'memories', {
      ...(previous ? { id: previous.id, expectedVersion: previous.version } : {}),
      scopeId: candidate.scopeId, title: candidate.title, content: candidate.content, type: candidate.type, status: 'confirmed',
      source: `Conversazione ${candidate.source.conversationId}, messaggio ${candidate.source.messageId} (SHA-256 ${candidate.source.version}).`,
      sharedWith: previous?.sharedWith || [], agentIds: previous?.agentIds || [],
    }, MEMORY_FIELDS, memoryFields);
    const action = { id: randomUUID(), kind: previous ? 'replace' : 'create', memoryId: memory.id, memoryVersion: memory.version, previous: previous ? clone(previous) : null, source: clone(candidate.source), createdAt: new Date().toISOString(), undoneAt: null };
    snapshot.memoryAssistant.actions.push(action);
    candidate.status = 'approved'; candidate.memoryId = memory.id; candidate.memoryVersion = memory.version; candidate.actionId = action.id;
    return { memory, actionId: action.id };
  }
  function portablePlan(snapshot, { scopeId, memories = [], workflows = [] }) {
    const scope = knownScope(snapshot, scopeId);
    if (['shared', 'archive'].includes(scope.kind)) throw failure('Importa in un ambito di lavoro o personale; la condivisione potrà essere scelta dopo la revisione.');
    const items = [], additions = { memories: [], workflows: [] }, counts = { memories: 0, workflows: 0, duplicates: 0, conflicts: 0 };
    for (const [collection, incoming, fields, validator] of [['memories', array(memories, 'Memorie importate', 2000), MEMORY_FIELDS, memoryFields], ['workflows', array(workflows, 'Procedure importate', 300), WORKFLOW_FIELDS, workflowFields]]) {
      const existing = snapshot[collection].filter(record => record.scopeId === scopeId);
      const fingerprint = record => collection === 'memories' ? memoryFingerprint(scopeId, record.content) : memoryDigest(JSON.stringify({ description: record.description, input: record.input, steps: record.steps, output: record.output }));
      for (const record of incoming) {
        object(record, 'Record portabile', ['id', ...fields]);
        identifier(record.id); identifier(record.scopeId);
        if (!Array.isArray(record.sharedWith) || record.sharedWith.length) throw failure('Un import non può trasferire permessi di condivisione.');
        const value = validator(snapshot, { ...record, scopeId, status: collection === 'memories' ? 'proposed' : 'draft', sharedWith: [], source: `Import Fuori Studio (${record.scopeId}/${record.id}). ${record.source || ''}`.slice(0, 1000) });
        if (containsMemorySecret(JSON.stringify(value))) throw failure('Il file include possibili credenziali. Rimuovile prima di importare.', 'MEMORY_SECRET', 400);
        const compare = existing.concat(additions[collection]);
        const duplicate = compare.some(item => fingerprint(item) === fingerprint(value));
        const conflict = !duplicate && compare.some(item => memoryFingerprint('', item.title) === memoryFingerprint('', value.title));
        const status = duplicate ? 'duplicate' : conflict ? 'conflict' : value.status;
        if (duplicate) counts.duplicates++; else if (conflict) counts.conflicts++; else { counts[collection]++; additions[collection].push(value); }
        items.push({ kind: collection === 'memories' ? 'memory' : 'workflow', title: value.title, status });
      }
    }
    return { items, counts, additions };
  }
  return {
    getSnapshot: () => enqueue(async () => publicSnapshot(await load())),
    previewPortable: payload => enqueue(async () => {
      const { counts, items } = portablePlan(await load(), payload);
      return { counts, items };
    }),
    importPortable: ({ importId, ...payload }) => enqueue(async () => {
      identifier(importId);
      const snapshot = await load(), receipt = snapshot.importReceipts.find(item => item.id === importId);
      if (receipt) {
        if (receipt.scopeId !== payload.scopeId) throw failure('L’importazione appartiene a un altro ambito.', 'IMPORT_CONFLICT', 409);
        return { snapshot: publicSnapshot(snapshot), imported: clone(receipt.imported), skipped: clone(receipt.skipped) };
      }
      const plan = portablePlan(snapshot, payload);
      for (const memory of plan.additions.memories) saveRecord(snapshot, 'memories', memory, MEMORY_FIELDS, memoryFields);
      for (const workflow of plan.additions.workflows) saveRecord(snapshot, 'workflows', workflow, WORKFLOW_FIELDS, workflowFields);
      const result = { imported: { memories: plan.counts.memories, workflows: plan.counts.workflows }, skipped: { duplicates: plan.counts.duplicates, conflicts: plan.counts.conflicts } };
      snapshot.importReceipts.push({ id: importId, scopeId: payload.scopeId, createdAt: new Date().toISOString(), ...result });
      await persist(snapshot);
      return { snapshot: publicSnapshot(snapshot), ...result };
    }),
    exportSync: scopeIds => enqueue(async () => {
      const snapshot = await load();
      const allowed = new Set(array(scopeIds, 'Ambiti sincronizzati', 200).map(id => identifier(id)));
      return { scopes: clone(snapshot.scopes.filter(scope => allowed.has(scope.id))), memories: snapshot.memories.filter(record => allowed.has(record.scopeId)).map(syncRecord), workflows: snapshot.workflows.filter(record => allowed.has(record.scopeId)).map(syncRecord), tombstones: clone(snapshot.syncTombstones.filter(record => allowed.has(record.scopeId))) };
    }),
    applySync: ({ scopeIds, changes, scopes = [] }) => enqueue(async () => {
      const snapshot = await load();
      const allowed = new Set(array(scopeIds, 'Ambiti sincronizzati', 200).map(id => identifier(id)));
      const scopeRecords = array(scopes, 'Ambiti importati', 200);
      for (const scope of scopeRecords) {
        object(scope, 'Ambito importato', ['id', 'name', 'kind', 'parentId', 'description']);
        identifier(scope.id);
        if (!allowed.has(scope.id)) throw failure('L’ambito importato non è abilitato alla sincronizzazione.', 'SYNC_SCOPE_DENIED', 403);
        const local = snapshot.scopes.find(item => item.id === scope.id);
        if (local) {
          if (local.kind !== scope.kind || local.parentId !== scope.parentId) throw failure('La struttura degli ambiti è cambiata. Rivedi il conflitto.', 'VERSION_CONFLICT', 409);
        } else snapshot.scopes.push(clone(scope));
      }
      // Validate scope ancestry and immutable base scopes before applying data.
      validateSnapshot(snapshot);
      const processed = new Set();
      for (const change of array(changes, 'Modifiche sincronizzate', 2300)) {
        object(change, 'Modifica sincronizzata', ['collection', 'scopeId', 'id', 'record', 'expectedHash']);
        const collection = choice(change.collection, ['memories', 'workflows'], 'Archivio sincronizzato'), id = identifier(change.id);
        const key = `${collection}/${id}`;
        if (processed.has(key)) throw failure('Modifica sincronizzata duplicata.');
        processed.add(key);
        const existing = snapshot[collection].find(item => item.id === id);
        if (has(change, 'scopeId') && (!allowed.has(identifier(change.scopeId)) || (existing && existing.scopeId !== change.scopeId) || (change.record && change.record.scopeId !== change.scopeId))) throw failure('La modifica appartiene a un altro ambito.', 'SYNC_SCOPE_DENIED', 403);
        if (existing && !allowed.has(existing.scopeId)) throw failure('Questo record non appartiene agli ambiti sincronizzati.', 'SYNC_SCOPE_DENIED', 403);
        if (recordHash(existing) !== change.expectedHash) throw failure('Il record locale è cambiato. Rivedi il conflitto prima di sincronizzare.', 'VERSION_CONFLICT', 409);
        if (change.record === null) {
          if (existing && collection === 'memories') forgetMemory(snapshot, existing);
          else if (existing) { tombstone(snapshot, collection, existing); snapshot[collection] = snapshot[collection].filter(item => item.id !== id); }
          else if (change.scopeId) { knownScope(snapshot, change.scopeId); tombstone(snapshot, collection, { id, scopeId: change.scopeId }); }
          continue;
        }
        if (snapshot.syncTombstones.some(item => item.collection === collection && item.id === id)) throw failure('Questo record è stato eliminato. Per ricrearlo usa una nuova memoria o procedura.', 'SYNC_DELETED', 409);
        const fields = collection === 'memories' ? MEMORY_FIELDS : WORKFLOW_FIELDS, validator = collection === 'memories' ? memoryFields : workflowFields;
        object(change.record, 'Record importato', ['id', ...fields]);
        if (change.record.id !== id || !allowed.has(change.record.scopeId)) throw failure('Il record importato non appartiene agli ambiti sincronizzati.', 'SYNC_SCOPE_DENIED', 403);
        if (existing && existing.scopeId !== change.record.scopeId) throw failure('La sincronizzazione non può spostare un record tra ambiti.', 'SYNC_SCOPE_DENIED', 403);
        if (!Array.isArray(change.record.sharedWith) || change.record.sharedWith.length) throw failure('La sincronizzazione non può trasferire autorizzazioni di condivisione.', 'SYNC_GRANT_DENIED', 403);
        if (collection === 'memories' && existing && JSON.stringify([...existing.agentIds].sort()) !== JSON.stringify([...(change.record.agentIds || [])].sort())) throw failure('Le autorizzazioni degli agenti differiscono: modificale esplicitamente prima di sincronizzare.', 'SYNC_GRANT_DENIED', 409);
        const incoming = Object.fromEntries(fields.map(field => [field, change.record[field]]));
        incoming.sharedWith = existing?.sharedWith || [];
        if (existing) saveRecord(snapshot, collection, { ...incoming, id, expectedVersion: existing.version }, fields, validator);
        else {
          const next = saveRecord(snapshot, collection, incoming, fields, validator);
          next.id = id;
        }
      }
      await persist(snapshot);
      return publicSnapshot(snapshot);
    }),
    getMemoryPolicy: scopeId => enqueue(async () => clone(currentPolicy(await load(), scopeId))),
    captureMemoryCandidates: ({ scopeId, source, sourceText, candidates }) => enqueue(async () => {
      const snapshot = await load(), scope = knownScope(snapshot, scopeId), policy = currentPolicy(snapshot, scopeId);
      validateSource(source);
      if (source.scopeId !== scopeId || typeof sourceText !== 'string' || source.version !== memoryDigest(sourceText) || !sourceText.includes(source.quote)) throw failure('Fonte memoria non verificabile.', 'STALE_SOURCE', 409);
      if (!policy.learningEnabled || policy.mode === 'manual' || ['shared', 'archive'].includes(scope.kind)) return { snapshot: publicSnapshot(snapshot), captured: [], saved: [] };
      if (!Array.isArray(candidates) || candidates.length > 3) return { snapshot: publicSnapshot(snapshot), captured: [], saved: [] };
      const captured = [], saved = [];
      for (const raw of candidates) {
        const clean = candidateFromSuggestion(raw, { source, sourceText });
        if (!clean) continue;
        const fingerprint = memoryFingerprint(scopeId, clean.content), sourceKey = memorySourceKey(source);
        if (snapshot.memoryAssistant.suppressions.some(item => item.scopeId === scopeId && (item.fingerprint === fingerprint || item.sourceKey === sourceKey))) continue;
        if (snapshot.memories.some(item => item.scopeId === scopeId && memoryFingerprint(scopeId, item.content) === fingerprint) || snapshot.memoryAssistant.candidates.some(item => item.scopeId === scopeId && memoryFingerprint(scopeId, item.content) === fingerprint)) continue;
        const now = new Date().toISOString();
        const candidate = { ...clean, id: randomUUID(), version: 1, scopeId, status: 'pending', conflicts: conflictsFor(snapshot, { ...clean, scopeId }), createdAt: now, updatedAt: now };
        snapshot.memoryAssistant.candidates.push(candidate);
        if (policy.mode === 'automatic' && policy.automaticTypes.includes(candidate.type) && !candidate.conflicts.length && sourceText.trim() === candidate.content && isAutomaticMemorySafe(candidate)) saved.push(applyCandidate(snapshot, candidate));
        captured.push(clone(candidate));
      }
      if (captured.length) await persist(snapshot);
      return { snapshot: publicSnapshot(snapshot), captured, saved };
    }),
    rememberMemory: ({ scopeId, type, title, content, source }) => enqueue(async () => {
      const snapshot = await load();
      knownScope(snapshot, scopeId); validateSource(source);
      if (source.scopeId !== scopeId) throw failure('La fonte appartiene a un altro ambito.');
      const fields = memoryFields(snapshot, { scopeId, type, title, content, status: 'confirmed', source: '', sharedWith: [], agentIds: [] });
      if (containsMemorySecret(`${fields.title}\n${fields.content}\n${source.quote}`)) throw failure('Questo contenuto sembra includere credenziali. Salvale nella connessione AI, non nella memoria.', 'MEMORY_SECRET', 400);
      const duplicate = snapshot.memories.find(item => item.scopeId === scopeId && item.status === 'confirmed' && memoryFingerprint(scopeId, item.content) === memoryFingerprint(scopeId, fields.content));
      if (duplicate) return { snapshot: publicSnapshot(snapshot), memory: clone(duplicate), actionId: null, duplicate: true };
      const result = applyCandidate(snapshot, { ...fields, source });
      await persist(snapshot);
      return { snapshot: publicSnapshot(snapshot), ...clone(result) };
    }),
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
        case 'setMemoryPolicy': {
          object(payload, 'Politica memoria', ['scopeId', 'expectedVersion', 'mode', 'learningEnabled', 'automaticTypes']);
          const previous = currentPolicy(snapshot, payload.scopeId);
          if (has(payload, 'expectedVersion') && payload.expectedVersion !== previous.version) throw failure('La politica è cambiata. Ricarica le impostazioni.', 'VERSION_CONFLICT', 409);
          const next = { scopeId: payload.scopeId, version: previous.version + 1, mode: payload.mode, learningEnabled: payload.learningEnabled, automaticTypes: payload.automaticTypes };
          snapshot.memoryAssistant.policies = snapshot.memoryAssistant.policies.filter(item => item.scopeId !== payload.scopeId).concat(next);
          break;
        }
        case 'reviewMemoryCandidate': {
          object(payload, 'Revisione proposta', ['id', 'expectedVersion', 'decision', 'title', 'content', 'type', 'replaceMemoryId', 'replaceExpectedVersion', 'keepBoth']);
          const candidate = snapshot.memoryAssistant.candidates.find(item => item.id === identifier(payload.id));
          if (!candidate) throw failure('Proposta non trovata.', 'NOT_FOUND', 404);
          if (candidate.version !== payload.expectedVersion || candidate.status !== 'pending') throw failure('La proposta è già stata modificata o gestita.', 'VERSION_CONFLICT', 409);
          choice(payload.decision, ['approve', 'reject'], 'Decisione proposta');
          if (payload.decision === 'reject') {
            suppress(snapshot, { scopeId: candidate.scopeId, content: candidate.content, source: candidate.source });
            candidate.status = 'rejected';
          } else {
            candidate.title = has(payload, 'title') ? string(payload.title, 'Titolo', 160) : candidate.title;
            candidate.content = has(payload, 'content') ? string(payload.content, 'Contenuto', 8000) : candidate.content;
            candidate.type = has(payload, 'type') ? choice(payload.type, ['fact', 'preference', 'decision', 'pattern'], 'Tipo memoria') : candidate.type;
            const conflicts = conflictsFor(snapshot, candidate);
            if (conflicts.length && !payload.replaceMemoryId && payload.keepBoth !== true) throw failure('Confronta la memoria esistente: scegli se sostituirla o mantenerle entrambe.', 'MEMORY_CONFLICT', 409);
            if (has(payload, 'keepBoth') && typeof payload.keepBoth !== 'boolean') throw failure('Scelta conflitto non valida.');
            applyCandidate(snapshot, candidate, payload);
          }
          candidate.version++; candidate.updatedAt = new Date().toISOString();
          break;
        }
        case 'undoMemoryAction': {
          object(payload, 'Annulla memoria', ['id']);
          const action = snapshot.memoryAssistant.actions.find(item => item.id === identifier(payload.id));
          if (!action) throw failure('Azione non trovata.', 'NOT_FOUND', 404);
          const memory = snapshot.memories.find(item => item.id === action.memoryId);
          if (action.undoneAt || !memory || memory.version !== action.memoryVersion) throw failure('La memoria è cambiata dopo il salvataggio. Puoi modificarla dal suo pannello.', 'VERSION_CONFLICT', 409);
          suppress(snapshot, { scopeId: memory.scopeId, content: memory.content, source: action.source });
          if (action.kind === 'create') forgetMemory(snapshot, memory);
          else {
            const previous = action.previous;
            saveRecord(snapshot, 'memories', { id: memory.id, expectedVersion: memory.version, ...Object.fromEntries(MEMORY_FIELDS.map(field => [field, previous[field]])) }, MEMORY_FIELDS, memoryFields);
            action.undoneAt = new Date().toISOString();
            for (const candidate of snapshot.memoryAssistant.candidates.filter(item => item.actionId === action.id)) { candidate.status = 'rejected'; candidate.version++; candidate.updatedAt = action.undoneAt; }
          }
          break;
        }
        case 'deleteMemory':
        case 'deleteWorkflow': {
          object(payload, 'Eliminazione', ['id', 'expectedVersion']);
          const collection = action === 'deleteMemory' ? 'memories' : 'workflows';
          const id = identifier(payload.id);
          const index = snapshot[collection].findIndex(record => record.id === id);
          if (index < 0) throw failure('Record non trovato.', 'NOT_FOUND', 404);
          if (has(payload, 'expectedVersion') && payload.expectedVersion !== snapshot[collection][index].version) throw failure('Il record è cambiato. Ricarica prima di eliminarlo.', 'VERSION_CONFLICT', 409);
          if (collection === 'memories') forgetMemory(snapshot, snapshot[collection][index]);
          else { tombstone(snapshot, collection, snapshot[collection][index]); snapshot[collection].splice(index, 1); }
          break;
        }
        default: throw failure('Azione non riconosciuta.');
      }
      await persist(snapshot);
      return publicSnapshot(snapshot);
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
    }).then(context => augmentContextSources(context, query)),
  };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const workspaceStore = createWorkspaceStore({ directory: process.env.FUORI_STUDIO_DATA_DIR || resolve(root, '.local'), storage: defaultArchive });
export default workspaceStore;
