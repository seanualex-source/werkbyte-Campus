// Zeichnet Primitive auf einen Canvas-Kontext, der bereits auf den nativen Seitenraum transformiert ist.

import { FONT_FAMILY } from './fonts';
import type { Prim } from './primitives';

export type ImageLookup = (hash: string) => CanvasImageSource | null;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawPrims(ctx: Ctx, prims: Prim[], images: ImageLookup, fontFamily = FONT_FAMILY) {
  for (const p of prims) {
    switch (p.t) {
      case 'line': {
        ctx.save();
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.width;
        ctx.beginPath();
        ctx.moveTo(p.x1, p.y1);
        ctx.lineTo(p.x2, p.y2);
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'poly': {
        if (p.pts.length < 6) break;
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.globalCompositeOperation = p.blend === 'multiply' ? 'multiply' : 'source-over';
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.pts[0], p.pts[1]);
        for (let i = 2; i < p.pts.length; i += 2) ctx.lineTo(p.pts[i], p.pts[i + 1]);
        ctx.closePath();
        ctx.fill('nonzero');
        ctx.restore();
        break;
      }
      case 'text': {
        ctx.save();
        ctx.transform(...p.frame);
        ctx.fillStyle = p.color;
        ctx.font = `${p.size}px "${fontFamily}"`;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        if ('fontKerning' in ctx) (ctx as CanvasRenderingContext2D).fontKerning = 'none';
        for (const line of p.lines) if (line.text) ctx.fillText(line.text, line.x, line.baseline);
        ctx.restore();
        break;
      }
      case 'image': {
        const img = images(p.hash);
        ctx.save();
        ctx.transform(...p.frame);
        if (img) {
          ctx.globalAlpha = p.alpha;
          ctx.drawImage(img, 0, 0, p.width, p.height);
        } else {
          ctx.fillStyle = 'rgba(120,130,145,0.15)';
          ctx.fillRect(0, 0, p.width, p.height);
        }
        ctx.restore();
        break;
      }
    }
  }
}
