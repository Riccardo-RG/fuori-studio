import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const PROFILE = 'fuori-studio-repository';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const failure = (message, code = 'REPOSITORY_INVALID', statusCode = 400) => Object.assign(Error(message), { code, statusCode, status: statusCode });
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => path === root || path.startsWith(root + sep);
const text = value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
const configArg = (name, value) => ['-c', `${name}=${JSON.stringify(value)}`];
const GIT_FLAGS = ['--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'credential.helper=', '-c', 'protocol.allow=never'];

export function validateRepositoryCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command) || Object.keys(command).some(key => !['label', 'program', 'args'].includes(key))) throw failure('Controllo repository non valido.');
  if (typeof command.label !== 'string' || !command.label.trim() || command.label.length > 100 || /[\0\r\n]/.test(command.label)) throw failure('Indica un nome breve per il controllo.');
  if (typeof command.program !== 'string' || !command.program.trim() || command.program.length > 1024 || /[\0\r\n]/.test(command.program) || command.program.startsWith('-')) throw failure('Indica un programma eseguibile, senza una riga di shell.');
  if (!Array.isArray(command.args) || command.args.length > 80 || command.args.some(arg => typeof arg !== 'string' || arg.length > 8000 || arg.includes('\0')) || command.args.reduce((sum, arg) => sum + arg.length, 0) > 24000) throw failure('Argomenti del controllo non validi.');
  return { label: command.label.trim(), program: command.program, args: [...command.args] };
}

function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\0\r\n\t\\]/.test(path) || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw failure('Il repository contiene un percorso non supportato.');
  return path;
}

function protectedPath(path) {
  return path.split('/').some(part => ['.codex', '.agents', '.ssh', '.aws', '.local'].includes(part.toLowerCase())) || /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]+)?|\.npmrc|\.netrc|credentials(?:\.json)?|auth\.json|id_rsa|id_ed25519|[^/]+\.(?:p12|pfx|pem|key))$/i.test(path);
}

function scrubEnvironment(home, temporary, { auth = false } = {}) {
  const env = {
    PATH: [...new Set([dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin'])].join(':'),
    HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TERM: 'dumb', CI: '1', NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', GIT_SSH_COMMAND: '/usr/bin/false',
    NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_OFFLINE: 'true',
    PIP_NO_INDEX: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1', ZDOTDIR: home,
  };
  if (auth) env.CODEX_HOME = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  else env.CODEX_HOME = join(home, '.codex');
  return env;
}

/** Bounded argv-only execution. Injection replaces process spawning in tests,
 * not the sandbox policy or the runtime's path/commit validation. */
async function subprocess(program, args, { cwd, env, input, signal, timeoutMs, maxBytes } = {}) {
  if (signal?.aborted) throw failure('Esecuzione interrotta.', 'REPOSITORY_ABORTED', 499);
  return new Promise((resolveRun, reject) => {
    const started = Date.now(), child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: false });
    const stdout = [], stderr = []; let size = 0, error, settled = false, killTimer, finishTimer;
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { child.kill('SIGTERM'); } };
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finishTimer); signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolveRun({ exitCode: child.exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), durationMs: Date.now() - started });
    };
    const stop = cause => {
      if (error) return; error = cause; kill();
      killTimer = setTimeout(() => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }, 500);
      finishTimer = setTimeout(finish, 1500);
    };
    const abort = () => stop(failure('Esecuzione interrotta.', 'REPOSITORY_ABORTED', 499));
    const timer = setTimeout(() => stop(failure('Il comando ha superato il tempo massimo. Nessuna esecuzione automatica aggiuntiva.', 'REPOSITORY_TIMEOUT', 408)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const collect = list => chunk => { size += chunk.length; if (size > maxBytes) stop(failure('Output troppo grande: il comando è stato interrotto.', 'REPOSITORY_OUTPUT_LIMIT', 413)); else list.push(chunk); };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.once('error', () => { error = failure('Impossibile avviare il programma richiesto.', 'REPOSITORY_EXEC_UNAVAILABLE', 503); finish(); });
    child.once('close', finish); child.stdin.on('error', () => {});
    if (signal?.aborted) abort(); else child.stdin.end(input);
  });
}

