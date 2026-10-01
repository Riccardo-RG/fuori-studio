import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { createCodexAccountLimits } from '../lib/codex.mjs';

const observed = Date.parse('2026-10-01T10:00:00.000Z');
const window = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1790856000 };
const normalizedWindow = { usedPercent: 25, remainingPercent: 75, windowDurationMins: 300, resetsAt: '2026-10-01T12:00:00.000Z' };

async function fixture(t, result, { mode = 'success', timeoutMs = 4000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-codex-quota-'));
  const binary = join(directory, 'codex-stub'), log = join(directory, 'requests.jsonl');
  const children = [], closed = [];
  let time = observed;
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(closed);
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
const config=${JSON.stringify({ result, mode, log })};
if(config.mode==='unsupported')process.exit(2);
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
  const request=JSON.parse(line);fs.appendFileSync(config.log,JSON.stringify(request)+'\\n');
  if(request.method==='initialize'){
    if(config.mode==='init-error')send({id:1,error:{message:'PRIVATE_INITIALIZE_ERROR'}});
    else{process.stderr.write('PRIVATE_STDERR');send({method:'configWarning',params:{details:'PRIVATE_CONFIGURATION'}});send({id:1,result:{userAgent:'PRIVATE_USER_AGENT'}});}
  }else if(request.method==='account/rateLimits/read'){
    if(config.mode==='timeout')return;
    if(config.mode==='rpc-error')return send({id:2,error:{message:'PRIVATE_RPC_ERROR'}});
    if(config.mode==='server-request')return send({id:99,method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:'PRIVATE_ACCOUNT'}});
    if(config.mode==='stdout-limit')return process.stdout.write('x'.repeat(256*1024+1));
    if(config.mode==='stderr-limit')return process.stderr.write('x'.repeat(256*1024+1));
    if(config.mode==='malformed')return process.stdout.write('PRIVATE_MALFORMED_JSON\\n');
    const response=JSON.stringify({id:2,result:config.result});
    if(config.mode==='no-newline')return process.stdout.write(response,()=>process.exit(0));
    process.stdout.write(response.slice(0,7));
    setImmediate(()=>process.stdout.write(response.slice(7)+'\\n'));
  }
});
`, { mode: 0o700 });
  const collector = createCodexAccountLimits({
    resolveBinary: async () => binary, now: () => time, timeoutMs,
    spawnProcess(program, args, options) {
      assert.equal(program, binary);
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      const child = spawn(program, args, options); children.push(child); closed.push(once(child, 'close')); return child;
    },
  });
  const requests = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { collector, children, requests, advance(ms) { time += ms; }, close: () => Promise.all(closed) };
}

test('quota collection reads only the account limit protocol and omits all account and billing metadata', async t => {
  const f = await fixture(t, {
    accountId: 'PRIVATE_ACCOUNT', planType: 'PRIVATE_PLAN', credits: { balance: 'PRIVATE_BALANCE' }, rateLimitResetCredits: { credits: [{ id: 'PRIVATE_RESET' }] }, rateLimitUpsell: { message: 'PRIVATE_UPSELL' },
    ordinaryUsageAllowed: false,
    rateLimits: { limitId: 'legacy-unused', primary: { usedPercent: 90 } },
    rateLimitsByLimitId: {
      codex: { primary: window, secondary: { usedPercent: 105, windowDurationMins: 10080, resetsAt: null }, planType: 'PRIVATE_PLAN', limitName: 'PRIVATE_LABEL' },
      'codex-extra': { primary: { usedPercent: 0 } },
    },
  });
  const result = await f.collector(); await f.close();
  assert.deepEqual(result, { source: 'codex_app_server', observedAt: new Date(observed).toISOString(), ordinaryUsageAllowed: false, limits: [
    { id: 'codex', primary: normalizedWindow, secondary: { usedPercent: 105, remainingPercent: 0, windowDurationMins: 10080, resetsAt: null } },
    { id: 'codex-extra', primary: { usedPercent: 0, remainingPercent: 100, windowDurationMins: null, resetsAt: null }, secondary: null },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|accountId|credits|planType|legacy-unused/);
  assert.equal(result.ordinaryUsageAllowed, false, 'positive remaining percentages cannot override the authoritative availability flag');
  const requests = await f.requests();
  assert.deepEqual(requests.map(item => item.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.deepEqual(requests[2], { id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true, supportsLunaReserve: false } });
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test('quota collection supports legacy buckets and an EOF-terminated final response', async t => {
  const f = await fixture(t, { rateLimits: { primary: window, secondary: null } }, { mode: 'no-newline' });
  assert.deepEqual(await f.collector(), { source: 'codex_app_server', observedAt: new Date(observed).toISOString(), ordinaryUsageAllowed: null, limits: [{ id: 'legacy', primary: normalizedWindow, secondary: null }] });
  await f.close();
});

test('quota windows require safe measured integers and identifiers while incomplete metadata remains unknown', async t => {
  const invalid = [-1, 0.5, '25', true, null, {}, Number.MAX_SAFE_INTEGER + 1];
  const buckets = Object.fromEntries(invalid.map((usedPercent, index) => [`invalid-${index}`, { primary: { usedPercent } }]));
  Object.assign(buckets, { safe: { primary: { usedPercent: 10, windowDurationMins: -1, resetsAt: 8640000000001 }, secondary: { usedPercent: 20, windowDurationMins: '300', resetsAt: '1790856000' } }, 'invalid/bucket': { primary: window }, constructor: { primary: window }, prototype: { primary: window } });
  const f = await fixture(t, { ordinaryUsageAllowed: 'true', rateLimitsByLimitId: buckets });
  const result = await f.collector();
  assert.equal(result.ordinaryUsageAllowed, null);
  assert.deepEqual(result.limits, [{ id: 'safe', primary: { usedPercent: 10, remainingPercent: 90, windowDurationMins: null, resetsAt: null }, secondary: { usedPercent: 20, remainingPercent: 80, windowDurationMins: null, resetsAt: null } }]);
});

test('unavailable measurements stay null, but a reported availability flag can stand alone', async t => {
  for (const result of [null, {}, { rateLimits: { primary: { usedPercent: null } } }, { rateLimitsByLimitId: {}, rateLimits: { primary: window } }]) {
    const f = await fixture(t, result);
    assert.equal(await f.collector(), null);
  }
  const reported = await fixture(t, { ordinaryUsageAllowed: false });
  assert.deepEqual(await reported.collector(), { source: 'codex_app_server', observedAt: new Date(observed).toISOString(), ordinaryUsageAllowed: false, limits: [] });
});

test('quota cache coalesces concurrent reads for 60 seconds and cannot be mutated by consumers', async t => {
  const f = await fixture(t, { rateLimits: { limitId: 'codex', primary: window } });
  const values = await Promise.all(Array.from({ length: 6 }, () => f.collector()));
  assert.equal(f.children.length, 1);
  values[0].limits[0].primary.remainingPercent = 0;
  assert.equal(values[1].limits[0].primary.remainingPercent, 75);
  f.advance(59999);
  assert.equal((await f.collector()).limits[0].primary.remainingPercent, 75);
  assert.equal(f.children.length, 1);
  f.advance(1);
  const refreshed = await f.collector();
  assert.equal(refreshed.observedAt, new Date(observed + 60000).toISOString());
  assert.equal(f.children.length, 2);
});

test('unsupported protocol, raw errors, unsolicited requests and excessive output fail closed and stop children', async t => {
  for (const mode of ['unsupported', 'init-error', 'rpc-error', 'server-request', 'stdout-limit', 'stderr-limit']) {
    const f = await fixture(t, { rateLimits: { primary: window } }, { mode });
    assert.equal(await f.collector(), null, mode); await f.close();
    assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null), mode);
    assert.ok((await f.requests()).every(item => ['initialize', 'initialized', 'account/rateLimits/read'].includes(item.method)), mode);
    assert.equal(await f.collector(), null);
    assert.equal(f.children.length, 1, 'failed reads are cached too');
  }
});

test('quota deadlines include binary resolution and terminate stalled or malformed protocol sessions', async t => {
  for (const mode of ['timeout', 'malformed']) {
    const f = await fixture(t, {}, { mode, timeoutMs: 200 });
    assert.equal(await f.collector(), null); await f.close();
    assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
  }
  let resolveBinary, calls = 0;
  const collect = createCodexAccountLimits({ resolveBinary: () => new Promise(resolve => { resolveBinary = resolve; }), spawnProcess: () => { calls++; throw Error('Unexpected spawn'); }, timeoutMs: 5 });
  assert.equal(await collect(), null);
  resolveBinary('unused'); await setImmediate();
  assert.equal(calls, 0, 'late binary resolution cannot start an abandoned collector');
  const missing = createCodexAccountLimits({ resolveBinary: async () => { throw Error('PRIVATE_MISSING_BINARY'); } });
  assert.equal(await missing(), null);
});
