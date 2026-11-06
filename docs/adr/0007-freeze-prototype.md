# ADR 0007: `freezePrototype` deaktiviert

**Status:** angenommen · **Datum:** 2026-11-06

## Kontext
Tauris Option `app.security.freezePrototype` friert `Object.prototype` ein und erschwert Prototype-Pollution. Beim Test der echten Desktop-App brach fontkit (Abhängigkeit für Schrifteinbettung und Textmetriken) beim Laden mit „Attempted to assign to readonly property“ ab: Bibliotheken, die per Zuweisung Eigenschaften wie `toString` überschreiben, scheitern an eingefrorenen Prototypen. Die Oberfläche blieb leer. Dasselbe Verhalten ist unter WebView2 zu erwarten.

## Entscheidung
`freezePrototype` ist deaktiviert.

## Ausgleich
Keine Remote-Inhalte, strenge Produktions-CSP (nur eigene Skripte und Worker, kein `eval`, keine Netzwerkziele außer IPC), Texte werden nie als HTML gerendert, PDF-Skripte werden nicht ausgeführt, Backend validiert jede Eingabe unabhängig von der Oberfläche. Eine spätere Reaktivierung erfordert eine fontkit-Alternative oder einen Patch und einen Test der echten App.
