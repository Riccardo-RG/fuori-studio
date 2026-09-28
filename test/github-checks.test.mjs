import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../lib/github.ts';

const commit = 'a'.repeat(40), other = 'b'.repeat(40), token = 'github_pat_' + 'S'.repeat(40);
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const check = (overrides = {}) => ({ id: 1, name: 'Unit tests', head_sha: commit, status: 'completed', conclusion: 'success', html_url: 'https://github.com/Owner/Product/actions/runs/10/job/20', ...overrides });
const status = (overrides = {}) => ({ id: 2, context: 'integration', state: 'success', url: `https://api.github.com/repos/Owner/Product/statuses/${commit}`, target_url: `https://github.com/owner/product/commit/${commit}`, ...overrides });

async function fixture({ runs = [check()], statuses = [status()], transform = (_path, value) => value } = {}) {
  const records = new Map(), calls = []; let writes = 0, scopes = [{ id: 'project', kind: 'project' }, { id: 'personal', kind: 'personal' }];
  const storage = { read: async (key, fallback) => structuredClone(records.get(key) ?? fallback), write: async (key, value) => { writes++; records.set(key, structuredClone(value)); } };
  const hub = createGitHub({ storage, workspace: { getSnapshot: async () => ({ scopes }) }, approvedRun: async () => { throw Error('Not used'); }, now: () => Date.parse('2026-09-28T12:00:00Z'), transport: async (input, options) => {
    const url = new URL(input); assert.equal(url.origin, 'https://api.github.com'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, `Bearer ${token}`);
    calls.push(url);
    const path = url.pathname.replace('/repos/owner/product/', '');
    let value;
    if (path === 'commits/main' || path === `commits/${commit}` || path === 'commits/release%2Ftest') value = { sha: commit };
    else if (path === `commits/${commit}/check-runs`) { assert.equal(url.searchParams.get('filter'), 'latest'); assert.equal(url.searchParams.get('per_page'), '100'); value = { total_count: runs.length, check_runs: runs }; }
    else if (path === `commits/${commit}/status`) { assert.equal(url.searchParams.get('per_page'), '100'); value = { sha: commit, state: 'success', total_count: statuses.length, statuses }; }
    else throw Error(`Unexpected request ${path}`);
    const changed = transform(path, value); if (changed instanceof Response) return changed; return response(changed);
  } });
  const connection = await hub.save({ name: 'Checks', token, scopeIds: ['project'], repositories: ['owner/product'], allowPublish: false });
  const input = { connectionId: connection.id, scopeId: 'project', repository: 'owner/product', ref: 'main' };
  return { hub, calls, input, connection, records, writes: () => writes, scopes: value => { scopes = value; } };
}

test('checks resolve an immutable commit, combine both result types and keep a read-only snapshot', async () => {
  const f = await fixture(), before = f.writes(), result = await f.hub.checks(f.input);
  assert.equal(result.commitSha, commit); assert.equal(result.ref, 'main'); assert.equal(result.fetchedAt, '2026-09-28T12:00:00.000Z');
  assert.equal(result.complete, true); assert.equal(result.state, 'success'); assert.deepEqual(result.errors, []);
  assert.deepEqual(result.checks.map(item => item.source), ['check_run', 'commit_status']);
  assert.equal(result.checks[0].url, check().html_url); assert.equal(result.checks[1].url, status().target_url);
  assert.equal(f.calls.length, 3); assert.equal(f.writes(), before); assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(f.calls[1].pathname, `/repos/owner/product/commits/${commit}/check-runs`); assert.equal(f.calls[2].pathname, `/repos/owner/product/commits/${commit}/status`);
  assert.deepEqual(Object.keys(f.records.get('github')).sort(), ['connections', 'publications', 'version']);
});

test('scope, repository, archive and revoked connection deny reads before transport', async () => {
  const f = await fixture();
  for (const change of [{ scopeId: 'personal' }, { repository: 'owner/elsewhere' }, { connectionId: 'missing' }, { ref: '../main' }, { ref: token }]) await assert.rejects(f.hub.checks({ ...f.input, ...change }));
  f.scopes([{ id: 'project', kind: 'archive' }]); await assert.rejects(f.hub.checks(f.input), { code: 'GITHUB_SCOPE_DENIED' });
  f.scopes([{ id: 'project', kind: 'project' }]); await f.hub.disconnect({ id: f.connection.id, expectedVersion: 1 });
  await assert.rejects(f.hub.checks(f.input), { code: 'GITHUB_SCOPE_DENIED' }); assert.equal(f.calls.length, 0);
});

test('exact published SHA cannot silently resolve to another commit; branch slash is encoded', async () => {
  const wrong = await fixture({ transform: (path, value) => path === `commits/${commit}` ? { sha: other } : value });
  await assert.rejects(wrong.hub.checks({ ...wrong.input, ref: commit }), { code: 'GITHUB_RESPONSE_INVALID' }); assert.equal(wrong.calls.length, 1);
  const f = await fixture(); const result = await f.hub.checks({ ...f.input, ref: 'release/test' }); assert.equal(result.commitSha, commit); assert.match(f.calls[0].pathname, /release%2Ftest$/);
});

