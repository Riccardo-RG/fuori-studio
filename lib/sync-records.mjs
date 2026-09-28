import { createHash } from 'node:crypto';

const stable = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  : value;
export function syncRecord(record) {
  if (record === null || record === undefined) return null;
  const { version, createdAt, updatedAt, revisions, ...fields } = record;
  return { ...fields, sharedWith: [] };
}
// Grants and local revision counters do not travel between installations.
export const recordHash = record => record == null ? null : createHash('sha256').update(JSON.stringify(stable(syncRecord(record)))).digest('hex');
export const recordKey = (collection, record) => `${collection}/${record.scopeId}/${record.id}`;
export function flatten(snapshot) {
  return Object.fromEntries(['memories', 'workflows'].flatMap(collection => (snapshot[collection] || []).map(record => [recordKey(collection, record), syncRecord(record)])));
}
export function parseKey(key) {
  if (typeof key !== 'string' || !/^(memories|workflows)\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_-]{1,100}$/.test(key)) throw Object.assign(Error('Record sincronizzazione non valido.'), { statusCode: 400 });
  const [collection, scopeId, id] = key.split('/'); return { collection, scopeId, id };
}
