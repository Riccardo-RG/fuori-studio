import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { applyRepositoryPatch } from '../lib/github-patch.ts';
const exec = promisify(execFile), hash = value => { const bytes = Buffer.from(value); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
const zero = '0'.repeat(40);
const blob = (content, mode = '100644') => ({ content: Buffer.from(content), sha: hash(content), mode });
function change(old = 'before\n', next = 'after\n', path = 'a.txt') {
  return { patch: `diff --git a/${path} b/${path}\nindex ${hash(old)}..${hash(next)} 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${old}+${next}`, files: [{ path, status: 'M', additions: 1, deletions: 1 }], readBase: async () => blob(old) };
}

test('real Git patches preserve UTF-8, spaces, CRLF, missing final newlines, modes, empty files and multiple hunks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fuori-github-patch-')); t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }, maxBuffer: 8 * 1024 * 1024 }).then(result => result.stdout);
  await git(['init', '-q']);
  const baseline = new Map([
    ['ordinary.txt', 'before\n'], ['no-newline.txt', 'before'], ['remove-newline.txt', 'before\n'], ['add-newline.txt', 'before'],
    ['windows.txt', 'before\r\nkeep\r\n'], ['città ñ.txt', 'vecchio\n'], ['file with spaces.txt', 'spazio\n'], ['a"quote.txt', 'old\n'],
    ['empty-delete.txt', ''], ['delete.txt', 'delete\n'], ['mode-only.sh', 'echo ok\n'], ['mode-content.sh', 'echo before\n'],
    ['many.txt', Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('')], ['bom.txt', '\ufeffbefore\n'],
  ]);
  for (const [path, content] of baseline) await writeFile(join(root, path), content);
  await git(['add', '-A']); await git(['commit', '-qm', 'baseline']);
  const expected = new Map(baseline);
  for (const [path, content] of [
    ['ordinary.txt', 'after\n'], ['no-newline.txt', 'after'], ['remove-newline.txt', 'after'], ['add-newline.txt', 'after\n'],
    ['windows.txt', 'after\r\nkeep\r\n'], ['città ñ.txt', 'nuovo 🌍\n'], ['file with spaces.txt', 'spazio nuovo\n'], ['a"quote.txt', 'new\n'],
    ['new/empty.txt', ''], ['new/final-missing.txt', 'added'], ['mode-content.sh', 'echo after\n'], ['bom.txt', '\ufeffafter\n'],
    ['many.txt', Array.from({ length: 40 }, (_, i) => `line ${i === 2 || i === 35 ? 'changed-' + i : i}\n`).join('')],
  ]) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); expected.set(path, content); }
  for (const path of ['delete.txt', 'empty-delete.txt']) { await rm(join(root, path)); expected.delete(path); }
  for (const path of ['mode-only.sh', 'mode-content.sh']) await chmod(join(root, path), 0o755);
  await git(['add', '-A']);
  const patch = await git(['diff', '--cached', '--patch', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD']);
  const stats = new Map((await git(['diff', '--cached', '--numstat', '-z', '--no-renames', 'HEAD'])).split('\0').filter(Boolean).map(line => { const [additions, deletions, path] = line.split('\t'); return [path, { additions: Number(additions), deletions: Number(deletions) }]; }));
  const names = (await git(['diff', '--cached', '--name-status', '-z', '--no-renames', 'HEAD'])).split('\0').filter(Boolean), files = [];
  for (let i = 0; i < names.length; i += 2) files.push({ status: names[i], path: names[i + 1], ...stats.get(names[i + 1]) });
  const results = await applyRepositoryPatch({ patch, files, readBase: async path => baseline.has(path) ? blob(baseline.get(path)) : null });
  assert.equal(results.length, files.length);
  for (const result of results) {
    assert.equal(result.content, expected.get(result.path) ?? null, result.path);
    assert.equal(result.oldSha, baseline.has(result.path) ? hash(baseline.get(result.path)) : null);
    assert.equal(result.newSha, expected.has(result.path) ? hash(expected.get(result.path)) : null);
    assert.equal(result.mode, ['mode-only.sh', 'mode-content.sh'].includes(result.path) ? '100755' : '100644');
  }
});

