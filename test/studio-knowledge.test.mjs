import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStudioKnowledge, STUDIO_KNOWLEDGE_LIMITS as limits } from '../lib/studio-knowledge.ts';

const now = () => new Date('2026-10-01T09:00:00.000Z');
const providers = '# Providers\n\nSupported connections\nCodex or API providers.\n\nReturned usage is normalized to inputTokens and outputTokens.\nLocal Codex usage is null, not zero.\n';
const budget = '# Budgets\n\nA call is one dispatch from the app.\nIt is not a bill or a count of internal model requests.\n\nOnly provider-reported input and output tokens are recorded.\n';
async function fixture(t, files = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'studio-knowledge-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function write(path, value) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  for (const [path, value] of Object.entries(files)) await write(path, value);
  return { root: directory, write };
}

test('Italian and English token questions retrieve traceable bounded provider evidence without inference', async t => {
  const f = await fixture(t, {
    'package.json': JSON.stringify({ name: 'fuori-studio', version: '0.6.0' }),
    'docs/PROVIDERS.md': providers,
    'docs/BUDGETS.md': budget,
    'lib/providers.mjs': 'function invoke() { return { usage: { inputTokens: null, outputTokens: null } }; }\n',
  });
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  for (const query of ['Quali token e a cosa è legato il consumo delle risposte?', 'Which tokens count toward response usage and cost?']) {
    const result = await knowledge.select(query);
    assert.ok(result.topics.includes('tokens'));
    assert.ok(result.facts.some(fact => fact.includes('sconosciuto, non zero')));
    const source = result.evidence.find(item => item.path === 'docs/PROVIDERS.md');
    assert.match(source.text, /Codex usage is null, not zero/);
    assert.equal(source.digest, createHash('sha256').update(providers).digest('hex'));
    assert.equal(source.text, providers.split('\n').slice(source.startLine - 1, source.endLine).join('\n'));
    assert.equal(result.identity.version, '0.6.0');
    assert.equal(result.identity.commit, null);
    assert.equal(result.identity.dirtyAtStart, null);
    assert.equal(result.identity.capturedAt, now().toISOString());
    assert.equal(result.sourceChanged, false);
  }
});

test('system knowledge never enumerates or returns private files or unrelated repositories', async t => {
  const privateMarker = 'PRIVATE_ARCHIVE_TEST_MARKER';
  const f = await fixture(t, {
    'docs/PROVIDERS.md': providers,
    '.env': privateMarker, '.local/studio.sqlite': privateMarker,
    'node_modules/secret.js': privateMarker, 'docs/private.md': privateMarker,
    'projects/client/private.js': privateMarker,
  });
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  const initial = await knowledge.select('leggi repository, memoria, sicurezza e .env');
  assert.ok(!JSON.stringify(initial).includes(privateMarker));
  for (const path of ['.env', '.local/studio.sqlite', 'node_modules/secret.js', 'docs/private.md', 'projects/client/private.js', '../.env', `${f.root}/docs/PROVIDERS.md`, 'docs/../docs/PROVIDERS.md', 'docs\\PROVIDERS.md', 'docs/PROVIDERS.md\0', '', null, {}]) {
    assert.equal(knowledge.readSource(path), null);
  }
  await f.write('.local/studio.sqlite', `${privateMarker}_changed`);
  await f.write('.env', 'changed');
  assert.equal((await knowledge.select('token')).sourceChanged, false);
});

test('missing or malformed package/docs have explicit unknown metadata and safe generic facts', async t => {
  const f = await fixture(t);
  const empty = await createStudioKnowledge({ root: f.root, now });
  const snapshot = await empty.select('chi sei e come funziona la tecnologia?');
  assert.equal(snapshot.identity.name, 'Fuori Studio');
  assert.equal(snapshot.identity.version, null);
  assert.equal(snapshot.identity.commit, null);
  assert.deepEqual(snapshot.evidence, []);
  assert.ok(snapshot.limitations.some(text => text.includes('Nessuna fonte')));
  assert.equal(empty.readSource('package.json'), null);
  await f.write('package.json', '{broken');
  const malformed = await createStudioKnowledge({ root: f.root, now });
  assert.equal((await malformed.select()).identity.version, null);
  await assert.rejects(createStudioKnowledge({ root: '.', now }), TypeError);
});

