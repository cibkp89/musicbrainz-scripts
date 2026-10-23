# MusicBrainz Scripts

🇬🇧 [English version](README.md)

Userscripts, die das Anlegen von Werken (Works) in [MusicBrainz](https://musicbrainz.org) aus den Datenbanken der Verwertungsgesellschaften **AKM** (Österreich) und **GEMA** (Deutschland) erleichtern.

Die Scripte lesen Werkdaten und Beteiligte aus, suchen die passenden Artists (und bei GEMA optional Verlage) per **IPI** in MusicBrainz und öffnen anschließend ein vorausgefülltes `/work/create`-Formular inklusive Beziehungen. Gespeichert wird nichts automatisch – das Werk wird erst angelegt, wenn du es in MusicBrainz selbst abschickst.

## Installation

1. Einen Userscript-Manager installieren, z. B. [Tampermonkey](https://www.tampermonkey.net/) oder [Violentmonkey](https://violentmonkey.github.io/).
2. Auf den Installationslink des gewünschten Scripts klicken:

| Script | Installieren |
|---|---|
| AKM Work Importer | [akm-work-importer.user.js](https://raw.githubusercontent.com/cibkp89/musicbrainz-scripts/main/akm-work-importer.user.js) |
| GEMA Work Importer | [gema-work-importer.user.js](https://raw.githubusercontent.com/cibkp89/musicbrainz-scripts/main/gema-work-importer.user.js) |

Updates werden vom Userscript-Manager automatisch aus diesem Repository geladen.

## AKM Work Importer

**Läuft auf:** AKM/AUME-Werksuche (`akm-aume.at/akm-webapp`) und MusicBrainz `/work/create`

- Fügt bei jeder Werkversion einen Button **„🎵 Werk anlegen“** ein.
- Liest Titel, ISWC, AKM-Werknummer und die AR-Berechtigten (Komponist, Textdichter, Arrangeur) aus.
- Sucht jede Person per IPI in MusicBrainz; bei mehreren oder keinen Treffern kann manuell per Name oder MBID gesucht werden.
- Werktitel und Lyricsprache lassen sich vor dem Öffnen korrigieren (AKM liefert Titel meist in Großbuchstaben).
- Öffnet MusicBrainz mit vorausgefülltem Titel, ISWC, Sprache, Werktyp, AKM-Werknummer als Attribut, Edit-Note und den Artist-Beziehungen.

## GEMA Work Importer

**Läuft auf:** GEMA-Repertoiresuche (`portal.gema.de/app/repertoiresuche/werksuche`) und MusicBrainz `/work/create`

- Fügt in der Trefferliste einen Button **„🎵 MusicBrainz“** ein.
- Liest Titel, ISWC, GEMA-Werkfassungsnummer, Sprache und Beteiligte aus.
- Personen mit mehreren Rollen (z. B. Komponist und Textdichter) werden getrennt behandelt, aber nur einmal gesucht.
- Importoptionen für Personen:
  - **GEMA-Rollen übernehmen** (Komponist/Textdichter)
  - **Alle als Verfasser** (writer, dedupliziert)
  - **Manuell pro Person**
- Originalverlage können optional als MusicBrainz-Label mit „publishing“-Beziehung übernommen werden.
- Die Sprache wird aus den GEMA-Daten vorausgewählt.
- MusicBrainz-Anfragen werden auf ca. 1 pro Sekunde gedrosselt; IPI-Ergebnisse der letzten 10 Suchen werden zwischengespeichert (praktisch bei Alben mit immer denselben Beteiligten).

## Hinweise

- Die Scripte nutzen nur öffentliche Daten der AKM- bzw. GEMA-Suche und die öffentliche MusicBrainz-API. Ein Login ist nicht nötig.
- Popups für `musicbrainz.org` müssen erlaubt sein, da das Formular in einem neuen Tab geöffnet wird.
- Vor dem Abschicken bitte immer alle Daten in MusicBrainz prüfen – IPI-Treffer sind meist, aber nicht immer eindeutig.
- Ändern AKM oder GEMA ihre Webseiten, können die Scripte ohne Vorwarnung aufhören zu funktionieren.

## Lizenz

[MIT](LICENSE)