export function createRepositoryRuntime({ directory, codexBinary = process.env.FUORI_STUDIO_CODEX_BIN || DEFAULT_CODEX, gitBinary = '/usr/bin/git', execute = subprocess, maxPatchBytes = 2 * 1024 * 1024, maxOutputBytes = 1024 * 1024, maxSnapshotBytes = 128 * 1024 * 1024, maxFiles = 10000, editTimeoutMs = 10 * 60 * 1000, checkTimeoutMs = 5 * 60 * 1000 } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw failure('Configura una directory assoluta per gli ambienti repository.');
  const managed = resolve(directory), controls = join(managed, 'runs');
  let root;
  const active = new Set();
  async function init() {
    if (root) return;
    await mkdir(controls, { recursive: true, mode: 0o700 });
    for (const path of [managed, controls]) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw failure('Directory degli ambienti non sicura.'); await chmod(path, 0o700); }
    root = await realpath(controls);
  }
  async function run(program, args, options = {}) {
    const result = await execute(program, args, { timeoutMs: 30000, maxBytes: maxOutputBytes, ...options });
    if (!result || !Number.isInteger(result.exitCode) || !['string', 'object'].includes(typeof result.stdout)) throw failure('Risposta del runtime non valida.', 'REPOSITORY_EXEC_INVALID', 503);
    return { ...result, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || ''), stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '') };
  }
  async function git(cwd, args, options = {}) {
    const result = await run(gitBinary, [...GIT_FLAGS, '-C', cwd, ...args], { cwd, env: scrubEnvironment(managed, managed), ...options });
    if (result.exitCode !== 0) throw failure('Git non ha completato l’operazione. Verifica repository e commit.', 'REPOSITORY_GIT_FAILED', 409);
    return result.stdout;
  }
  async function tree(path, commit) {
    const raw = await git(path, ['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', commit], { maxBytes: 4 * 1024 * 1024 });
    const entries = text(raw).split('\0').filter(Boolean).map(line => {
      const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64}) +(-|\d+)\t([\s\S]+)$/.exec(line);
      if (!match) throw failure('Struttura Git non supportata.');
      const [, mode, type, oid, bytes, name] = match;
      safePath(name);
      if (['node_modules', '.fuori-runtime-tmp'].includes(name.split('/')[0])) throw failure('Il commit contiene directory riservate all’ambiente di esecuzione.', 'REPOSITORY_PROTECTED_PATH');
      if (!['040000', '100644', '100755'].includes(mode) || !['blob', 'tree'].includes(type)) throw failure('I repository con collegamenti simbolici o sottomoduli richiedono un ambiente dedicato.', 'REPOSITORY_UNSAFE_ENTRY');
      if (protectedPath(name)) throw failure('Il commit contiene credenziali o configurazioni di esecuzione protette. Usa un commit privo di questi file.', 'REPOSITORY_PROTECTED_PATH');
      return { path: name, mode, type, oid, size: bytes === '-' ? 0 : Number(bytes) };
    });
    if (entries.length > maxFiles || entries.reduce((total, entry) => total + entry.size, 0) > maxSnapshotBytes) throw failure('Repository troppo grande per questo ambiente isolato.', 'REPOSITORY_TOO_LARGE', 413);
    return entries;
  }
  async function inspect(path) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw failure('Scegli il percorso assoluto di un repository locale.');
    const inputInfo = await lstat(path);
    if (!inputInfo.isDirectory() || inputInfo.isSymbolicLink()) throw failure('Seleziona una directory reale, non un collegamento.');
    const source = await realpath(path), top = text(await git(source, ['rev-parse', '--show-toplevel'])).trim();
    if (await realpath(top) !== source || text(await git(source, ['rev-parse', '--is-bare-repository'])).trim() !== 'false') throw failure('Seleziona la radice di un repository con una copia di lavoro.');
    const head = text(await git(source, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (!COMMIT.test(head)) throw failure('Il repository deve contenere almeno un commit.');
    const entries = await tree(source, head), blobs = entries.filter(item => item.type === 'blob');
    let dirty = false;
    const staged = text(await git(source, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean);
    const expected = new Set(blobs.map(item => `${item.mode} ${item.oid} 0\t${item.path}`));
    if (staged.length !== expected.size || staged.some(item => !expected.has(item))) dirty = true;
    for (const entry of blobs) {
      const file = join(source, entry.path);
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > maxSnapshotBytes) { dirty = true; continue; }
        if (!inside(source, await realpath(file))) { dirty = true; continue; }
        const bytes = await readFile(file);
        const oid = createHash(head.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (oid !== entry.oid || Boolean(info.mode & 0o111) !== (entry.mode === '100755')) dirty = true;
      } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') dirty = true; else throw error; }
    }
    if ((await git(source, ['ls-files', '--others', '--exclude-standard', '-z'])).length) dirty = true;
    const branchValue = text(await git(source, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    let remote = null;
    const remoteResult = await run(gitBinary, [...GIT_FLAGS, '-C', source, 'config', '--get', 'remote.origin.url'], { cwd: source, env: scrubEnvironment(managed, managed) });
    const value = text(remoteResult.stdout).trim();
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
    if (match) remote = `https://github.com/${match[1]}/${match[2]}`;
    return { path: source, name: basename(source), head, branch: branchValue === 'HEAD' ? null : branchValue, dirty, remote };
  }
  async function prepare({ path, baseCommit, runId }) {
    await init();
    if (!ID.test(runId) || !COMMIT.test(baseCommit)) throw failure('Identificativo esecuzione o commit non valido.');
    const source = await inspect(path);
    if (source.head !== baseCommit) throw failure('Il commit del repository è cambiato. Aggiorna il progetto prima di avviare.', 'REPOSITORY_STALE_BASE', 409);
    const entries = await tree(source.path, baseCommit), runRoot = join(root, runId), cwd = join(runRoot, 'checkout');
    await mkdir(runRoot, { mode: 0o700 });
    try {
      await mkdir(cwd, { mode: 0o700 }); await mkdir(join(runRoot, 'home'), { mode: 0o700 }); await mkdir(join(cwd, '.fuori-runtime-tmp'), { mode: 0o700 });
      const rootTree = text(await git(source.path, ['rev-parse', `${baseCommit}^{tree}`])).trim();
      const objects = [...new Set([baseCommit, rootTree, ...entries.map(item => item.oid)])];
      const pack = await git(source.path, ['pack-objects', '--stdout'], { input: objects.join('\n') + '\n', maxBytes: maxSnapshotBytes + 8 * 1024 * 1024, timeoutMs: 60000 });
      await git(cwd, ['init', '-q', '--template=', `--object-format=${baseCommit.length === 64 ? 'sha256' : 'sha1'}`]);
      await git(cwd, ['index-pack', '--stdin'], { input: pack, timeoutMs: 60000 });
      await writeFile(join(cwd, '.git', 'shallow'), baseCommit + '\n', { mode: 0o600 });
      await git(cwd, ['update-ref', 'HEAD', baseCommit]);
      await git(cwd, ['reset', '--hard', baseCommit]);
      await mkdir(join(cwd, '.git', 'info'), { mode: 0o700 });
      await writeFile(join(cwd, '.git', 'info', 'exclude'), '/.fuori-runtime-tmp\n/node_modules\n', { mode: 0o600 });
      let dependencies = { status: 'not-needed', reason: 'Nessuna dipendenza Node dichiarata.' }, dependencyPath = null;
      const packageEntry = entries.find(item => item.path === 'package.json' && item.type === 'blob');
      if (packageEntry) {
        dependencies = { status: 'missing', reason: 'Dipendenze non installate nello snapshot. Nessuna installazione o accesso alla rete viene eseguito automaticamente.' };
        for (const lockName of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']) {
          if (!entries.some(item => item.path === lockName)) continue;
          try {
            const sourceModules = join(source.path, 'node_modules'), info = await lstat(sourceModules);
            if (!info.isDirectory() || info.isSymbolicLink()) continue;
            const unchanged = (await readFile(join(source.path, lockName))).equals(await readFile(join(cwd, lockName))) && (await readFile(join(source.path, 'package.json'))).equals(await readFile(join(cwd, 'package.json')));
            if (!unchanged) continue;
            dependencyPath = await realpath(sourceModules);
            await symlink(dependencyPath, join(cwd, 'node_modules'), 'dir');
            dependencies = { status: 'reused-read-only', reason: 'node_modules esistente riusato in sola lettura: manifest e lockfile coincidono con il commit. L’installazione non è stata ricostruita.' };
            break;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      // The caller may have committed while objects were copied. Never label a
      // snapshot as current after that race.
      if (text(await git(source.path, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== baseCommit) throw failure('Il commit è cambiato durante la preparazione.', 'REPOSITORY_STALE_BASE', 409);
      const gitConfigHash = hash(await readFile(join(cwd, '.git', 'config')));
      await writeFile(join(runRoot, 'runtime.json'), JSON.stringify({ version: 1, runId, cwd, baseCommit, gitConfigHash, dependencyPath, dependencies }), { mode: 0o600, flag: 'wx' });
      return { cwd, baseCommit, dependencies };
    } catch (error) { await rm(runRoot, { recursive: true, force: true }); throw error; }
  }
  async function managedRun(cwd) {
    await init();
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw failure('Ambiente repository non valido.');
    const absolute = resolve(cwd), runRoot = dirname(absolute), runId = basename(runRoot);
    if (!ID.test(runId) || runRoot !== join(root, runId) || basename(absolute) !== 'checkout') throw failure('Il percorso non appartiene agli ambienti gestiti.', 'REPOSITORY_PATH_DENIED', 403);
    for (const path of [runRoot, absolute, join(runRoot, 'runtime.json'), join(runRoot, 'home'), join(absolute, '.git'), join(absolute, '.fuori-runtime-tmp')]) if ((await lstat(path)).isSymbolicLink()) throw failure('Collegamento non consentito nell’ambiente.', 'REPOSITORY_PATH_DENIED', 403);
    if (!(await lstat(join(absolute, '.git'))).isDirectory()) throw failure('Directory Git dell’ambiente non valida.', 'REPOSITORY_PATH_DENIED', 403);
    if (await realpath(absolute) !== absolute) throw failure('Il percorso dell’ambiente è cambiato.', 'REPOSITORY_PATH_DENIED', 403);
    const metadata = JSON.parse(await readFile(join(runRoot, 'runtime.json'), 'utf8'));
    if (metadata.version !== 1 || metadata.cwd !== absolute || metadata.runId !== runId || !COMMIT.test(metadata.baseCommit)) throw failure('Metadati dell’ambiente non validi.');
    if (hash(await readFile(join(absolute, '.git', 'config'))) !== metadata.gitConfigHash) throw failure('La configurazione Git dell’ambiente è stata modificata.', 'REPOSITORY_BASE_CHANGED', 409);
    if (text(await git(absolute, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== metadata.baseCommit) throw failure('La base Git dell’ambiente è stata modificata.', 'REPOSITORY_BASE_CHANGED', 409);
    let totalFiles = 0, totalBytes = 0;
    const walk = async (folder, prefix = '') => {
      for (const item of await readdir(folder, { withFileTypes: true })) {
        const name = prefix + item.name;
        if (!prefix && ['.git', '.fuori-runtime-tmp'].includes(item.name)) continue;
        if (++totalFiles > maxFiles) throw failure('Troppi file nell’ambiente isolato.', 'REPOSITORY_TOO_LARGE', 413);
        safePath(name);
        if (protectedPath(name)) throw failure('L’ambiente contiene un file protetto non esportabile.', 'REPOSITORY_PROTECTED_PATH', 409);
        const target = join(folder, item.name);
        if (item.isSymbolicLink()) {
          if (name === 'node_modules' && metadata.dependencyPath && await realpath(target) === metadata.dependencyPath) continue;
          throw failure('Collegamenti simbolici nell’ambiente non consentiti.', 'REPOSITORY_UNSAFE_ENTRY', 409);
        }
        if (item.isDirectory()) await walk(target, name + '/');
        else if (!item.isFile()) throw failure('Tipo di file non consentito.', 'REPOSITORY_UNSAFE_ENTRY', 409);
        else { totalBytes += (await lstat(target)).size; if (totalBytes > maxSnapshotBytes) throw failure('L’ambiente isolato supera la dimensione massima.', 'REPOSITORY_TOO_LARGE', 413); }
      }
    };
    await walk(absolute);
    return { ...metadata, runRoot, home: join(runRoot, 'home'), temporary: join(absolute, '.fuori-runtime-tmp') };
  }
  function permissions(meta) {
    const filesystem = { ':root': 'deny', ':minimal': 'read', [meta.cwd]: 'write', [join(meta.cwd, '.git')]: 'read', [dirname(process.execPath)]: 'read' };
    if (meta.dependencyPath) filesystem[meta.dependencyPath] = 'read';
    return ['-c', `permissions.${PROFILE}.filesystem={${Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`, ...configArg(`permissions.${PROFILE}.network.enabled`, false)];
  }
  async function sandbox(meta, command, signal, options = {}) {
    return run(codexBinary, ['sandbox', '-P', PROFILE, ...permissions(meta), '-C', meta.cwd, '--', command.program, ...command.args], { cwd: meta.cwd, env: scrubEnvironment(meta.home, meta.temporary), signal, timeoutMs: checkTimeoutMs, maxBytes: maxOutputBytes, ...options });
  }
  async function preflight(meta, signal) {
    try {
      const result = await sandbox(meta, { program: '/usr/bin/true', args: [] }, signal, { timeoutMs: 15000, maxBytes: 16000 });
      if (result.exitCode !== 0) throw failure('Il sandbox Codex non è disponibile su questo computer. Aggiorna o configura il runtime: nessun comando è stato eseguito senza isolamento.', 'SANDBOX_UNAVAILABLE', 503);
    } catch (error) {
      if (error.code === 'REPOSITORY_ABORTED') throw error;
      if (error.code === 'SANDBOX_UNAVAILABLE') throw error;
      throw failure('Impossibile verificare il sandbox Codex. Nessun comando è stato avviato senza isolamento.', 'SANDBOX_UNAVAILABLE', 503);
    }
  }
  async function check({ cwd, command, signal }) {
    const clean = validateRepositoryCommand(command), started = Date.now(), meta = await managedRun(cwd);
    try {
      await preflight(meta, signal);
      const result = await sandbox(meta, clean, signal);
      await managedRun(cwd);
      return { ...clean, exitCode: result.exitCode, output: text(result.stdout) + text(result.stderr), durationMs: Date.now() - started, status: result.exitCode === 0 ? 'passed' : 'failed' };
    } catch (error) {
      if (error.code === 'REPOSITORY_ABORTED') throw error;
      return { ...clean, exitCode: null, output: error.message, durationMs: Date.now() - started, status: 'error', code: error.code || 'REPOSITORY_CHECK_ERROR' };
    }
  }
  async function edit({ cwd, prompt, signal }) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 120000) throw failure('Istruzioni di sviluppo non valide.');
    const meta = await managedRun(cwd); await preflight(meta, signal);
    if (active.has(cwd)) throw failure('Questo ambiente è già in esecuzione.', 'REPOSITORY_BUSY', 409);
    active.add(cwd); const started = Date.now();
    try {
      const env = scrubEnvironment(homedir(), meta.temporary, { auth: true });
      const childEnv = scrubEnvironment(meta.home, meta.temporary);
      const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json', '--color', 'never', ...configArg('default_permissions', PROFILE), ...permissions(meta), ...configArg('approval_policy', 'never'), ...configArg('allow_login_shell', false), ...configArg('web_search', 'disabled'), ...configArg('features.apps', false), ...configArg('features.plugins', false), ...configArg('features.multi_agent', false), ...configArg('shell_environment_policy.inherit', 'none'), '-c', `shell_environment_policy.set={${Object.entries(childEnv).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`, ...configArg(`projects.${JSON.stringify(meta.cwd)}.trust_level`, 'untrusted'), '-C', meta.cwd, '-'];
      const result = await run(codexBinary, args, { cwd: meta.cwd, env, input: prompt, signal, timeoutMs: editTimeoutMs, maxBytes: 4 * 1024 * 1024 });
      if (result.exitCode !== 0) throw failure('Codex non ha completato le modifiche. L’ambiente isolato è conservato per la revisione.', 'REPOSITORY_EDIT_FAILED', 502);
      let reply = '', usage = null;
      for (const line of text(result.stdout).split('\n')) {
        try { const event = JSON.parse(line); if (event.type === 'item.completed' && event.item?.type === 'agent_message') reply = event.item.text || reply; if (event.type === 'turn.completed' && event.usage) usage = { inputTokens: Number.isSafeInteger(event.usage.input_tokens) && event.usage.input_tokens >= 0 ? event.usage.input_tokens : null, outputTokens: Number.isSafeInteger(event.usage.output_tokens) && event.usage.output_tokens >= 0 ? event.usage.output_tokens : null }; } catch {}
      }
      if (!reply.trim() || reply.length > 128000) throw failure('Codex non ha restituito una consegna valida.', 'REPOSITORY_EDIT_FAILED', 502);
      await managedRun(cwd);
      return { text: reply, usage, durationMs: Date.now() - started };
    } finally { active.delete(cwd); }
  }
  async function diff({ cwd, baseCommit }) {
    const meta = await managedRun(cwd);
    if (baseCommit !== meta.baseCommit) throw failure('Il diff deve riferirsi al commit originale.', 'REPOSITORY_STALE_BASE', 409);
    const index = join(meta.runRoot, `index-${randomUUID()}`), env = { ...scrubEnvironment(meta.home, meta.temporary), GIT_INDEX_FILE: index };
    const options = { env, maxBytes: maxPatchBytes, timeoutMs: 30000 };
    try {
      await git(cwd, ['read-tree', baseCommit], options);
      await git(cwd, ['add', '-A', '--', '.'], options);
      const nums = text(await git(cwd, ['diff', '--cached', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', baseCommit, '--'], options)).split('\0').filter(Boolean);
      const counts = new Map();
      for (const line of nums) { const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(line); if (!match || match[1] === '-' || match[2] === '-') throw failure('Il diff contiene file binari: esportazione testuale non disponibile.', 'REPOSITORY_BINARY_DIFF', 409); counts.set(safePath(match[3]), { additions: Number(match[1]), deletions: Number(match[2]) }); }
      const names = text(await git(cwd, ['diff', '--cached', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', baseCommit, '--'], options)).split('\0').filter(Boolean), files = [];
      for (let i = 0; i < names.length; i += 2) { if (!['A', 'M', 'D'].includes(names[i])) throw failure('Il diff contiene una modifica di tipo non supportata.', 'REPOSITORY_UNSAFE_ENTRY', 409); const path = safePath(names[i + 1]); files.push({ path, status: names[i], ...(counts.get(path) || { additions: 0, deletions: 0 }) }); }
      if (files.length > maxFiles) throw failure('Troppi file modificati.', 'REPOSITORY_TOO_LARGE', 413);
      const patch = text(await git(cwd, ['diff', '--cached', '--patch', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', baseCommit, '--'], options));
      return { patch, files, hash: hash(patch), stats: { files: files.length, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) }, truncated: false };
    } finally { await unlink(index).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { inspect, prepare, edit, check, diff };
}
