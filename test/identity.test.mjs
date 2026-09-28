import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as openid from 'openid-client';
import { createIdentity } from '../lib/identity.mjs';

const origin = 'https://studio.example.com';
const issuer = 'https://identity.example.com';
const baseOptions = { mode: 'hybrid', publicUrl: origin, issuer, clientId: 'studio-client', clientSecret: 'server-only-client-secret', ownerSubject: 'owner-123' };

function request(method = 'GET', { cookies = '', body, headers = {}, address = '127.0.0.1' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.headers = { cookie: cookies, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { remoteAddress: address };
  return req;
}

function response() {
  const headers = new Map();
  return {
    statusCode: null, body: '',
    getHeader(name) { return headers.get(name.toLowerCase()); },
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    writeHead(status, values = {}) { this.statusCode = status; for (const [name, value] of Object.entries(values)) this.setHeader(name, value); },
    end(value = '') { this.body += value; },
  };
}

const cookieValue = (res, name) => res.getHeader('Set-Cookie')?.find(value => value.startsWith(`${name}=`))?.split(';')[0] || '';

function fixture(options = {}) {
  let stored, time = Date.now(), failWrite = false;
  const calls = { grants: [], configs: [], signatures: 0 };
  const storage = {
    async read(_key, fallback) { return structuredClone(stored || fallback); },
    async write(_key, value) { if (failWrite) throw Error('PRIVATE DATABASE DETAILS'); stored = structuredClone(value); },
  };
  const oidc = {
    ClientSecretBasic: value => ({ method: 'basic', value }),
    ClientSecretPost: value => ({ method: 'post', value }),
    async discovery(...args) {
      calls.configs.push(args);
      return { serverMetadata: () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }) };
    },
    enableNonRepudiationChecks() { calls.signatures += 1; },
    async calculatePKCECodeChallenge(verifier) { return `challenge-${verifier}`; },
    buildAuthorizationUrl(_config, params) { const url = new URL(`${issuer}/authorize`); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value); return url; },
    async authorizationCodeGrant(_config, url, checks) {
      calls.grants.push({ url, checks });
      if (url.searchParams.get('code') === 'failed') throw Error('server-only-client-secret PRIVATE PROVIDER DETAILS');
      return { claims: () => ({ iss: issuer, sub: url.searchParams.get('code') === 'other' ? 'other-user' : 'owner-123', name: 'Riccardo' }) };
    },
  };
  const identity = createIdentity({ ...baseOptions, storage, oidc, now: () => time, ...options });
  const call = async (path, method = 'GET', args = {}) => {
    const req = request(method, args), res = response();
    assert.equal(await identity.handle(req, res, new URL(path, origin)), true);
    return res;
  };
  const login = async (code = 'valid', args = {}) => {
    const start = await call('/auth/login', 'GET', args);
    assert.equal(start.statusCode, 303);
    const location = new URL(start.getHeader('Location'));
    const flowCookie = cookieValue(start, '__Host-fuori_login');
    const path = `/auth/callback?code=${code}&state=${location.searchParams.get('state')}`;
    const finish = await call(path, 'GET', { cookies: [flowCookie, args.cookies].filter(Boolean).join('; ') });
    return { start, finish, flowCookie, path, location, sessionCookie: cookieValue(finish, '__Host-fuori_session') };
  };
  return { identity, storage, oidc, calls, call, login, get stored() { return stored; }, setStored(value) { stored = value; }, advance(ms) { time += ms; }, failWrites() { failWrite = true; } };
}

test('local identity needs no account, discovery or archive and does not expose online login', async () => {
  const identity = createIdentity({ mode: 'local' });
  const status = await identity.getPublicStatus(request());
  assert.equal(status.authRequired, false);
  assert.equal(status.authenticated, true);
  assert.equal(status.user.role, 'owner');
  assert.equal(status.csrfToken, null);
  assert.equal(status.loginUrl, null);
  const session = await identity.getSession(request());
  assert.throws(() => identity.authorizeMutation(request('POST'), session), /Richiesta locale/);
  identity.authorizeMutation(request('POST', { headers: { 'x-fuori-studio': 'local' } }), session);
  const res = response();
  assert.equal(await identity.handle(request(), res, new URL('/auth/login', 'http://localhost')), true);
  assert.equal(res.statusCode, 404);
  assert.equal(await identity.handle(request(), response(), new URL('/api/studio', 'http://localhost')), false);
});

