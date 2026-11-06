// Gemeinsamer Textlayoutdienst: Zeilenumbruch mit den Metriken der eingebetteten Schrift.
// Ergebnis wird identisch für Canvas-Vorschau und PDF-Export verwendet.

import type { FontMetrics } from './fonts';
import type { TextAlign } from '../domain/types';

export interface LaidLine {
  text: string;
  x: number;
  baseline: number;
  width: number;
}

export interface TextLayout {
  lines: LaidLine[];
  height: number;
  lineBox: number;
}

export interface LayoutInput {
  text: string;
  width: number;
  fontSize: number;
  lineHeight: number;
  align: TextAlign;
}

function breakLongWord(word: string, maxW: number, size: number, m: FontMetrics): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const ch of word) {
    if (cur && m.width(cur + ch, size) > maxW) {
      parts.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

export function layoutText(input: LayoutInput, m: FontMetrics): TextLayout {
  const { fontSize: size, lineHeight, align } = input;
  const maxW = Math.max(1, input.width);
  const lineBox = size * lineHeight;
  const raw: string[] = [];
  const text = input.text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  for (const para of text.split('\n')) {
    if (para === '') {
      raw.push('');
      continue;
    }
    const tokens = para.match(/\s+|\S+/g) ?? [];
    let line = '';
    for (const tok of tokens) {
      const isSpace = /^\s+$/.test(tok);
      const candidate = line + tok;
      if (m.width(candidate.trimEnd(), size) <= maxW || line === '') {
        if (!isSpace && line === '' && m.width(tok, size) > maxW) {
          const pieces = breakLongWord(tok, maxW, size, m);
          for (let i = 0; i < pieces.length - 1; i++) raw.push(pieces[i]);
          line = pieces[pieces.length - 1];
        } else {
          line = isSpace && line === '' ? '' : candidate;
        }
      } else if (isSpace) {
        raw.push(line.trimEnd());
        line = '';
      } else {
        raw.push(line.trimEnd());
        if (m.width(tok, size) > maxW) {
          const pieces = breakLongWord(tok, maxW, size, m);
          for (let i = 0; i < pieces.length - 1; i++) raw.push(pieces[i]);
          line = pieces[pieces.length - 1];
        } else {
          line = tok;
        }
      }
    }
    raw.push(line.trimEnd());
  }
  const ascent = (m.ascent / m.unitsPerEm) * size;
  const descent = (m.descent / m.unitsPerEm) * size; // negativ
  const glyphBox = ascent - descent;
  const lines: LaidLine[] = raw.map((t, i) => {
    const w = m.width(t, size);
    const x = align === 'center' ? (maxW - w) / 2 : align === 'right' ? maxW - w : 0;
    const baseline = i * lineBox + (lineBox - glyphBox) / 2 + ascent;
    return { text: t, x, baseline, width: w };
  });
  return { lines, height: Math.max(lineBox, lines.length * lineBox), lineBox };
}
