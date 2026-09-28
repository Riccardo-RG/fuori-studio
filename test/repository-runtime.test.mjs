import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRepositoryRuntime, validateRepositoryCommand } from '../lib/repository-runtime.mjs';

async function fixture(t, options = {}, behavior = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'fuori-repository-runtime-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'), managed = join(directory, 'managed');
  await mkdir(source);
  const git = (...args) => {
    const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', source, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  await writeFile(join(source, 'README.md'), '# Original committed content\n');
  await writeFile(join(source, '.gitignore'), 'node_modules/\n.env\n');
  git('add', '.'); git('commit', '-qm', 'Initial fixture');
  const codexBinary = join(directory, 'fake-codex');
  await writeFile(codexBinary, `#!${process.execPath}\nimport{spawnSync}from'node:child_process';import{writeFileSync}from'node:fs';import{join}from'node:path';
const args=process.argv.slice(2),behavior=${JSON.stringify(behavior)};
if(args[0]==='sandbox'){
 const marker=args.indexOf('--'),argv=args.slice(marker+1);
 if(!args.includes('-P')||!args.some(value=>value.includes('.network.enabled=false'))||!args.some(value=>value.includes('":root"="deny"')))process.exit(91);
 if(behavior.noSandbox)process.exit(65);
 if(argv[0]==='/usr/bin/true')process.exit(0);
 const result=spawnSync(argv[0],argv.slice(1),{cwd:process.cwd(),env:process.env,encoding:'utf8',maxBuffer:16*1024*1024});
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??90);
}
if(args[0]==='exec'){
 if(!args.includes('--ignore-user-config')||!args.includes('--ignore-rules')||!args.includes('--ephemeral')||!args.includes('approval_policy="never"'))process.exit(92);
 let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
  if(behavior.editFailure)process.exit(1);
  writeFileSync(join(process.cwd(),'README.md'),'# Edited in isolation\\n');
  writeFileSync(join(process.cwd(),'new-file.js'),'export const value = 42;\\n');
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Implemented and ready for review.'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:50}}));
 });
}else if(args[0]!=='sandbox')process.exit(93);
`, { mode: 0o700 });
  const runtime = createRepositoryRuntime({ directory: managed, codexBinary, ...options });
  const prepare = async runId => runtime.prepare({ path: source, baseCommit: git('rev-parse', 'HEAD'), runId: runId || 'test-run' });
  return { directory, source, managed, git, runtime, prepare, codexBinary };
}

test('inspection returns exact committed HEAD, dirty state and sanitized GitHub origin', async t => {
  const f = await fixture(t);
  f.git('remote', 'add', 'origin', 'git@github.com:Riccardo-RG/fuori-studio.git');
  let info = await f.runtime.inspect(f.source);
  assert.equal(info.path, f.source); assert.equal(info.head, f.git('rev-parse', 'HEAD'));
  assert.equal(info.branch, 'main'); assert.equal(info.dirty, false);
  assert.equal(info.remote, 'https://github.com/Riccardo-RG/fuori-studio');
  await writeFile(join(f.source, 'README.md'), 'Uncommitted edit.\n');
  assert.equal((await f.runtime.inspect(f.source)).dirty, true);
  f.git('remote', 'set-url', 'origin', 'https://private-token@github.com/owner/project.git');
  assert.equal((await f.runtime.inspect(f.source)).remote, null);
  await mkdir(join(f.source, 'nested'));
  await assert.rejects(f.runtime.inspect(join(f.source, 'nested')), /radice/);
  await assert.rejects(f.runtime.inspect('relative/path'));
});

