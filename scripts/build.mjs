import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('public', { recursive: true });
await Promise.all([
  copyFile('index.html', 'public/index.html'),
  copyFile('auth.css', 'public/auth.css')
]);
await build({
  entryPoints: ['app.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  outfile: 'public/auth.bundle.js'
});
console.log('Built public member-access frontend.');
