import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = '__Host-fuori_session';
const FLOW_COOKIE = '__Host-fuori_login';
const SESSION_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 60 * 60 * 1000;
const FLOW_MS = 10 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const safeName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Proprietario' : 'Proprietario';
const seed = () => ({ version: 1, generation: 0, sessions: [], flows: [] });

function cookie(req, name) {
  const matches = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  // Ambiguous cookies must not select a more privileged session.
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return TOKEN.test(value) ? value : null;
}

function setCookie(res, name, value, seconds) {
  const header = `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(current) ? current : current ? [current] : []), header]);
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('Invia un comando JSON.', 415);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024) throw fail('Richiesta troppo lunga.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { throw fail('Comando non valido.'); }
}

function httpsUrl(value, label, originOnly = false) {
  let url;
  try { url = new URL(value); } catch { throw fail(`${label}: configura un URL HTTPS valido.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== '/')) throw fail(`${label}: usa HTTPS senza credenziali, query o frammenti${originOnly ? ' e senza un percorso' : ''}.`);
  return url;
}

function validateState(value) {
  const finite = number => Number.isFinite(number) && number >= 0;
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 0 || !Array.isArray(value.sessions) || !Array.isArray(value.flows) || value.sessions.length > 20 || value.flows.length > 128) throw fail('Archivio delle sessioni non valido.', 503);
  const ids = new Set();
  for (const item of value.sessions) {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || !HASH.test(item.tokenHash) || !HASH.test(item.principal) || !TOKEN.test(item.csrfToken) || typeof item.name !== 'string' || item.name.length > 80 || !finite(item.createdAt) || !finite(item.lastSeenAt) || !finite(item.expiresAt) || item.expiresAt <= item.createdAt || item.lastSeenAt < item.createdAt || item.lastSeenAt > item.expiresAt) throw fail('Archivio delle sessioni non valido.', 503);
    ids.add(item.id);
  }
  const flows = new Set();
  for (const item of value.flows) {
    if (!item || !HASH.test(item.tokenHash) || flows.has(item.tokenHash) || !HASH.test(item.principal) || !TOKEN.test(item.state) || !TOKEN.test(item.nonce) || !TOKEN.test(item.verifier) || !finite(item.expiresAt) || !Number.isSafeInteger(item.generation) || item.generation < 0) throw fail('Archivio degli accessi non valido.', 503);
    flows.add(item.tokenHash);
  }
  return value;
}

/**
 * One studio has one explicitly configured owner. OIDC proves that owner's
 * identity; provider credentials and paired execution devices are independent.
 * storage.read/write must provide confidential, atomic durable records.
 */