test('no checks, neutral, skipped and unrecognized states never become passing tests', async () => {
  const empty = await fixture({ runs: [], statuses: [] }); const result = await empty.hub.checks(empty.input); assert.equal(result.state, 'none'); assert.equal(result.complete, true);
  for (const conclusion of ['neutral', 'skipped', 'new_future_value', null]) {
    const f = await fixture({ runs: [check({ conclusion })], statuses: [] }); const result = await f.hub.checks(f.input);
    assert.equal(result.state, ['neutral', 'skipped'].includes(conclusion) ? conclusion : 'unknown'); assert.notEqual(result.state, 'success');
  }
});

test('failed, cancelled, timed-out and pending outcomes remain distinct with mixed successful checks', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']) {
    const f = await fixture({ runs: [check({ conclusion })] }); const result = await f.hub.checks(f.input); assert.equal(result.state, conclusion); assert.equal(result.checks[0].state, conclusion);
  }
  for (const runState of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    const f = await fixture({ runs: [check({ status: runState, conclusion: null })] }); const result = await f.hub.checks(f.input); assert.equal(result.state, runState);
  }
  for (const state of ['pending', 'failure', 'error']) {
    const f = await fixture({ statuses: [status({ state })] }); assert.equal((await f.hub.checks(f.input)).state, state);
  }
});

test('mismatched check or status SHA is excluded and makes a passing group incomplete', async () => {
  for (const transform of [
    (path, value) => path.endsWith('/check-runs') ? { total_count: 1, check_runs: [check({ head_sha: other })] } : value,
    (path, value) => path.endsWith('/status') ? { ...value, sha: other } : value,
    (path, value) => path.endsWith('/status') ? { ...value, statuses: [status({ url: `https://api.github.com/repos/owner/product/statuses/${other}` })] } : value,
  ]) {
    const f = await fixture({ transform }), result = await f.hub.checks(f.input);
    assert.equal(result.complete, false); assert.equal(result.state, 'unknown'); assert.equal(result.checks.length, 1); assert.equal(result.errors[0].code, 'GITHUB_RESPONSE_INVALID');
  }
});

test('failed or paginated groups preserve available results without leaking response bodies or credentials', async () => {
  for (const reply of [response({ message: token }, 403), response({}, 200, { link: '<https://evil.example/?token=secret>; rel="next"' }), response({}, 200, { 'content-length': 9 * 1024 * 1024 })]) {
    const f = await fixture({ transform: (path, value) => path.endsWith('/check-runs') ? reply : value }), result = await f.hub.checks(f.input);
    assert.equal(result.complete, false); assert.equal(result.state, 'unknown'); assert.equal(result.checks.length, 1); assert.equal(result.errors[0].source, 'check_run');
    assert.equal(f.calls.length, 3); assert.equal(JSON.stringify(result).includes(token), false); assert.equal(JSON.stringify(result).includes('evil.example'), false);
  }
});

test('bounded result validation rejects truncation, malformed rows, duplicates and credential-bearing names', async () => {
  const cases = [
    { total_count: 101, check_runs: [check()] },
    { total_count: 1, check_runs: [null] },
    { total_count: 1, check_runs: [check({ name: 'x'.repeat(301) })] },
    { total_count: 1, check_runs: [check({ id: 1.5 })] },
    { total_count: 2, check_runs: [check(), check()] },
    { total_count: 1, check_runs: [check({ name: token })] },
  ];
  for (const runs of cases) {
    const f = await fixture({ transform: (path, value) => path.endsWith('/check-runs') ? runs : value }), result = await f.hub.checks(f.input);
    assert.equal(result.complete, false); assert.equal(result.state, 'unknown'); assert.equal(result.checks.length, 1); assert.equal(JSON.stringify(result).includes(token), false);
  }
  const f = await fixture({ statuses: [status(), status({ id: 3 })] }); assert.equal((await f.hub.checks(f.input)).complete, false);
});

test('only verified same-repository GitHub result links are exposed, and external links are never requested', async () => {
  const urls = ['https://ci.example/test', 'https://github.com.evil.example/owner/product/runs/1', 'https://github.com/owner/other/runs/1', 'https://github.com/owner/product/settings', 'https://user:pass@github.com/owner/product/runs/1', 'http://github.com/owner/product/runs/1', 'https://github.com:444/owner/product/runs/1', `https://github.com/owner/product/commit/${other}`, 'https://github.com/owner/product/runs/1?token=secret', 'javascript:alert(1)'];
  const runs = urls.map((url, index) => check({ id: index + 1, html_url: url }));
  const f = await fixture({ runs, statuses: [status({ target_url: 'https://ci.example/test' })] }), result = await f.hub.checks(f.input);
  assert.equal(result.complete, true); assert.equal(result.state, 'success'); assert.equal(result.checks.every(item => item.url === undefined), true); assert.equal(f.calls.length, 3);
});