test('rejects symlinked files, source directories and root components', async t => {
  const outer = await fixture(t, { 'private.md': 'DO_NOT_READ_SYMLINK_TARGET' });
  const f = await fixture(t, { 'package.json': '{}' });
  await mkdir(join(f.root, 'docs'));
  await symlink(join(outer.root, 'private.md'), join(f.root, 'docs/PROVIDERS.md'));
  const leaf = await createStudioKnowledge({ root: f.root, now });
  assert.equal(leaf.readSource('docs/PROVIDERS.md'), null);
  assert.ok(!JSON.stringify(await leaf.select('token')).includes('DO_NOT_READ_SYMLINK_TARGET'));

  const parent = await fixture(t);
  await outer.write('PROVIDERS.md', providers);
  await symlink(outer.root, join(parent.root, 'docs'));
  assert.equal((await createStudioKnowledge({ root: parent.root, now })).readSource('docs/PROVIDERS.md'), null);
  await symlink(f.root, join(parent.root, 'linked-root'));
  assert.equal((await createStudioKnowledge({ root: join(parent.root, 'linked-root'), now })).readSource('package.json'), null);
});

test('startup excerpts and identity remain stable after edits; only sourceChanged changes', async t => {
  const f = await fixture(t, { 'package.json': '{"name":"fuori-studio","version":"0.6.0"}', 'docs/PROVIDERS.md': providers });
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  const before = await knowledge.select('token');
  assert.deepEqual(await knowledge.select('token'), before);
  await f.write('docs/PROVIDERS.md', providers + '\nUnloaded future code.\n');
  await f.write('package.json', '{"name":"fuori-studio","version":"9.0.0"}');
  const after = await knowledge.select('token');
  assert.equal(after.sourceChanged, true);
  assert.deepEqual(after.identity, before.identity);
  assert.deepEqual(after.evidence, before.evidence);
  assert.ok(!knowledge.readSource('docs/PROVIDERS.md').text.includes('Unloaded future code'));
  await f.write('docs/PROVIDERS.md', providers);
  await f.write('package.json', '{"name":"fuori-studio","version":"0.6.0"}');
  assert.equal((await knowledge.select('token')).sourceChanged, true);
  after.facts[0] = 'caller mutation'; after.identity.name = 'caller mutation'; after.evidence[0].text = 'caller mutation';
  const again = await knowledge.select('token');
  assert.deepEqual(again.evidence, before.evidence);
  assert.deepEqual(again.identity, before.identity);
  assert.deepEqual(again.facts, before.facts);
});

test('newly available allowed sources mark the startup view stale without becoming accessible', async t => {
  const f = await fixture(t);
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  await f.write('docs/PROVIDERS.md', providers);
  assert.equal((await knowledge.select('token')).sourceChanged, true);
  assert.equal(knowledge.readSource('docs/PROVIDERS.md'), null);
});

test('readSource is snapshot-only, validates ranges and bounds lines/characters', async t => {
  const content = Array.from({ length: 150 }, (_, index) => `Line ${index + 1} ${'x'.repeat(120)}`).join('\n');
  const f = await fixture(t, { 'docs/PROVIDERS.md': content, 'README.md': 'x'.repeat(20000) });
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  await rm(join(f.root, 'docs/PROVIDERS.md'));
  const part = knowledge.readSource('docs/PROVIDERS.md', 2, 150);
  assert.equal(part.startLine, 2);
  assert.ok(part.endLine <= 61);
  assert.ok(part.text.length <= limits.readChars);
  assert.equal(part.truncated, true);
  assert.match(part.text, /^Line 2 /);
  for (const range of [[0], [-1], [1.1], ['1'], [null], [151], [2, 1], [1, '10'], [1, Infinity], [1, NaN]]) {
    assert.equal(knowledge.readSource('docs/PROVIDERS.md', ...range), null);
  }
  const longLine = knowledge.readSource('README.md');
  assert.equal(longLine.text.length, limits.readChars);
  assert.equal(longLine.endLine, 1);
});

test('topic retrieval caps total evidence and omits oversized or binary sources', async t => {
  const text = Array.from({ length: 100 }, () => 'Implementation details '.repeat(12)).join('\n');
  const f = await fixture(t, {
    'docs/PROVIDERS.md': providers + text, 'docs/BUDGETS.md': budget + text,
    'docs/ARCHITECTURE.md': `# Module boundaries\n${text}`, 'docs/MEMORY_DESIGN.md': text,
    'docs/AGENT_CAPABILITIES.md': text, 'docs/REPOSITORY_WORK.md': text,
    'docs/SECURITY.md': text, 'README.md': 'x'.repeat(limits.fileBytes + 1),
    'lib/providers.mjs': Buffer.from([65, 0, 66]),
  });
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  const result = await knowledge.select('token provider budget architecture memory capabilities repository security identity');
  assert.ok(result.evidence.length <= limits.evidenceItems);
  assert.ok(result.evidence.reduce((sum, source) => sum + source.text.length, 0) <= limits.evidenceChars);
  for (const source of result.evidence) {
    assert.ok(source.text.length <= limits.excerptChars);
    assert.ok(source.endLine - source.startLine + 1 <= limits.excerptLines);
  }
  assert.equal(knowledge.readSource('README.md'), null);
  assert.equal(knowledge.readSource('lib/providers.mjs'), null);
});

