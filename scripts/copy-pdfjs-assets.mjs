// Kopiert die für den Offline-Betrieb nötigen PDF.js-Ressourcen (CMaps, Standardschriften,
// WASM-Decoder, ICC-Profile) sowie die gebündelte Schrift nach public/. Keine Netzwerkzugriffe.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pdfjs = join(root, 'node_modules', 'pdfjs-dist');
const target = join(root, 'public', 'pdfjs');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = join(pdfjs, dir);
  if (existsSync(src)) cpSync(src, join(target, dir), { recursive: true });
}
const fontsTarget = join(root, 'public', 'fonts');
mkdirSync(fontsTarget, { recursive: true });
cpSync(join(root, 'node_modules', 'dejavu-fonts-ttf', 'ttf', 'DejaVuSans.ttf'), join(fontsTarget, 'DejaVuSans.ttf'));
cpSync(join(root, 'node_modules', 'dejavu-fonts-ttf', 'LICENSE'), join(fontsTarget, 'DejaVu-LICENSE.txt'));
console.log('PDF.js-Ressourcen und Schrift nach public/ kopiert.');