export function createIdentity({
  mode = process.env.FUORI_STUDIO_MODE || 'local',
  publicUrl = process.env.FUORI_STUDIO_PUBLIC_URL,
  issuer = process.env.FUORI_STUDIO_OIDC_ISSUER,
  clientId = process.env.FUORI_STUDIO_OIDC_CLIENT_ID,
  clientSecret = process.env.FUORI_STUDIO_OIDC_CLIENT_SECRET,
  ownerSubject = process.env.FUORI_STUDIO_OWNER_SUBJECT,
  clientAuthMethod = process.env.FUORI_STUDIO_OIDC_CLIENT_AUTH || 'client_secret_basic',
  storage,
  oidc,
  now = Date.now,
} = {}) {
  if (!['local', 'hybrid', 'online'].includes(mode)) throw fail('FUORI_STUDIO_MODE deve essere local, hybrid oppure online.');
  const authRequired = mode !== 'local';
  let base, authority, principal;
  if (authRequired) {
    base = httpsUrl(publicUrl, 'FUORI_STUDIO_PUBLIC_URL', true);
    authority = httpsUrl(issuer, 'FUORI_STUDIO_OIDC_ISSUER');
    if (authority.pathname.includes('/.well-known/')) throw fail('Configura l’issuer OIDC, non l’URL del documento di discovery.');
    if (typeof clientId !== 'string' || !clientId.trim() || typeof clientSecret !== 'string' || !clientSecret.trim() || typeof ownerSubject !== 'string' || !ownerSubject.trim()) throw fail('Configura client ID, client secret e subject esatto del proprietario prima di attivare l’accesso remoto.');
    if (!['client_secret_basic', 'client_secret_post'].includes(clientAuthMethod)) throw fail('Metodo di autenticazione OIDC non supportato.');
    if (!storage || typeof storage.read !== 'function' || typeof storage.write !== 'function') throw fail('L’accesso remoto richiede un archivio cifrato persistente.');
    principal = digest(JSON.stringify([authority.href, clientId, ownerSubject]));
  }
  let state = seed(), loading, configuration, discovering, client = oidc, queue = Promise.resolve();
  const attempts = new Map();

  async function init() {
    if (!authRequired) return;
    if (!loading) loading = (async () => {
      state = validateState(await storage.read('identity', seed()));
      client ||= await import('openid-client');
    })();
    await loading;
  }

  async function change(callback) {
    await init();
    const operation = queue.then(async () => {
      const draft = structuredClone(state);
      const result = callback(draft);
      validateState(draft);
      await storage.write('identity', draft);
      state = draft;
      return result;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  function prune(draft) {
    const time = now();
    draft.sessions = draft.sessions.filter(item => item.principal === principal && item.expiresAt > time && item.lastSeenAt + IDLE_MS > time);
    draft.flows = draft.flows.filter(item => item.principal === principal && item.expiresAt > time);
  }

  async function config() {
    await init();
    if (configuration) return configuration;
    if (!discovering) discovering = (async () => {
      const auth = clientAuthMethod === 'client_secret_basic' ? client.ClientSecretBasic(clientSecret) : client.ClientSecretPost(clientSecret);
      const result = await client.discovery(authority, clientId, { client_secret: clientSecret }, auth, { timeout: 10 });
      const metadata = result.serverMetadata();
      // Never discover from an untrusted callback URL or silently accept another issuer.
      if (metadata.issuer !== issuer && metadata.issuer !== authority.href) throw fail('Il provider di identità non corrisponde all’issuer configurato.', 503);
      for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) httpsUrl(metadata[field], `OIDC ${field}`);
      client.enableNonRepudiationChecks(result);
      configuration = result;
      return result;
    })();
    try { return await discovering; }
    catch { throw fail('Il provider di accesso non è disponibile. Riprova tra poco.', 503); }
    finally { discovering = null; }
  }

  function takeLoginAttempt(req) {
    const time = now(), key = req.socket?.remoteAddress || 'unknown';
    for (const [address, entry] of attempts) if (entry.until <= time) attempts.delete(address);
    const entry = attempts.get(key) || { count: 0, until: time + 15 * 60 * 1000 };
    if (entry.count >= 10 || (!attempts.has(key) && attempts.size >= 1000)) throw fail('Troppi tentativi di accesso. Attendi alcuni minuti.', 429);
    entry.count += 1; attempts.set(key, entry);
  }

  function requestUrl(url) {
    const value = url instanceof URL ? url : new URL(url, base);
    if (value.origin !== base.origin || value.username || value.password || value.hash) throw fail('URL di accesso non valido.', 403);
    return value;
  }

  function validSession(item) {
    return item && item.principal === principal && item.expiresAt > now() && item.lastSeenAt + IDLE_MS > now();
  }

  async function getSession(req) {
    if (!authRequired) return { id: 'local', name: 'Proprietario locale', role: 'owner', local: true, csrfToken: null };
    await init(); await queue;
    const token = cookie(req, SESSION_COOKIE);
    if (!token) return null;
    const tokenHash = digest(token);
    let record = state.sessions.find(item => item.tokenHash === tokenHash);
    if (!validSession(record)) return null;
    if (record.lastSeenAt + 5 * 60 * 1000 <= now()) {
      record = await change(draft => {
        const found = draft.sessions.find(item => item.tokenHash === tokenHash);
        if (!validSession(found)) return null;
        found.lastSeenAt = now();
        return found;
      });
      if (!record) return null;
    }
    return { id: record.id, name: record.name, role: 'owner', local: false, csrfToken: record.csrfToken, createdAt: record.createdAt, lastSeenAt: record.lastSeenAt, expiresAt: record.expiresAt };
  }

  async function getPublicStatus(req) {
    const session = await getSession(req);
    return {
      mode, authRequired, authenticated: Boolean(session),
      user: session ? { name: session.name, role: 'owner' } : null,
      csrfToken: session?.csrfToken || null,
      loginUrl: authRequired ? '/auth/login' : null,
      session: session && !session.local ? { id: session.id, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt } : null,
      capabilities: { singleOwner: true, oidc: authRequired },
    };
  }

  function authorizeMutation(req, session) {
    if (!session) throw fail('Accedi per continuare.', 401);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('Origine non consentita.', 403);
    if (!authRequired) {
      if (req.headers['x-fuori-studio'] !== 'local') throw fail('Richiesta locale non consentita.', 403);
      return;
    }
    if (req.headers.origin !== base.origin || !equal(req.headers['x-csrf-token'], session.csrfToken)) throw fail('Sessione della pagina scaduta. Ricarica prima di continuare.', 403);
  }

  async function handle(req, res, url) {
    const pathname = (url instanceof URL ? url : new URL(url, base || 'http://localhost')).pathname;
    if (!pathname.startsWith('/auth/')) return false;
    try {
      if (!authRequired) { json(res, 404, { error: 'Lo studio locale non richiede un account online.' }); return true; }
      const currentUrl = requestUrl(url);
      await init();
      if (pathname === '/auth/login' && req.method === 'GET') {
        if (currentUrl.search) throw fail('Parametri di accesso non validi.');
        if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== base.origin)) throw fail('Avvia l’accesso dalla pagina dello studio.', 403);
        takeLoginAttempt(req);
        const configuration = await config();
        const flowToken = secret(), flow = { tokenHash: digest(flowToken), principal, state: secret(), nonce: secret(), verifier: secret(), expiresAt: now() + FLOW_MS, generation: state.generation };
        const redirect = client.buildAuthorizationUrl(configuration, {
          redirect_uri: new URL('/auth/callback', base).href,
          scope: 'openid profile', response_type: 'code', response_mode: 'query',
          code_challenge: await client.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: 'S256',
          state: flow.state, nonce: flow.nonce,
        });
        const previousFlow = cookie(req, FLOW_COOKIE);
        await change(draft => {
          prune(draft);
          flow.generation = draft.generation;
          if (previousFlow) draft.flows = draft.flows.filter(item => item.tokenHash !== digest(previousFlow));
          if (draft.flows.length >= 128) throw fail('Accesso temporaneamente occupato. Riprova tra poco.', 429);
          draft.flows.push(flow);
        });
        setCookie(res, FLOW_COOKIE, flowToken, FLOW_MS / 1000);
        res.writeHead(303, { Location: redirect.href, 'Cache-Control': 'no-store' }); res.end();
        return true;
      }
      if (pathname === '/auth/callback' && req.method === 'GET') {
        const flowToken = cookie(req, FLOW_COOKIE);
        setCookie(res, FLOW_COOKIE, '', 0);
        if (!flowToken) throw fail('Accesso scaduto. Avvia nuovamente l’accesso.', 401);
        // Consume before exchanging the code. A failed callback cannot be replayed.
        const flow = await change(draft => {
          const item = draft.flows.find(value => value.tokenHash === digest(flowToken));
          draft.flows = draft.flows.filter(value => value.tokenHash !== digest(flowToken));
          prune(draft);
          return item;
        });
        if (!flow || flow.principal !== principal || flow.expiresAt <= now() || currentUrl.searchParams.getAll('state').length !== 1 || !equal(currentUrl.searchParams.get('state'), flow.state)) throw fail('Accesso non valido o scaduto. Avvia nuovamente l’accesso.', 401);
        let claims;
        try {
          const tokens = await client.authorizationCodeGrant(await config(), currentUrl, {
            pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true,
          });
          claims = tokens.claims();
        } catch { throw fail('Il provider non ha confermato l’accesso. Avvia nuovamente l’accesso.', 401); }
        if (!claims || (claims.iss !== issuer && claims.iss !== authority.href) || !equal(claims.sub, ownerSubject)) throw fail('Questo account non è autorizzato ad accedere allo studio.', 403);
        const token = secret(), time = now();
        const session = { id: randomUUID(), tokenHash: digest(token), principal, name: safeName(claims.name), csrfToken: secret(), createdAt: time, lastSeenAt: time, expiresAt: time + SESSION_MS };
        const priorSession = cookie(req, SESSION_COOKIE);
        await change(draft => {
          prune(draft);
          if (flow.generation !== draft.generation) throw fail('L’accesso è stato revocato. Avvia nuovamente l’accesso.', 401);
          if (priorSession) draft.sessions = draft.sessions.filter(item => item.tokenHash !== digest(priorSession));
          draft.sessions.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
          if (draft.sessions.length >= 20) draft.sessions.shift();
          draft.sessions.push(session);
        });
        setCookie(res, SESSION_COOKIE, token, SESSION_MS / 1000);
        res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }); res.end();
        return true;
      }
      const session = await getSession(req);
      if (!session) throw fail('Accedi per continuare.', 401);
      if (pathname === '/auth/sessions' && req.method === 'GET') {
        const sessions = state.sessions.filter(validSession).map(item => ({ id: item.id, name: item.name, createdAt: item.createdAt, lastSeenAt: item.lastSeenAt, expiresAt: item.expiresAt, current: item.id === session.id }));
        json(res, 200, { sessions }); return true;
      }
      if (req.method !== 'POST' || !['/auth/logout', '/auth/sessions/revoke'].includes(pathname)) { json(res, 404, { error: 'Comando di accesso non trovato.' }); return true; }
      authorizeMutation(req, session);
      const payload = await readBody(req);
      let revoke;
      if (pathname === '/auth/logout') {
        if (Object.keys(payload).length) throw fail('Comando di uscita non valido.');
        revoke = item => item.id === session.id;
      } else {
        const keys = Object.keys(payload);
        if (keys.length !== 1 || !['id', 'all', 'others'].includes(keys[0])) throw fail('Scegli la sessione da revocare.');
        if (keys[0] === 'id') {
          if (typeof payload.id !== 'string' || !state.sessions.some(item => item.id === payload.id && validSession(item))) throw fail('Sessione non trovata.', 404);
          revoke = item => item.id === payload.id;
        } else {
          if (payload[keys[0]] !== true) throw fail('Comando di revoca non valido.');
          revoke = keys[0] === 'all' ? () => true : item => item.id !== session.id;
        }
      }
      const clearsCurrent = revoke({ id: session.id });
      await change(draft => {
        prune(draft);
        draft.sessions = draft.sessions.filter(item => !revoke(item));
        // Revoking all sessions also invalidates unfinished logins.
        if (payload.all) { draft.flows = []; draft.generation += 1; }
      });
      if (clearsCurrent) setCookie(res, SESSION_COOKIE, '', 0);
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, error.statusCode || 503, { error: error.statusCode ? error.message : 'Accesso temporaneamente non disponibile.' });
    }
    return true;
  }

  return { mode, authRequired, publicOrigin: base?.origin || null, init, getSession, getPublicStatus, authorizeMutation, handle };
}
