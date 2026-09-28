import { createHash } from 'node:crypto';
import { flatten, recordHash, parseKey, syncRecord } from './sync-records.mjs';

const fail = (message, statusCode = 400) => Object.assign(Error(message), { statusCode });
const seed = () => ({ version: 1, link: null, enabledScopeIds: [], bases: {}, conflicts: [] });
const scopesValid = ids => Array.isArray(ids) && ids.length <= 200 && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id));
const idFor = key => createHash('sha256').update(key).digest('hex');
export function trustedOrigin(value) {
  let url; try { url = new URL(value); } catch { throw fail('Indica un indirizzo HTTPS valido.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('Usa l’origine HTTPS del tuo studio, senza percorso o credenziali.');
  return url.origin;
}
export async function deviceRequest(url, path, payload, token, fetchImpl = fetch) {
  const response = await fetchImpl(trustedOrigin(url) + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) { await response.body?.cancel(); throw fail('Risposta di sincronizzazione troppo grande.', 502); }
  const reader = response.body?.getReader(); if (!reader) throw fail('Risposta dello studio non valida.', 502);
  let bytes = 0; const chunks = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 8 * 1024 * 1024) throw fail('Risposta troppo grande.', 502); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail('Risposta dello studio non valida.', 502); }
  if (!response.ok) throw fail(response.status === 401 ? 'Collegamento scaduto o revocato: associa di nuovo il dispositivo.' : 'Lo studio remoto ha rifiutato la sincronizzazione. Nessun conflitto è stato sovrascritto.', response.status);
  return data;
}

/** Three-way, record-level merge. Missing records are tombstones when a base
 * exists; conflicts are never resolved by timestamps or an AI decision. */
function tombstoneMap(items, scopeIds) {
  if (!Array.isArray(items) || items.length > 10000) throw fail('Cancellazioni sincronizzate non valide.');
  return Object.fromEntries(items.map(item => { const key = `${item.collection}/${item.scopeId}/${item.id}`; const parsed = parseKey(key); if (!scopeIds.includes(parsed.scopeId)) throw fail('Cancellazione fuori ambito.',403); return [key,item]; }));
}
export function mergeRecords(local, remote, bases, scopeIds, tombstones = {}) {
  const changes = [], conflicts = [];
  const localDeleted = tombstoneMap(tombstones.local || [], scopeIds), remoteDeleted = tombstoneMap(tombstones.remote || [], scopeIds);
  const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(bases), ...Object.keys(localDeleted), ...Object.keys(remoteDeleted)]);
  for (const key of keys) {
    const { collection, scopeId, id } = parseKey(key);
    if (!scopeIds.includes(scopeId)) throw fail('Record fuori dagli ambiti autorizzati.', 403);
    const ours = local[key] || null, theirs = remote[key] || null;
    if (ours && (ours.id !== id || ours.scopeId !== scopeId) || theirs && (theirs.id !== id || theirs.scopeId !== scopeId)) throw fail('Identità record incoerente.');
    const left = recordHash(ours), right = recordHash(theirs), base = bases[key] ?? null;
    if (base !== null && !/^[a-f0-9]{64}$/.test(base)) throw fail('Base di sincronizzazione non valida.');
    if (localDeleted[key] && ours || remoteDeleted[key] && theirs) throw fail('Cancellazione incoerente.',409);
    if (remoteDeleted[key] && ours && left !== base || localDeleted[key] && theirs && right !== base) {
      conflicts.push({key,scopeId,kind:collection === 'memories'?'memory':'workflow',title:ours?.title||theirs?.title||'Elemento eliminato',local:ours,remote:theirs,localDeleted:!!localDeleted[key],remoteDeleted:!!remoteDeleted[key]}); continue;
    }
    if (localDeleted[key] && !theirs && !remoteDeleted[key]) { changes.push({collection,id,scopeId,record:null,expectedHash:null}); continue; }
    if (left === right || left === base) continue;
    if (right === base) changes.push({ collection, id, record: ours, scopeId, expectedHash: right });
    else conflicts.push({ key, scopeId, kind: collection === 'memories' ? 'memory' : 'workflow', title: ours?.title || theirs?.title || 'Elemento eliminato', local: ours, remote: theirs });
  }
  return { changes, conflicts };
}

