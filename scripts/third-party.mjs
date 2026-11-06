// Erzeugt THIRD_PARTY_NOTICES.md aus den tatsächlich installierten npm-Paketen (Produktionsabhängigkeiten)
// und den Rust-Crates des Builds (cargo metadata). Vor jedem Release erneut ausführen.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const npmTree = JSON.parse(execSync('npm ls --omit=dev --all --json --long', { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }));
const npm = new Map();
(function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    if (!info.version || info.missing) continue; // nicht installierte optionale Plattformpakete
    const key = `${name}@${info.version}`;
    if (!npm.has(key)) {
      const pj = join(info.path ?? join(root, 'node_modules', name), 'package.json');
      let license = 'unbekannt';
      try { const p = JSON.parse(readFileSync(pj, 'utf8')); license = typeof p.license === 'string' ? p.license : p.license?.type ?? 'unbekannt'; } catch {}
      npm.set(key, { name, version: info.version, license });
    }
    walk(info.dependencies);
  }
})(npmTree.dependencies);

const meta = JSON.parse(execSync('cargo metadata --format-version 1 --manifest-path src-tauri/Cargo.toml --filter-platform x86_64-pc-windows-msvc', { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 }));
const ws = new Set(meta.workspace_members);
const crates = meta.packages.filter((p) => !ws.has(p.id)).map((p) => ({ name: p.name, version: p.version, license: p.license ?? (p.license_file ? `siehe ${p.license_file}` : 'unbekannt') }));
crates.sort((a, b) => a.name.localeCompare(b.name));
const npmList = [...npm.values()].sort((a, b) => a.name.localeCompare(b.name));

const count = (list) => Object.entries(list.reduce((m, x) => ((m[x.license] = (m[x.license] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}: ${n}`).join(', ');
const table = (list) => ['| Paket | Version | Lizenz |', '|---|---|---|', ...list.map((x) => `| ${x.name} | ${x.version} | ${x.license} |`)].join('\n');
const out = `# Drittanbieter-Komponenten

Automatisch erzeugt mit \`node scripts/third-party.mjs\` am ${new Date().toISOString().slice(0, 10)}. Dieses Inventar ist die Grundlage der Lizenzprüfung (Spezifikation §9.2) und muss vor jedem Release mit dem tatsächlich ausgelieferten Build neu erzeugt und geprüft werden. Es ersetzt keine rechtliche Prüfung.

## Gebündelte Assets

| Asset | Herkunft | Lizenz | Hinweis |
|---|---|---|---|
| DejaVu Sans (\`public/fonts/DejaVuSans.ttf\`) | npm \`dejavu-fonts-ttf\` | Bitstream Vera / DejaVu-Lizenz (frei, Einbettung erlaubt) | Lizenztext liegt als \`public/fonts/DejaVu-LICENSE.txt\` bei und wird mitgeliefert |
| PDF.js CMaps, Standardschriften, WASM-Decoder, ICC-Profile (\`public/pdfjs/\`) | npm \`pdfjs-dist\` | Apache-2.0 (Projekt); einzelne Ressourcen mit eigenen Hinweisen | Hinweise aus \`node_modules/pdfjs-dist\` übernehmen |
| Icons (lucide-react) | npm \`lucide-react\` | ISC | |
| App-Icon | eigene Gestaltung (\`scripts/make-icon.mjs\`) | Projekt | |
| Microsoft Edge WebView2 Runtime (Offline-Installer) | Microsoft | Microsoft-Lizenzbedingungen | Redistributionsform prüfen: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution |

## Lizenzübersicht

- npm (Produktion, ${npmList.length} Pakete): ${count(npmList)}
- Rust-Crates (Windows-Ziel, ${crates.length} Crates): ${count(crates)}

## npm-Pakete (Produktion)

${table(npmList)}

## Rust-Crates (Ziel x86_64-pc-windows-msvc)

${table(crates)}
`;
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), out);
console.log(`THIRD_PARTY_NOTICES.md: ${npmList.length} npm-Pakete, ${crates.length} Crates`);
console.log('npm:', count(npmList));
console.log('crates:', count(crates));