test('remote mode refuses incomplete, insecure and ambiguous identity configuration', () => {
  const valid = { ...baseOptions, storage: { read() {}, write() {} } };
  for (const override of [
    { mode: 'public' }, { publicUrl: 'http://studio.example.com' },
    { publicUrl: `${origin}/subpath` }, { publicUrl: `${origin}?x=1` },
    { publicUrl: 'https://user:pass@studio.example.com' },
    { issuer: 'http://identity.example.com' }, { issuer: `${issuer}/.well-known/openid-configuration` },
    { clientId: '' }, { clientSecret: '' }, { ownerSubject: '' }, { storage: null },
    { clientAuthMethod: 'none' },
  ]) assert.throws(() => createIdentity({ ...valid, ...override }));
});

test('OIDC login binds PKCE, nonce and state to a one-use browser cookie and stores no provider token', async () => {
  const f = fixture();
  assert.equal((await f.identity.getPublicStatus(request())).authenticated, false);
  const auth = await f.login();
  assert.equal(auth.finish.statusCode, 303);
  assert.equal(auth.finish.getHeader('Location'), '/');
  assert.equal(auth.location.searchParams.get('scope'), 'openid profile');
  assert.equal(auth.location.searchParams.get('response_type'), 'code');
  assert.equal(auth.location.searchParams.get('response_mode'), 'query');
  assert.equal(auth.location.searchParams.get('redirect_uri'), `${origin}/auth/callback`);
  assert.equal(auth.location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(f.calls.grants[0].checks.expectedState, auth.location.searchParams.get('state'));
  assert.equal(f.calls.grants[0].checks.expectedNonce, auth.location.searchParams.get('nonce'));
  assert.equal(`challenge-${f.calls.grants[0].checks.pkceCodeVerifier}`, auth.location.searchParams.get('code_challenge'));
  assert.equal(f.calls.grants[0].checks.idTokenExpected, true);
  assert.equal(f.calls.signatures, 1);
  for (const value of [...auth.start.getHeader('Set-Cookie'), ...auth.finish.getHeader('Set-Cookie')]) {
    assert.match(value, /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=/);
    assert.doesNotMatch(value, /Domain=/);
  }
  const status = await f.identity.getPublicStatus(request('GET', { cookies: auth.sessionCookie }));
  assert.equal(status.authenticated, true);
  assert.equal(status.user.name, 'Riccardo');
  assert.equal(status.csrfToken.length, 43);
  assert.equal(status.session.expiresAt - status.session.createdAt, 8 * 60 * 60 * 1000);
  assert.equal(f.stored.flows.length, 0);
  assert.equal(f.stored.sessions.length, 1);
  assert.equal(JSON.stringify(f.stored).includes(auth.sessionCookie.split('=')[1]), false);
  assert.equal(JSON.stringify(f.stored).includes('server-only-client-secret'), false);
  assert.equal((await f.call(auth.path, 'GET', { cookies: auth.flowCookie })).statusCode, 401);
});

test('unrelated owner subjects, missing flow cookies and state mismatches cannot claim the studio', async () => {
  const f = fixture();
  const wrongOwner = await f.login('other');
  assert.equal(wrongOwner.finish.statusCode, 403);
  assert.equal(f.stored.sessions.length, 0);
  const start = await f.call('/auth/login');
  const flowCookie = cookieValue(start, '__Host-fuori_login');
  const state = new URL(start.getHeader('Location')).searchParams.get('state');
  assert.equal((await f.call(`/auth/callback?code=valid&state=${state}`)).statusCode, 401);
  assert.equal((await f.call('/auth/callback?code=valid&state=wrong', 'GET', { cookies: flowCookie })).statusCode, 401);
  assert.equal((await f.call(`/auth/callback?code=valid&state=${state}`, 'GET', { cookies: flowCookie })).statusCode, 401);
  assert.equal(f.calls.grants.length, 1);
});

test('duplicate cookies/state and callback origins are rejected; provider errors remain private', async () => {
  const f = fixture();
  const start = await f.call('/auth/login');
  const flow = cookieValue(start, '__Host-fuori_login');
  const state = new URL(start.getHeader('Location')).searchParams.get('state');
  assert.equal((await f.call(`/auth/callback?code=valid&state=${state}`, 'GET', { cookies: `${flow}; ${flow}` })).statusCode, 401);
  assert.equal((await f.call(`/auth/callback?code=valid&state=${state}&state=${state}`, 'GET', { cookies: flow })).statusCode, 401);
  const res = response();
  await f.identity.handle(request(), res, new URL('https://evil.example/auth/login'));
  assert.equal(res.statusCode, 403);
  const denied = await f.login('failed');
  assert.equal(denied.finish.statusCode, 401);
  assert.doesNotMatch(denied.finish.body, /PRIVATE|server-only/);
});

test('session mutations require the same origin and per-session CSRF token', async () => {
  const f = fixture(), auth = await f.login();
  const session = await f.identity.getSession(request('GET', { cookies: auth.sessionCookie }));
  const good = { origin, 'x-csrf-token': session.csrfToken };
  for (const headers of [{}, { origin }, { ...good, origin: 'https://evil.example' }, { ...good, 'x-csrf-token': 'bad' }, { ...good, 'sec-fetch-site': 'cross-site' }]) {
    assert.throws(() => f.identity.authorizeMutation(request('POST', { headers }), session), { statusCode: 403 });
  }
  f.identity.authorizeMutation(request('POST', { headers: good }), session);
  assert.throws(() => f.identity.authorizeMutation(request('POST', { headers: good }), null), { statusCode: 401 });
  const forbidden = await f.call('/auth/logout', 'POST', { cookies: auth.sessionCookie, body: {} });
  assert.equal(forbidden.statusCode, 403);
  assert.ok(await f.identity.getSession(request('GET', { cookies: auth.sessionCookie })));
});

test('session listing is redacted and revocation survives process recreation', async () => {
  const f = fixture(), first = await f.login(), second = await f.login();
  const session = await f.identity.getSession(request('GET', { cookies: second.sessionCookie }));
  const listing = await f.call('/auth/sessions', 'GET', { cookies: second.sessionCookie });
  const body = JSON.parse(listing.body);
  assert.equal(body.sessions.length, 2);
  assert.equal(body.sessions.filter(item => item.current).length, 1);
  assert.doesNotMatch(listing.body, /tokenHash|csrfToken|principal|owner-123/);
  const revoked = await f.call('/auth/sessions/revoke', 'POST', { cookies: second.sessionCookie, headers: { origin, 'x-csrf-token': session.csrfToken }, body: { others: true } });
  assert.equal(revoked.statusCode, 200);
  assert.equal(await f.identity.getSession(request('GET', { cookies: first.sessionCookie })), null);
  const reopened = createIdentity({ ...baseOptions, storage: f.storage, oidc: f.oidc });
  assert.equal(await reopened.getSession(request('GET', { cookies: first.sessionCookie })), null);
  assert.ok(await reopened.getSession(request('GET', { cookies: second.sessionCookie })));
  const logout = await f.call('/auth/logout', 'POST', { cookies: second.sessionCookie, headers: { origin, 'x-csrf-token': session.csrfToken }, body: {} });
  assert.equal(logout.statusCode, 200);
  assert.match(cookieValue(logout, '__Host-fuori_session'), /^__Host-fuori_session=$/);
  assert.equal(await f.identity.getSession(request('GET', { cookies: second.sessionCookie })), null);
});

test('login rotates an existing session and owner configuration invalidates previous sessions', async () => {
  const f = fixture(), first = await f.login(), rotated = await f.login('valid', { cookies: first.sessionCookie });
  assert.equal(f.stored.sessions.length, 1);
  assert.equal(await f.identity.getSession(request('GET', { cookies: first.sessionCookie })), null);
  const newOwner = createIdentity({ ...baseOptions, ownerSubject: 'another-owner', storage: f.storage, oidc: f.oidc });
  assert.equal(await newOwner.getSession(request('GET', { cookies: rotated.sessionCookie })), null);
});

test('expired login transactions, idle sessions and absolute lifetimes fail closed', async () => {
  const f = fixture(), auth = await f.login();
  f.advance(30 * 60 * 1000);
  assert.ok(await f.identity.getSession(request('GET', { cookies: auth.sessionCookie })));
  f.advance(60 * 60 * 1000);
  assert.equal(await f.identity.getSession(request('GET', { cookies: auth.sessionCookie })), null);
  const second = await f.login();
  for (let i = 0; i < 15; i += 1) { f.advance(30 * 60 * 1000); assert.ok(await f.identity.getSession(request('GET', { cookies: second.sessionCookie }))); }
  f.advance(30 * 60 * 1000);
  assert.equal(await f.identity.getSession(request('GET', { cookies: second.sessionCookie })), null);
  const start = await f.call('/auth/login');
  f.advance(10 * 60 * 1000);
  const state = new URL(start.getHeader('Location')).searchParams.get('state');
  assert.equal((await f.call(`/auth/callback?code=valid&state=${state}`, 'GET', { cookies: cookieValue(start, '__Host-fuori_login') })).statusCode, 401);
});

test('corrupt archives and failed durable writes do not create an authenticated session', async () => {
  const broken = fixture(); broken.setStored({ version: 1, sessions: [{}], flows: [] });
  await assert.rejects(broken.identity.init(), /Archivio/);
  const f = fixture(), start = await f.call('/auth/login');
  const state = new URL(start.getHeader('Location')).searchParams.get('state');
  f.failWrites();
  const denied = await f.call(`/auth/callback?code=valid&state=${state}`, 'GET', { cookies: cookieValue(start, '__Host-fuori_login') });
  assert.equal(denied.statusCode, 503);
  assert.equal(cookieValue(denied, '__Host-fuori_session'), '');
  assert.doesNotMatch(denied.body, /PRIVATE DATABASE/);
});

test('login attempts are bounded and recover after the rate-limit window', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i += 1) assert.equal((await f.call('/auth/login')).statusCode, 303);
  assert.equal((await f.call('/auth/login')).statusCode, 429);
  f.advance(15 * 60 * 1000);
  assert.equal((await f.call('/auth/login')).statusCode, 303);
  assert.equal(f.stored.flows.length, 1);
});