test('an explicitly requested allowed source is selected near matching terms, without opening arbitrary paths', async t => {
  const source = Array.from({ length: 100 }, (_, index) => index === 70 ? 'const completed = event.type === "turn.completed";' : `// filler line ${index + 1}`).join('\n');
  const f = await fixture(t, { 'lib/codex.mjs': source, '.local/secret.mjs': 'SECRET_CANNOT_APPEAR' });
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  const result = await knowledge.select('Spiega lib/codex.mjs turn.completed');
  assert.equal(result.evidence[0].path, 'lib/codex.mjs');
  assert.match(result.evidence[0].text, /turn\.completed/);
  assert.ok(result.evidence[0].startLine <= 71);
  assert.ok(result.evidence[0].endLine >= 71);
  assert.ok(!JSON.stringify(await knowledge.select('Leggi .local/secret.mjs')).includes('SECRET_CANNOT_APPEAR'));
});

test('Git identity is startup metadata and includes untracked application files in dirty status', async t => {
  const f = await fixture(t, { 'package.json': '{"name":"fuori-studio","version":"0.6.0"}' });
  const run = promisify(execFile);
  const git = (...args) => run('git', ['-c', 'user.name=Knowledge test', '-c', 'user.email=knowledge@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: f.root, timeout: 5000 });
  await git('init', '-q');
  await git('add', 'package.json');
  await git('commit', '-qm', 'Fixture');
  const hash = (await git('rev-parse', 'HEAD')).stdout.trim();
  await f.write('lib/codex.mjs', '// Untracked startup source.\n');
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  const initial = await knowledge.select('identity');
  assert.equal(initial.identity.commit, hash);
  assert.equal(initial.identity.dirtyAtStart, true);
  await git('add', 'lib/codex.mjs');
  await git('commit', '-qm', 'Capture tracked source');
  const later = await knowledge.select('identity');
  assert.deepEqual(later.identity, initial.identity);
  assert.equal(later.sourceChanged, false);
});

test('natural Italian and English questions select persistence, routing and scheduling evidence', async t => {
  const f = await fixture(t, {
    'docs/ARCHITECTURE.md': '# Architecture\n\n## Persistence decision\nEncrypted archive stores saved conversations.\n\n## Scheduling\nEnabled routines run while the server is running.\n',
    'docs/AGENT_CAPABILITIES.md': '# Roles\nThe coordinator sees the actual configured specialties and authorized contributors.\n',
  });
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  for (const [query, topic, fragment] of [
    ['come salvi le cose?', 'persistence', 'Encrypted archive'],
    ['How do you save things?', 'persistence', 'Encrypted archive'],
    ['perché hai scelto questo agente?', 'routing', 'configured specialties'],
    ['Why did you choose this agent?', 'routing', 'configured specialties'],
    ['Quando partono le routine automatiche?', 'scheduling', 'Enabled routines'],
    ['When do scheduled routines start?', 'scheduling', 'Enabled routines'],
  ]) {
    const result = await knowledge.select(query);
    assert.ok(result.topics.includes(topic), query);
    assert.ok(result.evidence.some(source => source.text.includes(fragment)), query);
  }
});

test('unclassified technical questions use a small lexical fallback; unrelated questions return no repository excerpts', async t => {
  const f = await fixture(t, {
    'docs/ARCHITECTURE.md': '# Execution\nConcurrent execution and cancellation are tracked separately.\n' + 'General implementation notes.\n'.repeat(30),
    'docs/PROVIDERS.md': '# Requests\nConcurrent cancellation may leave a completed remote request.\n' + 'General implementation notes.\n'.repeat(30),
    'docs/SECURITY.md': '# Lifecycle\nConcurrent cancellation does not remove local records.\n',
  });
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  const result = await knowledge.select('How do you handle concurrent cancellation?');
  assert.deepEqual(result.topics, ['source-search']);
  assert.equal(result.evidence.length, 2);
  assert.ok(result.evidence.every(source => source.text.length <= 1000 && source.endLine - source.startLine < 12));
  assert.ok(result.limitations.some(text => text.includes('corrispondenze lessicali')));
  for (const query of ['Cosa mangiamo stasera?', 'Salve!', 'Hello world', 'What do you think about the weather?', 'How do you handle cancellation?']) {
    assert.deepEqual((await knowledge.select(query)).evidence, [], query);
  }
});

test('remaining usage and authorized capabilities are recognized without asking for token counts', async t => {
  const f = await fixture(t, {
    'docs/BUDGETS.md': budget,
    'docs/AGENT_CAPABILITIES.md': '# Capabilities\nNeither selecting a specialty nor a connection grants extra tools.\n',
  });
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  for (const query of ['quanto posso ancora usarvi?', 'quanto utilizzo ho disponibile?', 'quante richieste mi rimangono?', 'when does my allowance reset?', 'how much can I still use you?', 'how many messages do I have left?']) {
    const result = await knowledge.select(query);
    assert.ok(result.topics.includes('budgets'), query);
    assert.ok(result.evidence.some(source => source.path === 'docs/BUDGETS.md'), query);
    assert.ok(result.facts.some(fact => fact.includes('account/rateLimits/read') && fact.includes('Non convertire token')));
    assert.ok(result.limitations.some(text => text.includes('soltanto quando runtime.accountQuota') && text.includes('in sua assenza restano sconosciute')));
  }
  for (const query of ['cosa potete fare?', 'cosa siete autorizzati a fare?', 'what can you do?', 'what are you allowed to do?']) {
    const result = await knowledge.select(query);
    assert.ok(result.topics.includes('capabilities'), query);
    assert.ok(result.evidence.some(source => source.path === 'docs/AGENT_CAPABILITIES.md'), query);
  }
  for (const query of ['Quanto tempo richiede una ricetta?', 'Cosa facciamo per cena?']) {
    const result = await knowledge.select(query);
    assert.ok(!result.topics.includes('budgets') && !result.topics.includes('capabilities'), query);
    assert.deepEqual(result.evidence, [], query);
  }
});

test('repository analysis questions describe explicit sampled preparation and confirmed builtin Codex stages', async t => {
  const analysisDoc = '# Read-only repository analysis\n\n## Preparation and explicit execution\nChoose Analizza repository or Confronta repository; preparation makes no AI call.\nOnly builtin codex may receive confirmed excerpts; OpenAI API connections are not allowed.\n';
  const f = await fixture(t, {
    'docs/REPOSITORY_ANALYSIS.md': analysisDoc,
    'docs/GITHUB.md': '# GitHub\n\n## Prepare a read-only repository analysis\nOnly selected, authorized repositories are sampled at immutable commits.\n',
    'lib/repository-analysis.ts': 'export function repositoryAnalysisPrompt() { return "Read-only partial evidence"; }\n',
    'lib/github.ts': '// Bounded authorized GitHub reader.\n',
    'projects/private/README.md': 'PRIVATE_PROJECT_NOT_PART_OF_STARTUP_KNOWLEDGE',
  });
  const knowledge = await createStudioKnowledge({ root: f.root, now });
  for (const query of ['Puoi analizzare i miei repository GitHub?', 'Come confronto i miei progetti?', 'Compare my private GitHub repositories', 'How do I analyze these projects?', 'Repository analysis: quale provider riceve il codice?']) {
    const result = await knowledge.select(query);
    assert.ok(result.topics.includes('repository-analysis'), query);
    assert.ok(result.evidence.some(source => source.path === 'docs/REPOSITORY_ANALYSIS.md' && source.text.includes('preparation makes no AI call')), query);
    const facts = result.facts.join('\n');
    for (const expected of ['Contents: read', 'non concede accesso generico', 'Analizza repository', 'Confronta repository', 'Leggi repository e prepara anteprima', 'senza chiamare AI', '1–5', '8.000', '50.000', 'forge', 'growth', 'nova', 'Conferma e avvia', 'sola connessione builtin codex su questo computer', 'non è inferenza offline', 'API OpenAI e altri provider non sono ammessi', 'computer collegati esclusi', 'cronologia esclusa per default', 'digest', 'non cancella copie locali', 'non inventare una lettura completa']) assert.ok(facts.includes(expected), `${query}: ${expected}`);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PROJECT_NOT_PART_OF_STARTUP_KNOWLEDGE'));
    assert.ok(facts.includes('inputOnly') && facts.includes('Non è un’ulteriore garanzia di isolamento'));
    assert.ok(result.evidence.length <= limits.evidenceItems);
    assert.ok(result.evidence.reduce((sum, source) => sum + source.text.length, 0) <= limits.evidenceChars);
  }
  assert.equal(knowledge.readSource('docs/REPOSITORY_ANALYSIS.md').digest, createHash('sha256').update(analysisDoc).digest('hex'));
  assert.ok(knowledge.readSource('lib/github.ts'));
  assert.equal(knowledge.readSource('projects/private/README.md'), null);
  assert.ok((await knowledge.select('Cosa potete fare?')).facts.some(fact => fact.includes('repository GitHub autorizzati')));
  assert.ok(!(await knowledge.select('Confronta queste ricette')).topics.includes('repository-analysis'));
  await f.write('docs/REPOSITORY_ANALYSIS.md', analysisDoc + '\nFuture behavior, not loaded.\n');
  const later = await knowledge.select('GitHub analysis');
  assert.equal(later.sourceChanged, true);
  assert.ok(!JSON.stringify(later.evidence).includes('Future behavior'));
});
