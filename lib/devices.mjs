import { createHash, randomBytes, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const fail = (message, code = 'DEVICE_INVALID', status = 400) => Object.assign(Error(message), { code, status, statusCode: status });
const seed = () => ({ version: 1, devices: [], pairings: [], jobs: [], target: 'local' });
const validScopes = ids => Array.isArray(ids) && ids.length > 0 && ids.length <= 200 && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id));
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const usageCounts = usage => ({ inputTokens: tokenCount(usage?.inputTokens), outputTokens: tokenCount(usage?.outputTokens) });

// A paired device can only claim explicitly addressed work. There is no fallback,
// retry or reassignment after a lease expires: inference may already have run.
export function createDeviceHub({ storage, now = Date.now, publicUrl = null, allowLocalExecution = true } = {}) {
  const update = fn => storage.update('devices', state => { expire(state); fn(state); return state; }, seed());
  function expire(state) {
    state.pairings = state.pairings.filter(item => item.expiresAt > now());
    for (const job of state.jobs) if (['queued', 'leased'].includes(job.status) && (job.expiresAt <= now() || job.status === 'leased' && job.leaseExpiresAt <= now())) { job.status = 'failed'; job.error = 'Il dispositivo non ha completato la richiesta. Riavvia esplicitamente dopo aver verificato il risultato.'; delete job.prompt; }
    state.jobs = state.jobs.filter(job => job.expiresAt > now() - 86400000).slice(-100);
  }
  function device(state, rawToken, capability) {
    if (typeof rawToken !== 'string' || rawToken.length > 200) throw fail('Credenziale dispositivo non valida.', 'DEVICE_UNAUTHORIZED', 401);
    const item = state.devices.find(item => item.tokenHash === hash(rawToken) && !item.revokedAt && item.expiresAt > now());
    if (!item || capability && !item.capabilities.includes(capability)) throw fail('Dispositivo non autorizzato o revocato.', 'DEVICE_UNAUTHORIZED', 401);
    return item;
  }
  function assertTarget(state, scopeId) {
    if (state.target === 'local') { if (!allowLocalExecution) throw fail('Collega e seleziona un computer per Codex, oppure assegna un servizio API.', 'DEVICE_NOT_CONFIGURED', 409); return null; }
    const item = state.devices.find(item => item.id === state.target && !item.revokedAt && item.expiresAt > now() && item.capabilities.includes('execute'));
    if (!item) throw fail('Il dispositivo di esecuzione non è disponibile. Selezionalo esplicitamente.', 'DEVICE_NOT_CONFIGURED', 409);
    if (!scopeId || !item.scopeIds.includes(scopeId)) throw fail('Questo ambito non può essere inviato al dispositivo selezionato.', 'DEVICE_SCOPE_DENIED', 403);
    return item;
  }
  async function snapshot() {
    const state = await update(() => {});
    return { devices: state.devices.map(({ tokenHash, ...item }) => ({ ...item, online: !item.revokedAt && item.expiresAt > now() && !!item.lastSeenAt && item.lastSeenAt > now() - 45000 })), executionTarget: state.target };
  }
  return {
    snapshot,
    recover: () => update(state => { for (const job of state.jobs) if (['queued', 'leased'].includes(job.status)) { job.status = 'failed'; job.error = 'Server riavviato: verifica il lavoro e riavvialo esplicitamente.'; delete job.prompt; } }),
    authorize: async scopeId => { const state = await storage.read('devices', seed()); assertTarget(state, scopeId); },
    mutate: async (action, payload = {}) => {
      let result;
      await update(state => {
        if (action === 'pair') {
          if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 80 || !validScopes(payload.scopeIds) || !Array.isArray(payload.capabilities) || !payload.capabilities.length || payload.capabilities.some(x => !['execute', 'sync', 'repository'].includes(x)) || state.devices.filter(x => !x.revokedAt).length >= 20) throw fail('Scegli nome, ambiti e capacità del dispositivo.');
          const code = randomBytes(18).toString('base64url'), expiresAt = now() + 300000;
          state.pairings.push({ id: randomUUID(), codeHash: hash(code), expiresAt, name: payload.name.trim(), scopeIds: [...payload.scopeIds], capabilities: [...new Set(payload.capabilities)] });
          state.pairings = state.pairings.slice(-5); result = { code, expiresAt, serverUrl: publicUrl };
        } else if (action === 'revoke') {
          const item = state.devices.find(item => item.id === payload.id);
          if (!item) throw fail('Dispositivo non trovato.', 'DEVICE_NOT_FOUND', 404);
          item.revokedAt = now(); item.tokenHash = null;
          for (const job of state.jobs) if (job.deviceId === item.id && ['queued', 'leased'].includes(job.status)) { job.status = 'failed'; job.error = 'Dispositivo revocato.'; delete job.prompt; }
        } else if (action === 'target') {
          if (payload.id !== 'local' && !state.devices.some(item => item.id === payload.id && !item.revokedAt && item.expiresAt > now() && item.capabilities.includes('execute'))) throw fail('Dispositivo non disponibile per l’esecuzione.');
          if (payload.id === 'local' && !allowLocalExecution) throw fail('Questo server richiede un computer collegato per Codex.');
          state.target = payload.id;
        } else throw fail('Azione dispositivo non valida.');
      });
      return result || snapshot();
    },
    pair: async ({ code }) => {
      if (typeof code !== 'string' || code.length !== 24) throw fail('Codice di collegamento non valido.', 'DEVICE_UNAUTHORIZED', 401);
      let result;
      await update(state => {
        const pairing = state.pairings.find(item => item.codeHash === hash(code));
        if (!pairing) throw fail('Codice scaduto o già usato.', 'DEVICE_UNAUTHORIZED', 401);
        state.pairings = state.pairings.filter(item => item !== pairing);
        if (state.devices.filter(item => !item.revokedAt && item.expiresAt > now()).length >= 20) throw fail('Numero massimo di dispositivi raggiunto. Revoca un dispositivo.');
        const rawToken = token(), item = { id: randomUUID(), name: pairing.name, scopeIds: pairing.scopeIds, capabilities: pairing.capabilities, tokenHash: hash(rawToken), createdAt: now(), lastSeenAt: now(), expiresAt: now() + 30 * 86400000, revokedAt: null };
        state.devices.push(item); result = { token: rawToken, deviceId: item.id, name: item.name, scopeIds: item.scopeIds, capabilities: item.capabilities, expiresAt: item.expiresAt };
      });
      return result;
    },
    authenticate: async (rawToken, capability) => { const state = await storage.read('devices', seed()); const { tokenHash, ...item } = device(state, rawToken, capability); return item; },
    touch: async (rawToken, capability) => { let result; await update(state => { const item = device(state, rawToken, capability); item.lastSeenAt = now(); const { tokenHash, ...safe } = item; result = safe; }); return result; },
    claim: async rawToken => {
      let result = { job: null };
      await update(state => {
        const item = device(state, rawToken, 'execute'); item.lastSeenAt = now();
        if (state.jobs.some(job => job.deviceId === item.id && job.status === 'leased')) return;
        const job = state.jobs.find(job => job.deviceId === item.id && job.status === 'queued' && item.scopeIds.includes(job.scopeId));
        if (!job) return;
        const lease = token(); job.status = 'leased'; job.leaseHash = hash(lease); job.leaseExpiresAt = now() + 30000;
        result = { job: { id: job.id, prompt: job.prompt, schema: job.schema, scopeId: job.scopeId, lease, expiresAt: job.expiresAt } };
      });
      return result;
    },
    finish: async (rawToken, payload, heartbeat = false) => {
      await update(state => {
        const item = device(state, rawToken, 'execute');
        const job = state.jobs.find(job => job.id === payload.id && job.deviceId === item.id && job.status === 'leased');
        if (!job || typeof payload.lease !== 'string' || job.leaseHash !== hash(payload.lease)) throw fail('Esecuzione scaduta, annullata o già completata.', 'DEVICE_STALE_RESULT', 409);
        item.lastSeenAt = now();
        if (heartbeat) { job.leaseExpiresAt = Math.min(now() + 30000, job.expiresAt); return; }
        if (payload.error) { job.status = 'failed'; job.error = 'Codex sul dispositivo non ha completato la richiesta. Verifica l’accesso e riprova.'; }
        else { if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 128000) throw fail('Risposta dispositivo non valida.'); job.text = payload.text; job.usage = usageCounts(payload.usage); job.status = 'completed'; }
        delete job.prompt; delete job.leaseHash;
      });
      return { ok: true };
    },
    run: async (prompt, { schema = false, signal, scopeId, returnUsage = false } = {}) => {
      if (signal?.aborted) throw fail('Richiesta interrotta.', 'DEVICE_ABORTED', 499);
      if (typeof prompt !== 'string' || prompt.length > 120000 || typeof schema !== 'boolean' || typeof returnUsage !== 'boolean') throw fail('Richiesta dispositivo non valida.');
      let jobId;
      await update(state => {
        const target = assertTarget(state, scopeId);
        if (!target) return;
        if (state.jobs.filter(item => ['queued','leased'].includes(item.status)).length >= 10) throw fail('Troppi incarichi in attesa.', 'DEVICE_BUSY', 409);
        jobId = randomUUID(); state.jobs.push({ id: jobId, deviceId: target.id, scopeId, status: 'queued', prompt, schema, createdAt: now(), expiresAt: now() + 240000 });
      });
      if (!jobId) return null;
      try {
        while (true) {
          if (signal?.aborted) throw fail('Richiesta interrotta.', 'DEVICE_ABORTED', 499);
          const state = await update(() => {}), job = state.jobs.find(job => job.id === jobId);
          if (!job || job.status === 'failed') throw fail(job?.error || 'Esecuzione dispositivo scaduta.', 'DEVICE_FAILED', 409);
          if (job.status === 'completed') return returnUsage ? { text: job.text, usage: usageCounts(job.usage) } : job.text;
          await new Promise(resolve => { const timer = setTimeout(done, 250); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); });
        }
      } finally {
        await update(state => { const job = state.jobs.find(job => job.id === jobId); if (job) { if (['queued', 'leased'].includes(job.status)) job.status = 'cancelled'; delete job.prompt; delete job.text; delete job.usage; delete job.leaseHash; } });
      }
    },
  };
}
