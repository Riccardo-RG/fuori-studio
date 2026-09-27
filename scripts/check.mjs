import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.filter(entry => entry.name !== 'vendor').map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(mjs|js)$/.test(entry.name) ? [path] : [];
  }));
  return paths.flat();
}
const targets = ['server.mjs', ...(await Promise.all(['lib', 'dist', 'scripts', 'test'].map(files))).flat()];
for (const path of targets) {
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${targets.length} modules.`);
