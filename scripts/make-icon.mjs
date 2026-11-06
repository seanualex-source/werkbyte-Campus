// Erzeugt das App-Icon (eigene, schlichte Gestaltung: Seite mit Eselsohr und Stiftstrich).
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
const S = 1024, c = createCanvas(S, S), g = c.getContext('2d');
const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
const grad = g.createLinearGradient(0, 0, S, S); grad.addColorStop(0, '#1E5AA8'); grad.addColorStop(1, '#123A70');
rr(64, 64, 896, 896, 200); g.fillStyle = grad; g.fill();
// Hinteres Blatt
g.save(); g.translate(512, 520); g.rotate(-0.12); g.fillStyle = 'rgba(255,255,255,0.35)'; rr(-250, -330, 470, 620, 36); g.fill(); g.restore();
// Vorderes Blatt mit Eselsohr
g.fillStyle = '#FFFFFF'; g.beginPath(); g.moveTo(300, 230); g.lineTo(640, 230); g.lineTo(740, 330); g.lineTo(740, 800); g.quadraticCurveTo(740, 830, 710, 830); g.lineTo(330, 830); g.quadraticCurveTo(300, 830, 300, 800); g.closePath(); g.fill();
g.fillStyle = '#D6E2F2'; g.beginPath(); g.moveTo(640, 230); g.lineTo(640, 330); g.lineTo(740, 330); g.closePath(); g.fill();
// Linien
g.strokeStyle = '#C3D0E2'; g.lineWidth = 18; g.lineCap = 'round';
for (const y of [420, 500, 580]) { g.beginPath(); g.moveTo(370, y); g.lineTo(670, y); g.stroke(); }
// Stiftstrich (Akzent)
g.strokeStyle = '#F2A516'; g.lineWidth = 34; g.beginPath(); g.moveTo(370, 700); g.bezierCurveTo(440, 640, 500, 760, 560, 690); g.bezierCurveTo(600, 645, 640, 690, 680, 670); g.stroke();
writeFileSync(process.argv[2] ?? 'app-icon.png', c.toBuffer('image/png'));