test('preparation copies only the committed tree and never original edits, untracked secrets, hooks or remote configuration', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'README.md'), 'Local work must remain.\n');
  await writeFile(join(f.source, '.env'), 'API_KEY=never-copy-this-local-secret\n');
  await writeFile(join(f.source, 'untracked.txt'), 'Never copy untracked material.');
  const hook = join(f.source, '.git', 'hooks', 'post-checkout');
  await writeFile(hook, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  f.git('config', 'filter.evil.clean', 'touch /tmp/fuori-do-not-run');
  const snapshot = await f.prepare();
  assert.equal(await readFile(join(snapshot.cwd, 'README.md'), 'utf8'), '# Original committed content\n');
  for (const name of ['.env', 'untracked.txt', '.git/hooks/post-checkout']) await assert.rejects(access(join(snapshot.cwd, name)), { code: 'ENOENT' });
  assert.doesNotMatch(await readFile(join(snapshot.cwd, '.git/config'), 'utf8'), /evil|remote|private-token/);
  assert.equal(await readFile(join(f.source, 'README.md'), 'utf8'), 'Local work must remain.\n');
  assert.equal(await readFile(join(f.source, '.env'), 'utf8'), 'API_KEY=never-copy-this-local-secret\n');
  const empty = await f.runtime.diff(snapshot); assert.equal(empty.patch, ''); assert.equal(empty.stats.files, 0);
  const restarted = createRepositoryRuntime({ directory: f.managed, codexBinary: f.codexBinary });
  assert.equal((await restarted.diff(snapshot)).hash, empty.hash);
});

test('stale commits, reused identifiers and unowned checkouts are refused', async t => {
  const f = await fixture(t), initial = f.git('rev-parse', 'HEAD');
  await writeFile(join(f.source, 'new.txt'), 'new revision'); f.git('add', '.'); f.git('commit', '-qm', 'Next commit');
  await assert.rejects(f.runtime.prepare({ path: f.source, baseCommit: initial, runId: 'stale' }), { code: 'REPOSITORY_STALE_BASE' });
  await assert.rejects(f.runtime.prepare({ path: f.source, baseCommit: f.git('rev-parse', 'HEAD'), runId: '../escape' }));
  const prepared = await f.prepare();
  await assert.rejects(f.prepare(), { code: 'EEXIST' });
  await assert.rejects(f.runtime.diff({ cwd: f.source, baseCommit: prepared.baseCommit }), { code: 'REPOSITORY_PATH_DENIED' });
  await assert.rejects(f.runtime.diff({ ...prepared, baseCommit: initial }), { code: 'REPOSITORY_STALE_BASE' });
});

