import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { containsMemorySecret } from './memory-assistant.mjs';
import { validateWorkflowFields, validateWorkflowTemplates } from './workflow-inputs.mjs';

const derive = promisify(scrypt);
const FORMAT = 'fuori-studio-memory', ENCRYPTED = `${FORMAT}-encrypted`;
const MAX_PLAIN = 8 * 1024 * 1024, MAX_ENCRYPTED = 12 * 1024 * 1024, TTL = 15 * 60 * 1000;
const AAD = Buffer.from(`${FORMAT}:1:scrypt:32768:8:1`);
const AGENTS = ['nova', 'radar', 'forge', 'muse', 'growth'];
const MEMORY_FIELDS = ['id', 'scopeId', 'type', 'title', 'content', 'status', 'source', 'sharedWith', 'agentIds'];
const WORKFLOW_FIELDS = ['id', 'scopeId', 'title', 'description', 'input', 'steps', 'output', 'sharedWith', 'status', 'source', 'inputFields'];
const fail = (message, code = 'INVALID_IMPORT', status = 400) => Object.assign(Error(message), { code, status, statusCode: status });
const clone = value => structuredClone(value);
function object(value, fields, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !optional.includes(key) && !Object.hasOwn(value, key))) throw fail('Struttura del file di memoria non valida.');
  return value;
}
function text(value, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) throw fail('Il file contiene un testo mancante o troppo lungo.');
  return value;
}
function id(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw fail('Identificativo nel file non valido.'); return value; }
function list(value, max) { if (!Array.isArray(value) || value.length > max) throw fail('Il file contiene troppi elementi.'); return value; }
function validateManifest(manifest) {
  object(manifest, ['format', 'version', 'exportedAt', 'scopes', 'memories', 'workflows']);
  if (manifest.format !== FORMAT || manifest.version !== 1 || typeof manifest.exportedAt !== 'string' || manifest.exportedAt.length > 32 || !/^\d{4}-\d\d-\d\dT/.test(manifest.exportedAt) || !Number.isFinite(Date.parse(manifest.exportedAt))) throw fail('Formato o versione del file non supportati.');
  const scopes = new Set();
  for (const scope of list(manifest.scopes, 200)) {
    object(scope, ['id', 'name']); id(scope.id); text(scope.name, 100);
    if (scopes.has(scope.id)) throw fail('Ambiti duplicati nel file.'); scopes.add(scope.id);
  }
  for (const [collection, fields, max] of [['memories', MEMORY_FIELDS, 2000], ['workflows', WORKFLOW_FIELDS, 300]]) {
    const ids = new Set();
    for (const record of list(manifest[collection], max)) {
      object(record, fields, collection === 'workflows' ? ['inputFields'] : []); id(record.id); id(record.scopeId);
      if (ids.has(record.id) || !scopes.has(record.scopeId)) throw fail('Record duplicato o ambito non dichiarato nel file.'); ids.add(record.id);
      text(record.title, 160); text(record.source, 1000, true);
      if (list(record.sharedWith, 0).length) throw fail('I permessi di condivisione non sono portabili.');
      if (collection === 'memories') {
        if (!['fact', 'preference', 'decision', 'pattern'].includes(record.type) || record.status !== 'confirmed') throw fail('La memoria esportata non è confermata o ha un tipo non valido.');
        text(record.content, 8000);
        list(record.agentIds, 5);
        if (new Set(record.agentIds).size !== record.agentIds.length || record.agentIds.some(agent => !AGENTS.includes(agent))) throw fail('Permessi degli agenti non validi.');
      } else {
        if (record.status !== 'ready') throw fail('La procedura esportata non è pronta.');
        text(record.description, 4000, true); text(record.input, 4000, true); text(record.output, 4000);
        if (!list(record.steps, 12).length) throw fail('La procedura non contiene passaggi.');
        for (const step of record.steps) { object(step, ['title', 'agentId', 'output']); text(step.title, 160); text(step.output, 2000); if (!AGENTS.includes(step.agentId)) throw fail('Agente della procedura non valido.'); }
        if (Object.hasOwn(record, 'inputFields')) validateWorkflowFields(record.inputFields);
        validateWorkflowTemplates(record);
      }
      if (containsMemorySecret(JSON.stringify(record))) throw fail('Il file contiene possibili credenziali. Rimuovile prima di importare.', 'MEMORY_SECRET');
    }
  }
  return manifest;
}
function passphrase(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024 || value.includes('\0') || !value.trim()) throw fail('Scegli una passphrase di almeno 12 caratteri (massimo 1.024).', 'INVALID_PASSPHRASE');
  return value;
}
function base64(value, bytes, max = bytes) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fail('File cifrato non valido.');
  const result = Buffer.from(value, 'base64');
  if ((bytes !== null && result.length !== bytes) || result.length > max || result.toString('base64') !== value) throw fail('File cifrato non valido.');
  return result;
}
async function keyFor(password, salt) { return derive(passphrase(password), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
async function encrypt(plaintext, password) {
  const salt = randomBytes(16), iv = randomBytes(12), key = await keyFor(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return JSON.stringify({ format: ENCRYPTED, version: 1, kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: salt.toString('base64') }, cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }, ciphertext: ciphertext.toString('base64') }, null, 2);
  } finally { key.fill(0); }
}
async function decode(content, password) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_ENCRYPTED) throw fail('Il file supera il limite di 12 MiB.', 'IMPORT_TOO_LARGE', 413);
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw fail('Importa un file .fs-memory cifrato oppure un’esportazione JSON valida. Markdown è solo per la lettura.'); }
  if (parsed?.format !== ENCRYPTED) {
    if (Buffer.byteLength(content, 'utf8') > MAX_PLAIN) throw fail('Il file JSON supera il limite di 8 MiB.', 'IMPORT_TOO_LARGE', 413);
    return validateManifest(parsed);
  }
  object(parsed, ['format', 'version', 'kdf', 'cipher', 'ciphertext']);
  object(parsed.kdf, ['name', 'N', 'r', 'p', 'salt']); object(parsed.cipher, ['name', 'iv', 'tag']);
  if (parsed.version !== 1 || parsed.kdf.name !== 'scrypt' || parsed.kdf.N !== 32768 || parsed.kdf.r !== 8 || parsed.kdf.p !== 1 || parsed.cipher.name !== 'aes-256-gcm') throw fail('Parametri di cifratura non supportati.');
  const salt = base64(parsed.kdf.salt, 16), iv = base64(parsed.cipher.iv, 12), tag = base64(parsed.cipher.tag, 16), ciphertext = base64(parsed.ciphertext, null, MAX_PLAIN);
  const key = await keyFor(password, salt);
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(AAD); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { throw fail('Passphrase errata o file modificato/danneggiato. Nessun dato è stato importato.', 'IMPORT_DECRYPTION_FAILED'); }
  finally { key.fill(0); }
  try { return validateManifest(JSON.parse(plaintext.toString('utf8'))); }
  finally { plaintext.fill(0); }
}
const plainText = value => value.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
function markdown(manifest) {
  const scopeName = id => manifest.scopes.find(scope => scope.id === id)?.name || id;
  const lines = ['# Fuori Studio — portable memory', '', `Exported: ${manifest.exportedAt}`, '', 'This readable export contains confirmed knowledge and ready procedures. It excludes AI connection and login records, conversation history, and sharing grants. It is plain text; keep it private.', ''];
  for (const note of manifest.memories) lines.push(`## ${plainText(note.title)}`, '', `Scope: ${plainText(scopeName(note.scopeId))} · Type: ${note.type}`, '', plainText(note.content), '', `Source: ${plainText(note.source) || 'Not specified'}`, `Agents: ${note.agentIds.join(', ') || 'All agents within the selected scope'}`, '');
  for (const workflow of manifest.workflows) {
    lines.push(`## Procedure: ${plainText(workflow.title)}`, '', `Scope: ${plainText(scopeName(workflow.scopeId))}`, '', plainText(workflow.description), '', `Input: ${plainText(workflow.input)}`, '');
    for (const field of workflow.inputFields || []) lines.push(`- Field ${field.key}: ${plainText(field.label)} (${field.required ? 'required' : 'optional'}); default: ${plainText(field.defaultValue) || 'None'}`);
    workflow.steps.forEach((step, index) => lines.push(`${index + 1}. ${plainText(step.title)} (${step.agentId}): ${plainText(step.output)}`));
    lines.push('', `Expected output: ${plainText(workflow.output)}`, '', `Source: ${plainText(workflow.source) || 'Not specified'}`, '');
  }
  return lines.join('\n');
}

