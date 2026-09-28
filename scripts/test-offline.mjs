import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Socket-based integration fixtures belong in *-http.test.mjs. The legacy
// integration.test.mjs also starts a server. npm test always includes both.
// This subset needs filesystem/process access, but no listening network socket.
const root = fileURLToPath(new URL('..', import.meta.url));
const files = (await readdir(new URL('../test/', import.meta.url)))
  .filter(name => name.endsWith('.test.mjs') && !name.endsWith('-http.test.mjs') && name !== 'integration.test.mjs')
  .sort()
  .map(name => `test/${name}`);
if (!files.length) throw Error('No offline tests were found.');
const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