export function createSyncService({ storage, workspace, devices, fetchImpl = fetch } = {}) {
  let running = false;
  async function snapshot() {
    const state = await storage.read('sync', seed());
    return { link: state.link ? { url: state.link.url, deviceId: state.link.deviceId, name: state.link.name, lastSyncAt: state.link.lastSyncAt || null, error: state.link.error || null, scopeIds: state.link.scopeIds, expiresAt: state.link.expiresAt } : null, enabledScopeIds: state.enabledScopeIds, conflicts: state.conflicts, running };
  }
  async function exchange(rawToken, payload) {
    const device = await devices.authenticate(rawToken, 'sync');
    const { scopeIds, records, bases, scopes, tombstones = [] } = payload;
    if (!scopesValid(scopeIds) || scopeIds.some(id => !device.scopeIds.includes(id)) || !records || typeof records !== 'object' || Array.isArray(records) || !bases || typeof bases !== 'object' || Array.isArray(bases) || Object.keys(records).length > 2300 || Object.keys(bases).length > 5000 || !Array.isArray(scopes) || scopes.length > 200) throw fail('Ambiti o record non autorizzati.', 403);
    const before = await workspace.exportSync(scopeIds), remote = flatten(before);
    const merged = mergeRecords(records, remote, bases, scopeIds, {local:tombstones,remote:before.tombstones || []});
    await workspace.applySync({ scopeIds, scopes, changes: merged.changes });
    const after = await workspace.exportSync(scopeIds);
    return { version: 1, scopes: after.scopes, records: flatten(after), tombstones: after.tombstones || [], conflicts: merged.conflicts.map(item => item.key) };
  }
  async function run() {
    if (running) throw fail('Sincronizzazione già in corso.', 409);
    running = true;
    try {
      const state = await storage.read('sync', seed());
      if (!state.link) throw fail('Collega prima uno studio online.');
      const scopeIds = state.enabledScopeIds;
      if (!scopeIds.length) return snapshot();
      const before = await workspace.exportSync(scopeIds), records = flatten(before);
      const bases = Object.fromEntries(Object.entries(state.bases).filter(([key]) => scopeIds.includes(parseKey(key).scopeId)));
      const response = await deviceRequest(state.link.url, '/api/device/sync', { scopeIds, scopes: before.scopes, records, bases, tombstones:before.tombstones || [] }, state.link.token, fetchImpl);
      if (response.version !== 1 || !response.records || typeof response.records !== 'object' || Array.isArray(response.records) || !Array.isArray(response.scopes) || !Array.isArray(response.conflicts)) throw fail('Protocollo di sincronizzazione incompatibile.', 502);
      const remote = response.records;
      const remoteDeleted = tombstoneMap(response.tombstones || [],scopeIds);
      // Recheck the local version after network latency. applySync performs the
      // same comparison inside the store transaction, protecting concurrent edits.
      const currentSnapshot = await workspace.exportSync(scopeIds);
      const current = flatten(currentSnapshot), localDeleted = tombstoneMap(currentSnapshot.tombstones || [],scopeIds);
      const changes = [], conflicts = [];
      for (const key of new Set([...Object.keys(records), ...Object.keys(remote), ...Object.keys(bases), ...Object.keys(remoteDeleted)])) {
        const { collection, scopeId, id } = parseKey(key);
        if (!scopeIds.includes(scopeId)) throw fail('Lo studio remoto ha restituito dati fuori ambito.', 502);
        const ours = current[key] || null, theirs = remote[key] || null;
        if (theirs && (theirs.id !== id || theirs.scopeId !== scopeId)) throw fail('Record remoto incoerente.', 502);
        const left = recordHash(ours), right = recordHash(theirs);
        if (response.conflicts.includes(key) || left !== recordHash(records[key]) && left !== right) {
          const old = state.conflicts.find(item => item.key === key);
          const unchanged = old && recordHash(old.local) === left && recordHash(old.remote) === right && Boolean(old.localDeleted) === Boolean(localDeleted[key]) && Boolean(old.remoteDeleted) === Boolean(remoteDeleted[key]);
          conflicts.push({ id: idFor(key), version: unchanged ? old.version : (old?.version || 0) + 1, key, scopeId, kind: collection === 'memories' ? 'memory' : 'workflow', title: ours?.title || theirs?.title || 'Elemento eliminato', local: ours, remote: theirs, localDeleted:!!localDeleted[key],remoteDeleted:!!remoteDeleted[key] });
          continue;
        }
        if (left !== right || remoteDeleted[key] && !localDeleted[key]) changes.push({ collection, id, scopeId, record: theirs, expectedHash: left });
        state.bases[key] = right;
      }
      await workspace.applySync({ scopeIds, scopes: response.scopes, changes });
      state.conflicts = [...state.conflicts.filter(item => !scopeIds.includes(item.scopeId)), ...conflicts];
      state.link.lastSyncAt = new Date().toISOString(); state.link.error = null;
      await storage.write('sync', state);
      return {...(await snapshot()),running:false};
    } catch (error) {
      await storage.update('sync', state => { if (state.link) state.link.error = 'Sincronizzazione non completata. Verifica connessione, autorizzazioni e conflitti.'; return state; }, seed());
      throw error;
    } finally { running = false; }
  }
  return {
    snapshot, exchange, run,
    mutate: async (action, payload = {}) => {
      if (running) throw fail('Attendi il completamento della sincronizzazione.', 409);
      const state = await storage.read('sync', seed());
      if (action === 'connect') {
        if (state.link) throw fail('Scollega lo studio attuale prima di cambiarlo.', 409);
        const url = trustedOrigin(payload.url);
        const result = await deviceRequest(url, '/api/device/pair', { code: payload.code }, null, fetchImpl);
        if (typeof result.token !== 'string' || typeof result.deviceId !== 'string' || !scopesValid(result.scopeIds) || !result.capabilities?.includes('sync')) throw fail('Il codice non abilita la sincronizzazione.', 403);
        state.link = { ...result, url }; state.enabledScopeIds = []; state.bases = {}; state.conflicts = [];
      } else if (action === 'disconnect') { state.link = null; state.enabledScopeIds = []; state.bases = {}; state.conflicts = []; }
      else if (action === 'configure') {
        if (!state.link || !scopesValid(payload.scopeIds) || payload.scopeIds.some(id => !state.link.scopeIds.includes(id))) throw fail('Scegli solo ambiti autorizzati dal collegamento.');
        state.enabledScopeIds = payload.scopeIds;
      } else if (action === 'run') return run();
      else if (action === 'resolve') {
        const conflict = state.conflicts.find(item => item.id === payload.id);
        if (!conflict || conflict.version !== payload.expectedVersion || !['local', 'remote'].includes(payload.choice) || !state.enabledScopeIds.includes(conflict.scopeId)) throw fail('Il conflitto è cambiato. Sincronizza e controlla di nuovo.', 409);
        const current = flatten(await workspace.exportSync([conflict.scopeId]));
        if (recordHash(current[conflict.key]) !== recordHash(conflict.local)) throw fail('L’elemento locale è cambiato. Sincronizza di nuovo.', 409);
        const { collection, id, scopeId } = parseKey(conflict.key);
        if (payload.choice === 'remote' && conflict.localDeleted && conflict.remote || payload.choice === 'local' && conflict.remoteDeleted && conflict.local) throw fail('Un elemento eliminato non può riapparire con lo stesso ID. Copia il testo utile in una nuova proposta e conferma la cancellazione.',409);
        if (payload.choice === 'remote') await workspace.applySync({ scopeIds: [scopeId], scopes: [], changes: [{ collection, id, scopeId, record: syncRecord(conflict.remote), expectedHash: recordHash(conflict.local) }] });
        state.bases[conflict.key] = recordHash(conflict.remote);
        state.conflicts = state.conflicts.filter(item => item !== conflict);
      } else throw fail('Azione sincronizzazione non valida.');
      await storage.write('sync', state);
      return snapshot();
    },
  };
}
