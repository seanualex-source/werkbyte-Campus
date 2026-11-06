// Gebündelte Schrift und deren Metriken. Editor, Thumbnails und Export verwenden dieselben
// Fontdaten (DejaVu Sans), damit Umbrüche und Glyphenprüfung übereinstimmen.

import fontkit from '@pdf-lib/fontkit';

export const FONT_FAMILY = 'CampusSans';
export const FONT_URL = 'fonts/DejaVuSans.ttf';

export interface FontMetrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  /** Breite in Punkt für eine Schriftgröße; identisch zu pdf-lib `widthOfTextAtSize`. */
  width(text: string, size: number): number;
  hasGlyph(codePoint: number): boolean;
}

export function createMetrics(bytes: Uint8Array): FontMetrics {
  const font = fontkit.create(bytes);
  const cache = new Map<string, number>();
  const advanceUnits = (text: string): number => {
    let v = cache.get(text);
    if (v === undefined) {
      const run = font.layout(text);
      v = 0;
      for (const g of run.glyphs) v += g.advanceWidth;
      if (cache.size > 20000) cache.clear();
      cache.set(text, v);
    }
    return v;
  };
  return {
    unitsPerEm: font.unitsPerEm,
    ascent: font.ascent,
    descent: font.descent,
    width: (text, size) => (advanceUnits(text) * size) / font.unitsPerEm,
    hasGlyph: (cp) => font.hasGlyphForCodePoint(cp),
  };
}

/** Liefert Zeichen, die die eingebettete Schrift nicht darstellen kann (ohne Steuerzeichen). */
export function missingGlyphs(text: string, m: FontMetrics): string[] {
  const missing = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 10 || cp === 13 || cp === 9) continue;
    if (!m.hasGlyph(cp)) missing.add(ch);
  }
  return [...missing];
}

let loaded: Promise<{ bytes: Uint8Array; metrics: FontMetrics }> | null = null;

/** Lädt die Schrift aus dem lokalen App-Bundle (kein Netzwerk) und registriert sie für Canvas/DOM. */
export function loadBundledFont(): Promise<{ bytes: Uint8Array; metrics: FontMetrics }> {
  if (!loaded) {
    loaded = (async () => {
      const res = await fetch(new URL(FONT_URL, document.baseURI).href);
      if (!res.ok) throw new Error('Gebündelte Schrift konnte nicht geladen werden.');
      const bytes = new Uint8Array(await res.arrayBuffer());
      const face = new FontFace(FONT_FAMILY, bytes.slice().buffer);
      await face.load();
      (document.fonts as unknown as { add(f: FontFace): void }).add(face);
      return { bytes, metrics: createMetrics(bytes) };
    })();
  }
  return loaded;
}