test('tracked symlinks, submodules and protected configuration are rejected before materialization', async t => {
  const f = await fixture(t);
  await symlink('/etc/passwd', join(f.source, 'outside')); f.git('add', 'outside'); f.git('commit', '-qm', 'Unsafe link');
  await assert.rejects(f.runtime.inspect(f.source), { code: 'REPOSITORY_UNSAFE_ENTRY' });
  f.git('reset', '--hard', 'HEAD~1');
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.git('rev-parse', 'HEAD')},submodule`); f.git('commit', '-qm', 'Submodule reference');
  await assert.rejects(f.runtime.inspect(f.source), { code: 'REPOSITORY_UNSAFE_ENTRY' });
  f.git('reset', '--hard', 'HEAD~1');
  await mkdir(join(f.source, '.codex')); await writeFile(join(f.source, '.codex/config.toml'), 'sandbox_mode="danger-full-access"'); f.git('add', '.'); f.git('commit', '-qm', 'Protected configuration');
  await assert.rejects(f.runtime.inspect(f.source), { code: 'REPOSITORY_PROTECTED_PATH' });
});

test('editing uses the restricted runtime and produces a complete patch including new untracked files', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  const result = await f.runtime.edit({ cwd: prepared.cwd, prompt: 'Make a small change.' });
  assert.equal(result.text, 'Implemented and ready for review.'); assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50 });
  assert.equal(await readFile(join(f.source, 'README.md'), 'utf8'), '# Original committed content\n');
  const diff = await f.runtime.diff(prepared);
  assert.equal(diff.truncated, false); assert.equal(diff.hash, createHash('sha256').update(diff.patch).digest('hex'));
  assert.match(diff.patch, /Edited in isolation/); assert.match(diff.patch, /new-file\.js/);
  assert.deepEqual(diff.files.map(file => [file.path, file.status]), [['README.md', 'M'], ['new-file.js', 'A']]);
  assert.deepEqual(diff.stats, { files: 2, additions: 2, deletions: 1 });
});

test('binary or oversized patches and introduced symlinks are rejected rather than truncated', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  await writeFile(join(prepared.cwd, 'image.bin'), Buffer.from([0, 1, 0, 255]));
  await assert.rejects(f.runtime.diff(prepared), { code: 'REPOSITORY_BINARY_DIFF' });
  await rm(join(prepared.cwd, 'image.bin'));
  await symlink('/etc/passwd', join(prepared.cwd, 'outside'));
  await assert.rejects(f.runtime.diff(prepared), { code: 'REPOSITORY_UNSAFE_ENTRY' });
  await rm(join(prepared.cwd, 'outside'));
  await writeFile(join(prepared.cwd, 'large.txt'), 'large text\n'.repeat(300));
  const limited = createRepositoryRuntime({ directory: f.managed, codexBinary: f.codexBinary, maxPatchBytes: 300 });
  await assert.rejects(limited.diff(prepared), { code: 'REPOSITORY_OUTPUT_LIMIT' });
});

test('checks execute owner-selected argv and preserve actual exit status without inheriting service secrets', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  process.env.FUORI_STUDIO_TEST_SECRET = 'must-not-inherit';
  process.env.NODE_OPTIONS = '--no-warnings';
  t.after(() => { delete process.env.FUORI_STUDIO_TEST_SECRET; delete process.env.NODE_OPTIONS; });
  const ok = await f.runtime.check({ cwd: prepared.cwd, command: { label: 'Tests', program: process.execPath, args: ['-e', 'console.log(JSON.stringify({secret:process.env.FUORI_STUDIO_TEST_SECRET,nodeOptions:process.env.NODE_OPTIONS,offline:process.env.NPM_CONFIG_OFFLINE}))'] } });
  assert.equal(ok.status, 'passed'); assert.equal(ok.exitCode, 0); assert.match(ok.output, /"offline":"true"/); assert.doesNotMatch(ok.output, /must-not-inherit|no-warnings/);
  const failed = await f.runtime.check({ cwd: prepared.cwd, command: { label: 'Failing assertion', program: process.execPath, args: ['-e', 'console.error("assertion failed");process.exit(7)'] } });
  assert.equal(failed.status, 'failed'); assert.equal(failed.exitCode, 7); assert.match(failed.output, /assertion failed/);
  const literal = await f.runtime.check({ cwd: prepared.cwd, command: { label: 'Literal argv', program: process.execPath, args: ['-e', 'console.log(process.argv[1])', '$(touch DO-NOT-CREATE)'] } });
  assert.match(literal.output, /\$\(touch DO-NOT-CREATE\)/); await assert.rejects(access(join(prepared.cwd, 'DO-NOT-CREATE')), { code: 'ENOENT' });
});

test('unavailable OS sandbox prevents both checks and editing with no fallback', async t => {
  const f = await fixture(t, {}, { noSandbox: true }), prepared = await f.prepare();
  const result = await f.runtime.check({ cwd: prepared.cwd, command: { label: 'Would write', program: process.execPath, args: ['-e', 'require("fs").writeFileSync("escaped.txt","bad")'] } });
  assert.equal(result.status, 'error'); assert.equal(result.code, 'SANDBOX_UNAVAILABLE'); assert.equal(result.exitCode, null);
  await assert.rejects(access(join(prepared.cwd, 'escaped.txt')), { code: 'ENOENT' });
  await assert.rejects(f.runtime.edit({ cwd: prepared.cwd, prompt: 'Modify files' }), { code: 'SANDBOX_UNAVAILABLE' });
  assert.equal((await f.runtime.diff(prepared)).stats.files, 0);
});

test('timeout, output limits and abort stop commands; cancellation remains distinct from a failed test', async t => {
  const f = await fixture(t, { checkTimeoutMs: 150, maxOutputBytes: 2048 }), prepared = await f.prepare();
  const timeout = await f.runtime.check({ cwd: prepared.cwd, command: { label: 'Never ends', program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } });
  assert.equal(timeout.status, 'error'); assert.equal(timeout.code, 'REPOSITORY_TIMEOUT');
  const outputRuntime = createRepositoryRuntime({ directory: f.managed, codexBinary: f.codexBinary, maxOutputBytes: 2048 });
  const overflow = await outputRuntime.check({ cwd: prepared.cwd, command: { label: 'Too much output', program: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(10000))'] } });
  assert.equal(overflow.status, 'error'); assert.equal(overflow.code, 'REPOSITORY_OUTPUT_LIMIT');
  const controller = new AbortController();
  const pending = f.runtime.check({ cwd: prepared.cwd, command: { label: 'Cancel', program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(pending, { code: 'REPOSITORY_ABORTED', statusCode: 499 });
});

test('matching lockfile enables read-only dependency reuse; changed lockfiles do not', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'package.json'), '{"name":"fixture","dependencies":{"example":"1.0.0"}}');
  await writeFile(join(f.source, 'package-lock.json'), '{"lockfileVersion":3}');
  f.git('add', '.'); f.git('commit', '-qm', 'Dependency manifest');
  await mkdir(join(f.source, 'node_modules')); await writeFile(join(f.source, 'node_modules/example.txt'), 'dependency');
  const prepared = await f.prepare('deps-present');
  assert.equal(prepared.dependencies.status, 'reused-read-only'); assert.equal((await lstat(join(prepared.cwd, 'node_modules'))).isSymbolicLink(), true);
  assert.equal((await f.runtime.diff(prepared)).stats.files, 0);
  await writeFile(join(f.source, 'package-lock.json'), '{"changed":true}');
  const missing = await f.prepare('deps-mismatch');
  assert.equal(missing.dependencies.status, 'missing'); await assert.rejects(access(join(missing.cwd, 'node_modules')), { code: 'ENOENT' });
});

test('command and checkout validation reject malformed controls and modified Git configuration', async t => {
  assert.deepEqual(validateRepositoryCommand({ label: ' Tests ', program: 'node', args: ['--test'] }), { label: 'Tests', program: 'node', args: ['--test'] });
  for (const invalid of [{ label: '', program: 'node', args: [] }, { label: 'Test', program: '-danger', args: [] }, { label: 'Test', program: 'node', args: ['bad\0arg'] }, { label: 'Test', program: 'node', args: [], shell: true }]) assert.throws(() => validateRepositoryCommand(invalid));
  const f = await fixture(t), prepared = await f.prepare();
  await writeFile(join(prepared.cwd, '.git/config'), '[core]\nrepositoryformatversion=0\n[filter "evil"]\nclean=unexpected-command\n');
  await assert.rejects(f.runtime.diff(prepared), { code: 'REPOSITORY_BASE_CHANGED' });
});

test('internal temporary paths and total checkout size remain bounded and cannot become symlinks', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  const limited = createRepositoryRuntime({ directory: f.managed, codexBinary: f.codexBinary, maxFiles: 3 });
  await writeFile(join(prepared.cwd, 'one'), 'one'); await writeFile(join(prepared.cwd, 'two'), 'two');
  await assert.rejects(limited.diff(prepared), { code: 'REPOSITORY_TOO_LARGE' });
  await rm(join(prepared.cwd, '.fuori-runtime-tmp'), { recursive: true });
  await symlink(f.source, join(prepared.cwd, '.fuori-runtime-tmp'));
  await assert.rejects(f.runtime.diff(prepared), { code: 'REPOSITORY_PATH_DENIED' });
});
