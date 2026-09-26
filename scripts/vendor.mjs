import { mkdir, copyFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/vendor/', root), { recursive: true });
for (const filename of ['three.module.js', 'three.core.js']) {
  await copyFile(new URL('node_modules/three/build/' + filename, root), new URL('dist/vendor/' + filename, root));
}
await copyFile(new URL('node_modules/three/LICENSE', root), new URL('dist/vendor/THREE-LICENSE.txt', root));
console.log('Motore 3D disponibile localmente.');