export function createPortability({ workspace, storage, now = () => Date.now() }) {
  let queue = Promise.resolve();
  const serial = operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  async function cleanup() {
    const pending = await storage.read('portability/pending', []), active = [], expired = [];
    for (const item of pending) {
      if (item.expiresAt <= now()) expired.push({ key: `portability/import/${item.id}`, value: { status: 'expired', expiresAt: item.expiresAt } });
      else active.push(item);
    }
    if (expired.length) await storage.batch(expired.concat({ key: 'portability/pending', value: active }));
    return active;
  }
  return {
    export: payload => serial(async () => {
      if (!payload || typeof payload !== 'object' || Object.keys(payload).some(key => !['scopeIds', 'format', 'passphrase'].includes(key))) throw fail('Parametri esportazione non validi.');
      const { scopeIds, format = 'encrypted' } = payload;
      if (!['encrypted', 'json', 'markdown'].includes(format)) throw fail('Formato esportazione non valido.');
      list(scopeIds, 200); scopeIds.forEach(id);
      if (!scopeIds.length || new Set(scopeIds).size !== scopeIds.length) throw fail('Scegli almeno un ambito, senza duplicati.');
      const snapshot = await workspace.getSnapshot();
      if (scopeIds.some(scopeId => !snapshot.scopes.some(scope => scope.id === scopeId))) throw fail('Ambito esportazione non trovato.');
      const allowed = new Set(scopeIds), warnings = [];
      const select = (records, status, fields) => records.filter(record => allowed.has(record.scopeId) && record.status === status).flatMap(record => {
        const selected = { ...Object.fromEntries(fields.filter(field => Object.hasOwn(record, field)).map(field => [field, clone(record[field])])), sharedWith: [] };
        if (containsMemorySecret(JSON.stringify(selected))) { warnings.push(`Record ${record.id} escluso: contiene possibili credenziali.`); return []; }
        return [selected];
      });
      const manifest = validateManifest({ format: FORMAT, version: 1, exportedAt: new Date(now()).toISOString(), scopes: snapshot.scopes.filter(scope => allowed.has(scope.id)).map(({ id, name }) => ({ id, name })), memories: select(snapshot.memories, 'confirmed', MEMORY_FIELDS), workflows: select(snapshot.workflows, 'ready', WORKFLOW_FIELDS) });
      const raw = JSON.stringify(manifest, null, 2);
      if (Buffer.byteLength(raw) > MAX_PLAIN) throw fail('Esportazione oltre 8 MiB: scegli meno ambiti.', 'EXPORT_TOO_LARGE', 413);
      const content = format === 'encrypted' ? await encrypt(raw, payload.passphrase) : format === 'markdown' ? markdown(manifest) : raw;
      if (format !== 'encrypted') warnings.unshift('Il file è in chiaro: chi lo riceve può leggere le memorie.');
      return { filename: `fuori-studio-memory-${manifest.exportedAt.slice(0, 10)}.${format === 'encrypted' ? 'fs-memory' : format === 'markdown' ? 'md' : 'json'}`, mime: format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8', content, counts: { memories: manifest.memories.length, workflows: manifest.workflows.length }, warnings };
    }),
    preview: payload => serial(async () => {
      if (!payload || typeof payload !== 'object' || Object.keys(payload).some(key => !['content', 'passphrase', 'targetScopeId'].includes(key))) throw fail('Parametri importazione non validi.');
      id(payload.targetScopeId);
      const active = await cleanup();
      if (active.length >= 20) throw fail('Hai già 20 anteprime aperte. Completa un’importazione o attendi la scadenza.', 'TOO_MANY_IMPORTS', 429);
      const manifest = await decode(payload.content, payload.passphrase);
      const records = { scopeId: payload.targetScopeId, memories: manifest.memories, workflows: manifest.workflows };
      const plan = await workspace.previewPortable(records), importId = randomUUID(), expires = now() + TTL;
      await storage.batch([
        { key: `portability/import/${importId}`, value: { status: 'pending', expiresAt: expires, records } },
        { key: 'portability/pending', value: active.concat({ id: importId, expiresAt: expires }) },
      ]);
      const warnings = ['L’importazione crea nuove memorie proposte e procedure in bozza; nessun contenuto entra nel contesto prima della revisione.', 'Le condivisioni originali non vengono importate. Le restrizioni degli agenti vengono conservate.'];
      if (plan.counts.conflicts) warnings.push('I titoli già presenti con contenuti diversi vengono saltati: nessuna memoria esistente sarà sovrascritta.');
      return { importId, expiresAt: new Date(expires).toISOString(), ...plan, warnings };
    }),
    commit: payload => serial(async () => {
      object(payload, ['importId']); id(payload.importId);
      const key = `portability/import/${payload.importId}`, pending = await storage.read(key);
      if (!pending || pending.status === 'expired' || (pending.status === 'pending' && pending.expiresAt <= now())) {
        if (pending) await storage.write(key, { status: 'expired', expiresAt: pending.expiresAt });
        throw fail('Anteprima scaduta o non trovata. Riapri il file prima di importare.', 'IMPORT_EXPIRED', 409);
      }
      if (pending.status === 'committed') return { snapshot: await workspace.getSnapshot(), ...pending.result };
      const result = await workspace.importPortable({ importId: payload.importId, ...pending.records });
      const summary = { imported: result.imported, skipped: result.skipped };
      const index = await storage.read('portability/pending', []);
      await storage.batch([
        { key, value: { status: 'committed', expiresAt: pending.expiresAt, result: summary } },
        { key: 'portability/pending', value: index.filter(item => item.id !== payload.importId) },
      ]);
      return result;
    }),
  };
}
