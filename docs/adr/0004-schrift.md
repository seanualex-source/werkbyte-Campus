# ADR 0004: Eine gebündelte Schrift für Editor, Layout und Export

**Status:** angenommen · **Datum:** 2026-11-06

## Entscheidung
DejaVu Sans (`bundled-font-regular-v1`) wird lokal mitgeliefert und in Canvas, Textfeld und PDF-Export verwendet. Gründe: breite Abdeckung (Umlaute, Griechisch, viele mathematische Zeichen wie ∫ ∑ ≤ π), freie Lizenz mit erlaubter Einbettung, keine Remote-Fonts.

Ein gemeinsamer Layoutdienst bricht Zeilen mit den Metriken genau dieser Schrift um. Die Breitenberechnung entspricht der von pdf-lib (`widthOfTextAtSize`), Kerning ist in Vorschau und Export deaktiviert. Vor dem Export wird jedes Zeichen gegen die Schrift geprüft; fehlende Glyphen brechen den Export mit Meldung ab (`GLYPH_MISSING`) statt Kästchen zu erzeugen.

## Grenzen
CJK-Schriftzeichen und manche Spezialsymbole fehlen in DejaVu Sans. Eine zweite Fallback-Schrift wäre eine eigene Entscheidung (Größe, Lizenz).