test('rejects changed base blobs, wrong checksums, fuzzy context, malformed counts and unsafe modes', async () => {
  const valid = change();
  assert.equal((await applyRepositoryPatch(valid))[0].content, 'after\n');
  for (const invalid of [
    { ...valid, readBase: async () => blob('unexpected\n') },
    { ...valid, readBase: async () => ({ ...blob('before\n'), sha: 'a'.repeat(40) }) },
    { ...valid, readBase: async () => ({ ...blob('before\n'), mode: '120000' }) },
    { ...valid, patch: valid.patch.replace(hash('after\n'), 'a'.repeat(40)) },
    { ...valid, patch: valid.patch.replace('-before\n', '-BEFORE\n') },
    { ...valid, patch: valid.patch.replace('@@ -1 +1 @@', '@@ -1,2 +1 @@') },
    { ...valid, patch: valid.patch.replace('@@ -1 +1 @@', '@@ -2 +2 @@') },
    { ...valid, patch: valid.patch.replace('100644', '120000') },
    { ...valid, patch: valid.patch.replace(/^index .*\n/m, '') },
    { ...valid, patch: valid.patch.slice(0, -1) },
    { ...valid, patch: valid.patch.replace('+++ b/a.txt', '+++ b/other.txt') },
    { ...valid, files: [{ ...valid.files[0], additions: 2 }] },
    { ...valid, files: [{ ...valid.files[0], status: 'A' }] },
  ]) await assert.rejects(applyRepositoryPatch(invalid), { code: 'GITHUB_PATCH_INVALID' });
});
test('rejects binary inputs, unsupported formats, credential paths and duplicate/parent/case paths', async () => {
  for (const path of ['../bad', '/absolute', 'a/../../bad', '.git/config', '.codex/auth.json', '.env', 'nested/private.key', 'node_modules/x', 'a\\b', 'a\tb']) await assert.rejects(applyRepositoryPatch(change('before\n', 'after\n', path)), { code: 'GITHUB_PATCH_INVALID' });
  const valid = change();
  for (const path of ['a.txt', 'A.txt', 'a.txt/child']) await assert.rejects(applyRepositoryPatch({ ...valid, files: [...valid.files, { ...valid.files[0], path }] }), { code: 'GITHUB_PATCH_INVALID' });
  await assert.rejects(applyRepositoryPatch({ ...valid, patch: valid.patch + valid.patch }), { code: 'GITHUB_PATCH_INVALID' });
  await assert.rejects(applyRepositoryPatch({ ...valid, patch: valid.patch.replace('--- a/a.txt', 'rename from old.txt\n--- a/a.txt') }), { code: 'GITHUB_PATCH_INVALID' });
  await assert.rejects(applyRepositoryPatch({ ...valid, readBase: async () => ({ content: Buffer.from([0xff]), sha: hash(Buffer.from([0xff])), mode: '100644' }) }), { code: 'GITHUB_PATCH_INVALID' });
  await assert.rejects(applyRepositoryPatch({ ...valid, patch: valid.patch.replace('+after', '+\0after') }), { code: 'GITHUB_PATCH_INVALID' });
});
test('handles insertions and deletions at exact zero-count positions without permitting fabricated EOF markers', async () => {
  const source = 'one\ntwo\n', next = 'one\ninserted\ntwo\n';
  const options = { patch: `diff --git a/a.txt b/a.txt\nindex ${hash(source)}..${hash(next)} 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,0 +2 @@\n+inserted\n`, files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 0 }], readBase: async () => blob(source) };
  assert.equal((await applyRepositoryPatch(options))[0].content, next);
  await assert.rejects(applyRepositoryPatch({ ...options, patch: options.patch.replace('+inserted\n', '+inserted\n\\ No newline at end of file\n') }), { code: 'GITHUB_PATCH_INVALID' });
  const deletion = { patch: `diff --git a/a.txt b/a.txt\nindex ${hash(next)}..${hash(source)} 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -2 +1,0 @@\n-inserted\n`, files: [{ path: 'a.txt', status: 'M', additions: 0, deletions: 1 }], readBase: async () => blob(next) };
  assert.equal((await applyRepositoryPatch(deletion))[0].content, source);
});
test('bounds patch/file counts and file contents before returning publishable output', async () => {
  const valid = change();
  await assert.rejects(applyRepositoryPatch({ ...valid, patch: 'x'.repeat(4 * 1024 * 1024 + 1) }), { code: 'GITHUB_PATCH_INVALID' });
  await assert.rejects(applyRepositoryPatch({ ...valid, files: Array.from({ length: 201 }, (_, i) => ({ ...valid.files[0], path: String(i) })) }), { code: 'GITHUB_PATCH_INVALID' });
  await assert.rejects(applyRepositoryPatch({ ...valid, readBase: async () => blob('x'.repeat(1024 * 1024 + 1)) }), { code: 'GITHUB_PATCH_INVALID' });
  assert.deepEqual(await applyRepositoryPatch({ patch: '', files: [], readBase: async () => null }), []);
  const patch = `diff --git a/empty b/empty\nnew file mode 100644\nindex ${zero}..${hash('')}\n`;
  assert.equal((await applyRepositoryPatch({ patch, files: [{ path: 'empty', status: 'A', additions: 0, deletions: 0 }], readBase: async () => null }))[0].content, '');
  await assert.rejects(applyRepositoryPatch({ patch, files: [{ path: 'empty', status: 'A', additions: 0, deletions: 0 }], readBase: async () => blob('') }), { code: 'GITHUB_PATCH_INVALID' });
});
