# MusicBrainz Scripts

🇩🇪 [Deutsche Version](README.de.md)

Userscripts that make it easier to add works to [MusicBrainz](https://musicbrainz.org) using data from the Austrian and German performing rights societies **AKM** and **GEMA**.

The scripts read work data and contributors, look up matching artists (and, for GEMA, optionally publishers) in MusicBrainz by **IPI**, and then open a pre-filled `/work/create` form including relationships. Nothing is submitted automatically – the work is only created once you submit the form in MusicBrainz yourself.

## Installation

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Click the install link for the script you want:

| Script | Install |
|---|---|
| AKM Work Importer | [akm-work-importer.user.js](https://raw.githubusercontent.com/cibkp89/musicbrainz-scripts/main/akm-work-importer.user.js) |
| GEMA Work Importer | [gema-work-importer.user.js](https://raw.githubusercontent.com/cibkp89/musicbrainz-scripts/main/gema-work-importer.user.js) |

Your userscript manager will fetch updates from this repository automatically.

## AKM Work Importer

**Runs on:** AKM/AUME work search (`akm-aume.at/akm-webapp`) and MusicBrainz `/work/create`

- Adds a **“🎵 Werk anlegen”** button to every work version.
- Reads the title, ISWC, AKM work number and the AR rights holders (composer, lyricist, arranger).
- Looks up each person in MusicBrainz by IPI; if there are several matches or none, you can search manually by name or MBID.
- Title and lyrics language can be corrected before opening MusicBrainz (AKM usually lists titles in upper case).
- Opens MusicBrainz with title, ISWC, language, work type, AKM work number as a work attribute, edit note and artist relationships pre-filled.

## GEMA Work Importer

**Runs on:** GEMA repertoire search (`portal.gema.de/app/repertoiresuche/werksuche`) and MusicBrainz `/work/create`

- Adds a **“🎵 MusicBrainz”** button to each search result.
- Reads the title, ISWC, GEMA work ID, language and contributors.
- People with multiple roles (e.g. composer and lyricist) are handled separately but only looked up once.
- Import options for people:
  - **Keep GEMA roles** (composer/lyricist)
  - **Everyone as writer** (deduplicated)
  - **Choose manually per person**
- Original publishers can optionally be added as MusicBrainz labels with a “publishing” relationship.
- The lyrics language is pre-selected from the GEMA data.
- MusicBrainz requests are throttled to about one per second; IPI results of the last 10 lookups are cached (handy for albums with the same contributors throughout).

## Notes

- The scripts only use publicly available data from the AKM and GEMA search pages and the public MusicBrainz API. No login is required.
- Pop-ups must be allowed for `musicbrainz.org`, as the form opens in a new tab.
- Always review all data in MusicBrainz before submitting – IPI matches are usually, but not always, unambiguous.
- The user interface of the scripts is in German.
- If AKM or GEMA change their websites, the scripts may stop working without notice.

## License

[MIT](LICENSE)