test('revoking all sessions cancels even an OIDC exchange already in flight', async () => {
  const f = fixture(), active = await f.login();
  const session = await f.identity.getSession(request('GET', { cookies: active.sessionCookie }));
  let exchangeStarted, finishExchange;
  const started = new Promise(resolve => { exchangeStarted = resolve; });
  f.oidc.authorizationCodeGrant = async () => {
    exchangeStarted();
    await new Promise(resolve => { finishExchange = resolve; });
    return { claims: () => ({ iss: issuer, sub: 'owner-123' }) };
  };
  const pending = f.login();
  await started;
  const revoked = await f.call('/auth/sessions/revoke', 'POST', { cookies: active.sessionCookie, headers: { origin, 'x-csrf-token': session.csrfToken }, body: { all: true } });
  assert.equal(revoked.statusCode, 200);
  finishExchange();
  assert.equal((await pending).finish.statusCode, 401);
  assert.equal(f.stored.sessions.length, 0);
});

test('real openid-client validates signed ID tokens, audience, nonce, issuer and expiration', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-signing-key', use: 'sig', alg: 'RS256' };
  let authorization;
  const asJson = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const transport = async (url, options = {}) => {
    const current = new URL(url);
    if (current.pathname === '/.well-known/openid-configuration') return asJson({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
    });
    if (current.pathname === '/jwks') return asJson({ keys: [jwk] });
    assert.equal(current.pathname, '/token');
    assert.equal(options.method, 'POST');
    const parameters = new URLSearchParams(options.body);
    assert.equal(parameters.get('redirect_uri'), `${origin}/auth/callback`);
    assert.equal(createHash('sha256').update(parameters.get('code_verifier')).digest('base64url'), authorization.get('code_challenge'));
    const code = parameters.get('code'), time = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: 'studio-client', sub: 'owner-123', nonce: authorization.get('nonce'), iat: time, exp: time + 300, name: 'Riccardo' };
    if (code === 'wrong-audience') claims.aud = 'other-client';
    if (code === 'wrong-issuer') claims.iss = 'https://attacker.example';
    if (code === 'wrong-nonce') claims.nonce = 'different-nonce';
    if (code === 'expired') claims.exp = time - 3600;
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey);
    if (code === 'bad-signature') signature[0] ^= 1;
    return asJson({ access_token: 'test-access-token-not-persisted', token_type: 'Bearer', expires_in: 300, id_token: `${unsigned}.${signature.toString('base64url')}` });
  };
  const oidc = {
    ...openid,
    discovery: (server, id, metadata, auth, options) => openid.discovery(server, id, metadata, auth, { ...options, [openid.customFetch]: transport }),
    buildAuthorizationUrl(config, parameters) { authorization = new URLSearchParams(parameters); return openid.buildAuthorizationUrl(config, parameters); },
  };
  const f = fixture({ oidc });
  const accepted = await f.login();
  assert.equal(accepted.finish.statusCode, 303);
  for (const invalid of ['wrong-audience', 'wrong-issuer', 'wrong-nonce', 'expired', 'bad-signature']) {
    assert.equal((await f.login(invalid)).finish.statusCode, 401, invalid);
  }
  assert.equal(f.stored.sessions.length, 1);
  assert.equal(JSON.stringify(f.stored).includes('test-access-token'), false);
});
