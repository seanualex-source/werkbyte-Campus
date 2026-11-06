# ADR 0002: Nativer Seitenraum und Darstellungsmatrix

**Status:** angenommen · **Datum:** 2026-11-06

## Entscheidung
Alle eigenen Objekte liegen im nativen Seitenraum: Punkte, Ursprung oben links der sichtbaren, ungedrehten CropBox, y nach unten. Ursprüngliche PDF-Rotation (`intrinsicRotation`) und Nutzerdrehung (`pages.rotation`) sind reine Darstellungstransformationen. Eine einzige Matrixfunktion (`displayMatrix`) bildet den nativen Raum in den Darstellungsraum ab; Eingaben werden über die inverse Matrix zurückgerechnet. Der Export nutzt `pdfUserSpaceMatrix(cropX, cropY, height, userUnit)` und setzt `/Rotate` auf die Gesamtdrehung.

Text- und Bildobjekte tragen zusätzlich `orient` (0/90/180/270): die Darstellungsdrehung zum Zeitpunkt der Erstellung. Der Inhalt wird im lokalen Rahmen gegengedreht und erscheint dadurch auf dem Bildschirm aufrecht. Dreht der Nutzer die Seite später, dreht sich der Inhalt mit, wie auf Papier. Frei rotierbare Einzelobjekte bleiben außerhalb des MVP.

## Folgen
Annotationen bleiben nach Sortieren, Drehen, Duplizieren und Zusammenführen an der richtigen Stelle, weil sie sich nie auf Darstellungskoordinaten beziehen. Property-Tests prüfen Punkt → Darstellung → Punkt für alle Drehungen und Zoomstufen; Golden-Tests prüfen den Export pixelgenau.
