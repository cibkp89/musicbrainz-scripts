// ==UserScript==
// @name         GEMA Work Importer for MusicBrainz
// @namespace    gema-work-importer
// @version      0.4.3
// @description  GEMA Repertoiresuche: Artists und Originalverlage per IPI mit MusicBrainz matchen und GEMA-Werk als neues MusicBrainz-Werk anlegen
// @author       cibkp89
// @license      MIT
// @homepageURL  https://github.com/cibkp89/musicbrainz-scripts
// @supportURL   https://github.com/cibkp89/musicbrainz-scripts/issues
// @updateURL    https://raw.githubusercontent.com/cibkp89/musicbrainz-scripts/main/gema-work-importer.user.js
// @downloadURL  https://raw.githubusercontent.com/cibkp89/musicbrainz-scripts/main/gema-work-importer.user.js
// @match        https://portal.gema.de/app/repertoiresuche/werksuche*
// @match        https://musicbrainz.org/work/create*
// @match        https://*.musicbrainz.org/work/create*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @connect      musicbrainz.org
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    mbLanguageId: '145',
    mbGemaAttributeTypeId: '9',
    mbWorkTypeId: '17',
  };

  const GEMA_ROLE_MAP = {
    'Komponist/-in': 'composer',
    'Komponist/in': 'composer',
    'Komponist': 'composer',
    'Textdichter/-in': 'lyricist',
    'Textdichter/in': 'lyricist',
    'Textdichter': 'lyricist',
  };

  const GM_PREFIX = 'gema-work:';
  const MB_PREFIX = 'gema-work-import:';
  const IPI_CACHE_KEY = GM_PREFIX + 'ipi-cache';
  const IPI_CACHE_MAX = 10;
  const MB_MIN_REQUEST_GAP_MS = 1100; // MusicBrainz erlaubt ~1 req/s für unauthentifizierte Nutzung.

  function stripText(el) {
    return (el && el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getResultInfo(row) {
    const title = stripText(row.querySelector('.cdk-column-titel'));
    const gemaId = stripText(row.querySelector('.cdk-column-werkfassungsnummer'));
    return { title, gemaId };
  }

  function getExpandedDetails(row) {
    const detailsRow = row.nextElementSibling;
    if (!detailsRow || !detailsRow.matches('tr.expanded-row.details')) return null;
    return detailsRow.querySelector('[data-selector="werk-details"]');
  }

  function extractGemaData(row) {
    const info = getResultInfo(row);
    const details = getExpandedDetails(row);
    if (!details) return { ...info, roles: [], publishers: [], iswc: '', language: '' };

    const roles = [];
    details.querySelectorAll('tr[data-selector="beteiligte-row"]').forEach((r) => {
      const cells = r.querySelectorAll('td');
      if (cells.length < 3) return;
      const name = stripText(cells[0]);
      const ipi = stripText(cells[1]);
      const roleText = stripText(cells[2]);
      if (!name || !roleText) return;
      // GEMA listet bei einer Person manchmal mehrere Rollen kommagetrennt
      // in einer Zelle (z. B. "Komponist/-in, Textdichter/-in"). Für den
      // MusicBrainz-Import wird daraus je Rolle ein eigener Eintrag, damit
      // Komponist und Textdichter getrennt gematcht/zugeordnet werden
      // können. Die MusicBrainz-Suche pro IPI wird dabei automatisch
      // gecacht/gebündelt (siehe resolveByIpiCached), es wird also nicht
      // doppelt gesucht.
      roleText.split(',').forEach((part) => {
        const role = part.trim();
        if (role) roles.push({ role, name, ipi });
      });
    });

    const publishers = roles
      .filter((r) => /^(Originalverlag|Verlag)$/i.test(r.role))
      .map((r) => ({ name: r.name, ipi: r.ipi, role: r.role }));

    const iswc = stripText(details.querySelector('[data-selector="werkinformation-iswc"]'));
    const language = stripText(details.querySelector('[data-selector="werkinformation-sprache"]'));
    return { ...info, roles, publishers, iswc, language };
  }

  async function ensureDetailsExpanded(row) {
    if (getExpandedDetails(row)) return getExpandedDetails(row);
    const expand = row.querySelector('[data-selector="expansion-collapse-button"]');
    if (expand) {
      expand.click();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const details = getExpandedDetails(row);
        if (details) return details;
      }
    }
    return getExpandedDetails(row);
  }

  // -------------------------------------------------------------------------
  // MusicBrainz API helpers. They run on GEMA, before we navigate to MB.
  // -------------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // Serialisiert alle Requests gegen die MusicBrainz-API. MusicBrainz
  // erlaubt für unauthentifizierte Zugriffe nur ~1 Request/Sekunde;
  // ohne diese Warteschlange würden z. B. 5 Beteiligte + 2 Verlage
  // gleichzeitig 7 parallele Requests auslösen und riskieren, dass die
  // IP kurzzeitig gedrosselt/gesperrt wird.
  // ---------------------------------------------------------------------
  let mbQueueTail = Promise.resolve();
  let mbLastRequestAt = 0;

  function mbThrottledFetch(url) {
    const run = () => new Promise((resolve) => {
      const wait = Math.max(0, MB_MIN_REQUEST_GAP_MS - (Date.now() - mbLastRequestAt));
      setTimeout(() => {
        mbLastRequestAt = Date.now();
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers: {
            Accept: 'application/json',
            // MusicBrainz' API-Etikette verlangt einen aussagekräftigen
            // User-Agent (App + Version + Kontakt), sonst landet man
            // schneller auf der Drossel-Liste. Bitte ggf. Kontakt anpassen.
              'User-Agent': 'gema-work-importer/0.4.3 ( https://github.com/cibkp89/musicbrainz-scripts )',
          },
          timeout: 10000,
          onload: (r) => {
            if (r.status >= 200 && r.status < 300) {
              try { resolve(JSON.parse(r.responseText)); } catch (_) { resolve(null); }
            } else if (r.status === 503) {
              console.warn('[GEMA-Import] MusicBrainz 503 (Rate Limit?) für', url);
              resolve(null);
            } else resolve(null);
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      }, wait);
    });

    const result = mbQueueTail.then(run, run);
    // Folge-Requests warten auf dieses Promise, unabhängig davon, ob es
    // erfüllt oder (theoretisch) abgelehnt wird.
    mbQueueTail = result.catch(() => {});
    return result;
  }

  function mbRequestJson(url) {
    return mbThrottledFetch(url);
  }

  // ---------------------------------------------------------------------
  // Persistenter LRU-Cache der letzten IPI_CACHE_MAX IPI-Suchergebnisse
  // (Artists + Labels gemeinsam). Bei Alben tauchen dieselben Personen
  // meist über mehrere Werke hinweg auf – der Cache überlebt daher auch
  // den Wechsel zum nächsten Werk, solange GM-Storage bestehen bleibt.
  // ---------------------------------------------------------------------
  function ipiCacheKey(ipi) {
    const clean = String(ipi || '').replace(/[^0-9]/g, '');
    return clean ? clean.padStart(11, '0') : '';
  }

  function loadIpiCache() {
    try {
      const raw = GM_getValue(IPI_CACHE_KEY, null);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveIpiCache(list) {
    try { GM_setValue(IPI_CACHE_KEY, JSON.stringify(list)); } catch (_) { /* ignore */ }
  }

  function getIpiCacheEntry(type, key) {
    const list = loadIpiCache();
    const idx = list.findIndex((e) => e.type === type && e.key === key);
    if (idx === -1) return null;
    const [entry] = list.splice(idx, 1);
    list.push(entry); // LRU: bei Zugriff ans Ende schieben
    saveIpiCache(list);
    return entry.result;
  }

  function putIpiCacheEntry(type, key, result) {
    const list = loadIpiCache().filter((e) => !(e.type === type && e.key === key));
    list.push({ type, key, result, ts: Date.now() });
    while (list.length > IPI_CACHE_MAX) list.shift();
    saveIpiCache(list);
  }

  // In-Flight-Requests pro Typ+IPI bündeln: taucht dieselbe IPI in
  // derselben Werk-Prüfung mehrfach auf (z. B. eine Person als
  // Komponist UND Textdichter), wird nur eine tatsächliche Suche
  // ausgelöst und von allen Aufrufern geteilt.
  const ipiPending = new Map();

  async function resolveByIpiCached(type, ipi, fetcher) {
    const key = ipiCacheKey(ipi);
    if (!key) return [];

    const cached = getIpiCacheEntry(type, key);
    if (cached) {
      console.info('[GEMA-Import] IPI-Cache-Treffer', type, key);
      return cached;
    }

    const pendingKey = `${type}:${key}`;
    if (ipiPending.has(pendingKey)) {
      return ipiPending.get(pendingKey);
    }

    const promise = fetcher(ipi)
      .then((result) => {
        putIpiCacheEntry(type, key, result);
        return result;
      })
      .finally(() => {
        ipiPending.delete(pendingKey);
      });

    ipiPending.set(pendingKey, promise);
    return promise;
  }

  function normalizeIpiVariants(ipi) {
    const clean = String(ipi || '').replace(/[^0-9]/g, '');
    if (!clean) return [];
    const padded11 = clean.padStart(11, '0');
    const stripped = clean.replace(/^0+/, '') || '0';
    return [...new Set([padded11, clean, stripped].filter(Boolean))];
  }

  async function fetchArtistsByIpiNetwork(ipi) {
    const variants = normalizeIpiVariants(ipi);
    if (!variants.length) return [];

    for (const v of variants) {
      const json = await mbRequestJson(
        `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent('ipi:' + v)}&fmt=json&limit=10`
      );
      const artists = json && json.artists;
      if (artists && artists.length) {
        return artists.map((a) => ({
          id: a.id,
          name: a.name,
          disambiguation: a.disambiguation || '',
        }));
      }
      // Die Warteschlange in mbThrottledFetch übernimmt bereits das
      // Timing zwischen Requests; hier ist kein zusätzliches Delay mehr nötig.
    }
    return [];
  }

  async function fetchLabelsByIpiNetwork(ipi) {
    const variants = normalizeIpiVariants(ipi);
    if (!variants.length) return [];

    for (const v of variants) {
      const json = await mbRequestJson(
        `https://musicbrainz.org/ws/2/label?query=${encodeURIComponent('ipi:' + v)}&fmt=json&limit=10`
      );
      const labels = json && json.labels;
      if (labels && labels.length) {
        return labels.map((l) => ({
          id: l.id,
          name: l.name,
          disambiguation: l.disambiguation || '',
        }));
      }
    }
    return [];
  }

  function resolveArtistsByIpi(ipi) {
    return resolveByIpiCached('artist', ipi, fetchArtistsByIpiNetwork);
  }

  function resolveLabelsByIpi(ipi) {
    return resolveByIpiCached('label', ipi, fetchLabelsByIpiNetwork);
  }

  async function searchLabelsByName(name) {
    if (!name) return [];
    const json = await mbRequestJson(
      `https://musicbrainz.org/ws/2/label?query=${encodeURIComponent('label:' + name)}&fmt=json&limit=10`
    );
    const labels = json && json.labels;
    return labels ? labels.map((l) => ({
      id: l.id,
      name: l.name,
      disambiguation: l.disambiguation || '',
    })) : [];
  }

  async function searchArtistsByName(name) {
    if (!name) return [];
    const json = await mbRequestJson(
      `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent('artist:' + name)}&fmt=json&limit=10`
    );
    const artists = json && json.artists;
    return artists ? artists.map((a) => ({
      id: a.id,
      name: a.name,
      disambiguation: a.disambiguation || '',
    })) : [];
  }

  // WICHTIG: Für den Relationship-Editor nicht die öffentliche WS/2-JSON
  // Antwort verwenden. Der MusicBrainz-Frontend-Code selbst holt Entities
  // über /ws/js/entity/<MBID>. Genau dieses Format erwartet der Reducer auf
  // /work/create.
  async function fetchMBEntity(mbid) {
    if (!mbid) return null;
    const json = await mbRequestJson(
      `https://musicbrainz.org/ws/js/entity/${encodeURIComponent(mbid)}`
    );
    if (!json || !json.id) return null;
    return json;
  }

  async function fetchArtist(mbid) {
    const entity = await fetchMBEntity(mbid);
    if (!entity) return null;
    if (entity.entityType !== 'artist') {
      console.warn('[GEMA-Import] /ws/js/entity lieferte keine Artist-Entity:', entity);
      return null;
    }
    return entity;
  }

  async function fetchLabel(mbid) {
    const entity = await fetchMBEntity(mbid);
    if (!entity) return null;
    if (entity.entityType !== 'label') {
      console.warn('[GEMA-Import] /ws/js/entity lieferte keine Label-Entity:', entity);
      return null;
    }
    return entity;
  }

  // -------------------------------------------------------------------------
  // GEMA UI
  // -------------------------------------------------------------------------

  function injectButtons() {
    document.querySelectorAll('tr[data-selector="collapsed-werk-row"]').forEach((row) => {
      const cell = row.querySelector('td[data-selector="options-data"]');
      if (!cell || cell.dataset.gemaWorkInjected) return;
      cell.dataset.gemaWorkInjected = '1';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '🎵 MusicBrainz';
      btn.title = 'GEMA-Werk prüfen und in MusicBrainz anlegen';
      btn.style.cssText =
        'font-size:.78rem;padding:.28rem .55rem;border:1px solid #b52b2b;border-radius:.3rem;' +
        'background:#fff7f7;color:#9a1f1f;cursor:pointer;white-space:nowrap;';
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.disabled = true;
        btn.textContent = '⏳ lese…';
        try {
          await ensureDetailsExpanded(row);
          const data = extractGemaData(row);
          if (!data.gemaId || !data.title) throw new Error('Titel oder GEMA-ID nicht gefunden.');
          openReview({
            ...data,
            gemaUrl: location.href,
            roles: data.roles.filter((r) => GEMA_ROLE_MAP[r.role]),
          });
        } catch (err) {
          console.error('[GEMA-Import]', err);
          alert(`GEMA-Daten konnten nicht gelesen werden: ${err.message || err}`);
        } finally {
          btn.disabled = false;
          btn.textContent = '🎵 MusicBrainz';
        }
      });
      cell.appendChild(btn);
    });
  }

  function makeEl(tag, css, text) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (text != null) el.textContent = text;
    return el;
  }


  function effectiveRoleRows(states, mode) {
    if (mode === 'writer') {
      const seen = new Set();
      const out = [];

      states.forEach((s) => {
        if (!s.selected) return;

        // Same MusicBrainz artist only once when importing as writer.
        if (seen.has(s.selected.id)) return;
        seen.add(s.selected.id);

        out.push({
          role: s.role,
          roleLabel: s.role.role,
          mbid: s.selected.id,
          mbName: s.selected.name,
          importRole: 'writer',
        });
      });

      return out;
    }

    return states
      .filter((s) => s.selected && s.importRole)
      .map((s) => ({
        role: s.role,
        roleLabel: s.role.role,
        mbid: s.selected.id,
        mbName: s.selected.name,
        importRole: s.importRole,
      }));
  }

  function openReview(data) {
    const existing = document.getElementById('gema-work-review-overlay');
    if (existing) existing.remove();

    const overlay = makeEl('div',
      'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:4vh 2vw;overflow:auto;');
    overlay.id = 'gema-work-review-overlay';

    const dialog = makeEl('div',
      'width:min(1100px,96vw);max-height:92vh;overflow:auto;background:#fff;border-radius:8px;box-shadow:0 12px 50px rgba(0,0,0,.35);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;');

    const header = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.25rem;border-bottom:1px solid #ddd;background:#fffaf1;position:sticky;top:0;z-index:2;');
    const h = makeEl('div', 'font-weight:700;font-size:1.1rem;', `GEMA → MusicBrainz: ${data.title}`);
    const close = makeEl('button', 'border:0;background:transparent;font-size:1.5rem;cursor:pointer;line-height:1;', '×');
    close.title = 'Schließen';
    close.onclick = () => overlay.remove();
    header.append(h, close);
    dialog.appendChild(header);

    const info = makeEl('div', 'padding:.75rem 1.25rem;font-size:.85rem;color:#555;');
    info.innerHTML = `<strong>ISWC:</strong> ${escapeHtml(data.iswc)} &nbsp; <strong>GEMA-ID:</strong> ${escapeHtml(data.gemaId)}<br>` +
      `<span>Die MusicBrainz-Suche läuft jetzt auf Basis der GEMA-Beteiligten. Titel und Lyricsprache kannst du vor dem Öffnen von MusicBrainz korrigieren.</span>`;
    dialog.appendChild(info);

    // Bearbeitbare Werk-Metadaten. GEMA liefert Titel üblicherweise in Großbuchstaben;
    // deshalb verwenden wir ihn nur als Vorschlag und lassen ihn hier korrigieren.
    const meta = makeEl('div', 'display:grid;grid-template-columns:minmax(0,2fr) minmax(180px,1fr);gap:.75rem;margin:0 1.25rem .9rem;');
    const titleWrap = makeEl('label', 'display:flex;flex-direction:column;gap:.25rem;font-size:.82rem;font-weight:600;');
    titleWrap.appendChild(makeEl('span', null, 'Werkname'));
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = data.title || '';
    titleInput.style.cssText = 'padding:.45rem .55rem;border:1px solid #bbb;border-radius:4px;font-size:.95rem;font-weight:400;';
    titleInput.placeholder = 'Werkname';
    titleWrap.appendChild(titleInput);

    const langWrap = makeEl('label', 'display:flex;flex-direction:column;gap:.25rem;font-size:.82rem;font-weight:600;');
    langWrap.appendChild(makeEl('span', null, 'Lyricsprache'));
    const langSelect = document.createElement('select');
    langSelect.style.cssText = 'padding:.45rem .55rem;border:1px solid #bbb;border-radius:4px;font-size:.95rem;font-weight:400;background:#fff;';
    const languages = [
      ['', '— keine Angabe —'],
      ['486', '[Keine Liedtexte]'],
      ['284', '[Mehrere Sprachen]'],
      ['18', 'Arabisch'],
      ['76', 'Chinesisch'],
      ['145', 'Deutsch'],
      ['120', 'Englisch'],
      ['131', 'Finnisch'],
      ['134', 'Französisch'],
      ['167', 'Hebräisch'],
      ['171', 'Hindi'],
      ['195', 'Italienisch'],
      ['198', 'Japanisch'],
      ['224', 'Koreanisch'],
      ['113', 'Niederländisch'],
      ['309', 'Norwegisch'],
      ['338', 'Polnisch'],
      ['340', 'Portugiesisch'],
      ['353', 'Russisch'],
      ['403', 'Schwedisch'],
      ['393', 'Spanisch'],
      ['433', 'Türkisch'],
    ];
    languages.forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      langSelect.appendChild(opt);
    });
    const gemaLanguageMap = {
      'DEUTSCH': '145',
      'ENGLISCH': '120',
      'FRANZÖSISCH': '134',
      'ITALIENISCH': '195',
      'SPANISCH': '393',
      'NIEDERLÄNDISCH': '113',
      'PORTUGIESISCH': '340',
      'SCHWEDISCH': '403',
      'NORWEGISCH': '309',
      'DÄNISCH': '72',
      'FINNISCH': '131',
      'POLNISCH': '338',
      'RUSSISCH': '353',
      'TÜRKISCH': '433',
      'JAPANISCH': '198',
      'KOREANISCH': '224',
      'CHINESISCH': '76',
    };
    const detectedLanguageId = gemaLanguageMap[String(data.language || '').toUpperCase()] || '';
    langSelect.value = String(data.languageId || detectedLanguageId || CONFIG.mbLanguageId || '145');
    if (!Array.from(langSelect.options).some((o) => o.value === langSelect.value)) {
      langSelect.value = String(CONFIG.mbLanguageId || '145');
    }
    langWrap.appendChild(langSelect);

    const langHint = makeEl('div', 'grid-column:2;font-size:.74rem;color:#777;margin-top:-.45rem;', 'Die Auswahl wird direkt als MusicBrainz-Sprach-ID übernommen.');
    meta.append(titleWrap, langWrap, langHint);
    dialog.appendChild(meta);

    // -----------------------------------------------------------------------
    // Importoptionen
    // -----------------------------------------------------------------------
    const optionsBox = makeEl(
      'div',
      'margin:0 1.25rem 1rem;padding:.75rem .9rem;border:1px solid #d5dbe7;border-radius:6px;background:#f8fafc;'
    );

    optionsBox.appendChild(
      makeEl('div', 'font-weight:700;margin-bottom:.55rem;', 'Importoptionen')
    );

    let roleMode = 'gema';

    const roleModeWrap = makeEl(
      'div',
      'display:flex;flex-wrap:wrap;gap:.8rem;align-items:center;margin-bottom:.65rem;'
    );

    roleModeWrap.appendChild(
      makeEl('span', 'font-weight:600;font-size:.84rem;', 'Personen als')
    );

    [
      ['gema', 'GEMA-Rollen übernehmen'],
      ['writer', 'Alle als Verfasser'],
      ['manual', 'Manuell pro Person'],
    ].forEach(([value, label]) => {
      const lab = makeEl(
        'label',
        'display:flex;align-items:center;gap:.3rem;font-size:.84rem;font-weight:400;cursor:pointer;'
      );

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'gema-role-mode';
      radio.value = value;
      radio.checked = value === 'gema';

      radio.addEventListener('change', () => {
        if (!radio.checked) return;

        roleMode = value;

        states.forEach((st) => {
          if (value === 'writer') {
            st.importRole = 'writer';
          } else if (value === 'gema') {
            st.importRole = GEMA_ROLE_MAP[st.role.role] || '';
          } else {
            st.importRole =
              st.importRole ||
              GEMA_ROLE_MAP[st.role.role] ||
              'writer';
          }
        });

        renderAllRoleRows();
      });

      lab.append(radio, document.createTextNode(label));
      roleModeWrap.appendChild(lab);
    });

    optionsBox.appendChild(roleModeWrap);

    let importPublishers = false;

    const publisherModeWrap = makeEl(
      'div',
      'display:flex;flex-wrap:wrap;gap:.8rem;align-items:center;'
    );

    publisherModeWrap.appendChild(
      makeEl('span', 'font-weight:600;font-size:.84rem;', 'Originalverlage')
    );

    [
      ['no', 'Nicht importieren'],
      ['yes', 'Importieren'],
    ].forEach(([value, label]) => {
      const lab = makeEl(
        'label',
        'display:flex;align-items:center;gap:.3rem;font-size:.84rem;font-weight:400;cursor:pointer;'
      );

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'gema-publisher-mode';
      radio.value = value;
      radio.checked = value === 'no';

      radio.addEventListener('change', () => {
        if (radio.checked) importPublishers = value === 'yes';
      });

      lab.append(radio, document.createTextNode(label));
      publisherModeWrap.appendChild(lab);
    });

    optionsBox.appendChild(publisherModeWrap);

    optionsBox.appendChild(
      makeEl(
        'div',
        'margin-top:.55rem;font-size:.75rem;color:#777;',
        '„Verfasser“ dedupliziert dieselbe MusicBrainz-Person automatisch. „Nicht importieren“ ist bei Originalverlagen standardmäßig ausgewählt.'
      )
    );

    dialog.appendChild(optionsBox);

    const table = makeEl('table', 'border-collapse:collapse;width:calc(100% - 2.5rem);margin:0 1.25rem;font-size:.86rem;');
    const headRow = makeEl('tr', 'background:#f3e8a8;');
    ['Rolle', 'GEMA-Name / IPI', 'MusicBrainz-Match', 'Aktion'].forEach((x) => {
      headRow.appendChild(makeEl('th', 'text-align:left;padding:.45rem .55rem;border:1px solid #d5c77b;', x));
    });
    table.appendChild(headRow);

    const states = data.roles.map((r) => ({
      role: r,
      selected: null,
      candidates: [],
      status: 'pending',
      importRole: GEMA_ROLE_MAP[r.role] || '',
    }));
    const rowRefs = [];

    data.roles.forEach((r, idx) => {
      const tr = makeEl('tr');
      const roleTd = makeEl('td', 'padding:.45rem .55rem;border:1px solid #ddd;white-space:nowrap;');
      roleTd.textContent = GEMA_ROLE_MAP[r.role] ? r.role : `${r.role} ⚠`;
      const nameTd = makeEl('td', 'padding:.45rem .55rem;border:1px solid #ddd;');
      nameTd.innerHTML = `${escapeHtml(r.name)}<br><span style="color:#888;font-size:.78rem">IPI: ${escapeHtml(r.ipi || '—')}</span>`;
      const matchTd = makeEl('td', 'padding:.45rem .55rem;border:1px solid #ddd;min-width:320px;');
      const actionTd = makeEl('td', 'padding:.45rem .55rem;border:1px solid #ddd;white-space:nowrap;');
      const status = makeEl('span', 'color:#777;', '⏳ suche…');
      const candidatesBox = makeEl('div', 'display:flex;flex-direction:column;gap:.25rem;');
      const searchLine = makeEl('div', 'display:flex;gap:.3rem;margin-top:.35rem;');
      const searchInput = makeEl('input', 'flex:1;min-width:0;padding:.3rem .4rem;border:1px solid #bbb;border-radius:3px;', null);
      searchInput.placeholder = 'Name oder MBID';
      const searchBtn = makeEl('button', 'padding:.25rem .55rem;cursor:pointer;', 'Suchen');
      searchLine.append(searchInput, searchBtn);
      matchTd.append(status, candidatesBox, searchLine);

      const roleSelect = document.createElement('select');
      roleSelect.style.cssText =
        'margin-bottom:.35rem;padding:.25rem .35rem;border:1px solid #bbb;border-radius:3px;background:#fff;';

      [
        ['writer', 'Verfasser'],
        ['composer', 'Komponist'],
        ['lyricist', 'Textdichter'],
        ['arranger', 'Arrangeur'],
      ].forEach(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        roleSelect.appendChild(opt);
      });

      roleSelect.value = states[idx].importRole || 'writer';
      roleSelect.addEventListener('change', () => {
        states[idx].importRole = roleSelect.value;
      });

      const clearBtn = makeEl('button', 'padding:.25rem .55rem;cursor:pointer;', 'Auswahl löschen');
      clearBtn.onclick = () => { states[idx].selected = null; render(); };
      actionTd.append(roleSelect, clearBtn);

      tr.append(roleTd, nameTd, matchTd, actionTd);
      table.appendChild(tr);
      rowRefs.push({ tr, status, candidatesBox, searchInput, roleSelect });

      function select(a) {
        states[idx].selected = a;
        states[idx].status = 'selected';
        render();
      }

      async function search() {
        const q = searchInput.value.trim();
        if (!q) return;
        status.textContent = '⏳ suche…';
        let list = [];
        const m = q.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
        if (m) {
          // WICHTIG: fetchArtist() liefert eine /ws/js/entity-Antwort, deren
          // `.id`-Feld die interne numerische MB-Datenbank-ID ist – NICHT
          // die MBID/UUID. Würde man a.id direkt übernehmen, würde später
          // beim Import mit dieser falschen Zahl erneut nachgeladen und
          // fehlschlagen ("Artist <Zahl> nicht geladen"). Wir verwenden
          // daher die bereits verifizierte UUID aus der Eingabe selbst.
          const mbid = m[0].toLowerCase();
          const a = await fetchArtist(mbid);
          if (a) list = [{ id: mbid, name: a.name, disambiguation: a.comment || a.disambiguation || '' }];
        } else {
          list = await searchArtistsByName(q);
        }
        states[idx].candidates = list;
        states[idx].status = list.length ? 'candidates' : 'none';
        render();
      }
      searchBtn.onclick = search;
      searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });

      // IPI automatisch suchen.
      (async () => {
        if (!GEMA_ROLE_MAP[r.role]) {
          states[idx].status = 'unmapped';
          render();
          return;
        }
        const list = await resolveArtistsByIpi(r.ipi);
        states[idx].candidates = list;
        if (list.length === 1) {
          states[idx].selected = list[0];
          states[idx].status = 'selected';
        } else if (list.length > 1) {
          states[idx].status = 'candidates';
        } else {
          states[idx].status = 'none';
        }
        render();
      })();

      function render() {
        const s = states[idx];
        candidatesBox.innerHTML = '';
        if (s.status === 'selected' && s.selected) {
          status.textContent = '✓ eindeutiger/gewählter Treffer';
          status.style.color = '#187a18';
          const selected = makeEl('div', 'margin-top:.25rem;padding:.3rem .45rem;border:1px solid #78b878;background:#edf9ed;border-radius:3px;font-weight:600;', `${s.selected.name}${s.selected.disambiguation ? ` (${s.selected.disambiguation})` : ''}`);
          candidatesBox.appendChild(selected);
          return;
        }
        status.style.color = s.status === 'none' ? '#a33' : '#777';
        status.textContent = s.status === 'none' ? '⚠ kein IPI-Treffer' :
          s.status === 'unmapped' ? '⚠ Rolle noch nicht gemappt' :
          s.status === 'candidates' ? `🔎 ${s.candidates.length} Treffer – bitte auswählen` : '⏳ suche…';
        s.candidates.forEach((a) => {
          const b = makeEl('button', 'text-align:left;padding:.3rem .45rem;border:1px solid #ccc;background:#fff;border-radius:3px;cursor:pointer;', `${a.name}${a.disambiguation ? ` (${a.disambiguation})` : ''}`);
          b.onclick = () => select(a);
          candidatesBox.appendChild(b);
        });
      }
    });

    function renderAllRoleRows() {
      rowRefs.forEach((ref, i) => {
        ref.roleSelect.value = states[i].importRole || 'writer';
        ref.roleSelect.style.display = roleMode === 'manual' ? '' : 'none';
      });
    }

    dialog.appendChild(table);
    renderAllRoleRows();

    // -----------------------------------------------------------------------
    // Originalverlage -> MusicBrainz Labels
    // -----------------------------------------------------------------------
    const publisherHeading = makeEl(
      'div',
      'margin:1.1rem 1.25rem .5rem;font-weight:700;font-size:.95rem;',
      'Originalverlage'
    );
    dialog.appendChild(publisherHeading);

    const publisherTable = makeEl(
      'table',
      'border-collapse:collapse;width:calc(100% - 2.5rem);margin:0 1.25rem 1rem;font-size:.86rem;'
    );
    const publisherHead = makeEl('tr', 'background:#e8edf7;');
    ['GEMA-Verlag / IPI', 'MusicBrainz-Label', 'Aktion'].forEach((x) => {
      publisherHead.appendChild(
        makeEl('th', 'text-align:left;padding:.45rem .55rem;border:1px solid #c9d2e3;', x)
      );
    });
    publisherTable.appendChild(publisherHead);

    const publisherStates = (data.publishers || []).map((p) => ({
      publisher: p,
      selected: null,
      candidates: [],
      status: 'pending',
    }));

    publisherStates.forEach((state) => {
      const tr = makeEl('tr');
      const nameTd = makeEl('td', 'padding:.45rem .55rem;border:1px solid #ddd;');
      nameTd.innerHTML =
        `${escapeHtml(state.publisher.name)}<br>` +
        `<span style="color:#888;font-size:.78rem">IPI: ${escapeHtml(state.publisher.ipi || '—')}</span>`;

      const matchTd = makeEl(
        'td',
        'padding:.45rem .55rem;border:1px solid #ddd;min-width:320px;'
      );
      const actionTd = makeEl(
        'td',
        'padding:.45rem .55rem;border:1px solid #ddd;white-space:nowrap;'
      );

      const status = makeEl('span', 'color:#777;', '⏳ suche…');
      const candidatesBox = makeEl('div', 'display:flex;flex-direction:column;gap:.25rem;');
      const searchLine = makeEl('div', 'display:flex;gap:.3rem;margin-top:.35rem;');
      const searchInput = makeEl(
        'input',
        'flex:1;min-width:0;padding:.3rem .4rem;border:1px solid #bbb;border-radius:3px;',
        null
      );
      searchInput.placeholder = 'Labelname oder MBID';
      const searchBtn = makeEl('button', 'padding:.25rem .55rem;cursor:pointer;', 'Suchen');
      searchLine.append(searchInput, searchBtn);
      matchTd.append(status, candidatesBox, searchLine);

      const clearBtn = makeEl(
        'button',
        'padding:.25rem .55rem;cursor:pointer;',
        'Auswahl löschen'
      );
      clearBtn.onclick = () => {
        state.selected = null;
        render();
      };
      actionTd.appendChild(clearBtn);

      tr.append(nameTd, matchTd, actionTd);
      publisherTable.appendChild(tr);

      function select(label) {
        state.selected = label;
        state.status = 'selected';
        render();
      }

      async function search() {
        const q = searchInput.value.trim();
        if (!q) return;
        status.textContent = '⏳ suche…';

        let list = [];
        const m = q.match(
          /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i
        );
        if (m) {
          // Gleicher Grund wie bei der Artist-Suche: die interne numerische
          // ID aus /ws/js/entity darf nicht als mbid weitergereicht werden.
          const mbid = m[0].toLowerCase();
          const label = await fetchLabel(mbid);
          if (label) list = [{ id: mbid, name: label.name, disambiguation: label.comment || label.disambiguation || '' }];
        } else {
          list = await searchLabelsByName(q);
        }

        state.candidates = list;
        state.status = list.length ? 'candidates' : 'none';
        render();
      }

      searchBtn.onclick = search;
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') search();
      });

      (async () => {
        const list = await resolveLabelsByIpi(state.publisher.ipi);
        state.candidates = list;

        if (list.length === 1) {
          state.selected = list[0];
          state.status = 'selected';
        } else if (list.length > 1) {
          state.status = 'candidates';
        } else {
          state.status = 'none';
        }
        render();
      })();

      function render() {
        candidatesBox.innerHTML = '';

        if (state.status === 'selected' && state.selected) {
          status.textContent = '✓ eindeutiger/gewählter Treffer';
          status.style.color = '#187a18';
          candidatesBox.appendChild(
            makeEl(
              'div',
              'margin-top:.25rem;padding:.3rem .45rem;border:1px solid #78b878;background:#edf9ed;border-radius:3px;font-weight:600;',
              `${state.selected.name}${state.selected.disambiguation ? ` (${state.selected.disambiguation})` : ''}`
            )
          );
          return;
        }

        status.style.color = state.status === 'none' ? '#a33' : '#777';
        status.textContent =
          state.status === 'none'
            ? '⚠ kein IPI-Treffer'
            : state.status === 'candidates'
              ? `🔎 ${state.candidates.length} Treffer – bitte auswählen`
              : '⏳ suche…';

        state.candidates.forEach((label) => {
          const b = makeEl(
            'button',
            'text-align:left;padding:.3rem .45rem;border:1px solid #ccc;background:#fff;border-radius:3px;cursor:pointer;',
            `${label.name}${label.disambiguation ? ` (${label.disambiguation})` : ''}`
          );
          b.onclick = () => select(label);
          candidatesBox.appendChild(b);
        });
      }
    });

    dialog.appendChild(publisherTable);

    const footer = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.25rem;position:sticky;bottom:0;background:#fff;border-top:1px solid #ddd;');
    const footerStatus = makeEl('div', 'font-size:.85rem;color:#666;', 'Bitte alle gefundenen Urheberrollen prüfen.');
    const createBtn = makeEl('button', 'border:0;border-radius:4px;padding:.55rem 1rem;background:#2b7cff;color:#fff;font-weight:700;cursor:pointer;', '✓ Werk in MusicBrainz erstellen →');
    createBtn.onclick = () => {
      const unresolvedMapped = states.filter(
        (st) => st.role.role && !st.selected
      );

      if (unresolvedMapped.length) {
        alert(
          `Noch nicht aufgelöst:\n\n` +
          unresolvedMapped
            .map((st) => `${st.role.role}: ${st.role.name}`)
            .join('\n') +
          `\n\nBitte einen Treffer auswählen oder manuell suchen.`
        );
        return;
      }

      if (
        roleMode === 'manual' &&
        states.some((st) => st.selected && !st.importRole)
      ) {
        alert('Bitte für jede ausgewählte Person eine Importrolle festlegen.');
        return;
      }

      const prepared = {
        ...data,
        title: titleInput.value.trim() || data.title,
        languageId: langSelect.value.trim(),
        roleMode,
        importPublishers,
        roles: effectiveRoleRows(states, roleMode),
        publishers: importPublishers
          ? (data.publishers || []).filter((p) => p.mbid)
          : [],
      };

      createBtn.disabled = true;
      createBtn.textContent = 'Speichere…';
            startWorkImport(prepared);
      footerStatus.textContent = 'MusicBrainz wird geöffnet…';
    };
    footer.append(footerStatus, createBtn);
    dialog.appendChild(footer);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function startWorkImport(data) {
    // Zeitstempel für die TTL-Bereinigung (cleanupStaleImportData). Falls
    // /work/create nie erfolgreich lädt (Popup blockiert, Tab geschlossen,
    // Browser-Absturz), bleibt dieser Eintrag sonst für immer liegen.
    GM_setValue(GM_PREFIX + data.gemaId, JSON.stringify({ ...data, ts: Date.now() }));

    const params = new URLSearchParams();
    params.set('edit-work.name', data.title);
    params.set('edit-work.iswcs.0', data.iswc);
    params.set('edit-work.type_id', CONFIG.mbWorkTypeId);

    // GEMA-ID als MusicBrainz-Attribut. Der GEMA-Wert wird unverändert
    // (abgesehen von führenden/abschließenden Leerzeichen) übernommen.
    if (CONFIG.mbGemaAttributeTypeId && !String(CONFIG.mbGemaAttributeTypeId).startsWith('TODO') && data.gemaId) {
      params.set('edit-work.attributes.0.type_id', CONFIG.mbGemaAttributeTypeId);
      params.set('edit-work.attributes.0.value', String(data.gemaId).trim());
    }

    // MusicBrainz erwartet beim Work-Seed die numerische Sprach-ID.
    // Die Auswahl stammt direkt aus der auf der GEMA-Prüfmaske angezeigten
    // Zuordnung (z. B. Deutsch = 145).
    if (data.languageId) {
      params.set('edit-work.languages.0', String(data.languageId));
    }
    params.set('edit-work.edit_note', `${data.gemaUrl}\nISWC: ${data.iswc}\nGEMA-ID: ${data.gemaId}`);

    const createUrl = `https://musicbrainz.org/work/create?${params.toString()}#${MB_PREFIX}${encodeURIComponent(data.gemaId)}`;
    const tab = window.open(createUrl, '_blank');
    if (!tab) {
      alert('Popup blockiert — bitte Popups für musicbrainz.org erlauben und erneut versuchen.');
    }
  }

  // Sicherheitsnetz für verwaiste Einträge: Fälle, in denen /work/create
  // nie erfolgreich geladen hat (Popup blockiert, Tab zu früh geschlossen,
  // Browser-Crash) und importRelationshipsOnWorkCreate() daher nie lief,
  // um den Eintrag selbst aufzuräumen. Läuft einmal pro GEMA-Seitenaufruf.
  const STALE_IMPORT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 Tage

  function cleanupStaleImportData() {
    if (typeof GM_listValues !== 'function') return;
    let keys;
    try { keys = GM_listValues(); } catch (_) { return; }
    const now = Date.now();
    // GM_PREFIX wird auch vom IPI-Cache verwendet (anderes Datenformat,
    // eine Liste statt eines einzelnen Werk-Datensatzes mit .ts) – der
    // muss von dieser Bereinigung ausgenommen werden.
    keys.filter((k) => k.startsWith(GM_PREFIX) && k !== IPI_CACHE_KEY).forEach((k) => {
      try {
        const raw = GM_getValue(k, null);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || !parsed.ts || (now - parsed.ts) > STALE_IMPORT_TTL_MS) {
          GM_deleteValue(k);
          console.info('[GEMA-Import] Verwaisten Storage-Eintrag entfernt:', k);
        }
      } catch (_) {
        // Kaputte/alte Einträge ohne verwertbaren Inhalt ebenfalls entfernen.
        GM_deleteValue(k);
      }
    });
  }

  function initGemaSide() {
    cleanupStaleImportData();
    injectButtons();
    const observer = new MutationObserver(() => injectButtons());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // -------------------------------------------------------------------------
  // MusicBrainz /work/create
  // -------------------------------------------------------------------------

  function pageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  }

  function getMB() {
    return pageWindow().MB;
  }

  async function waitForMBEditor(timeoutMs = 30000) {
    let waited = 0;
    while (waited < timeoutMs) {
      const MB = getMB();
      const re = MB && MB.relationshipEditor;
      if (re && re.state && re.state.entity) {
        console.info('[GEMA-Import] relationshipEditor bereit:', re.state.entity);
        return re;
      }
      if (waited % 3000 === 0) {
        console.info('[GEMA-Import] warte auf relationshipEditor…', waited, {
          MB: !!MB,
          relationshipEditor: !!re,
          body: !!document.body,
        });
      }
      await new Promise((r) => setTimeout(r, 250));
      waited += 250;
    }
    return null;
  }

  function resolveLinkTypeId(name, type0, type1) {
    const MB = getMB();
    const lt = MB && MB.linkedEntities && MB.linkedEntities.link_type;
    if (!lt) return null;
    const candidates = Object.values(lt).filter((v) => v && v.type0 === type0 && v.type1 === type1 && !v.deprecated);
    const needle = name.toLowerCase().trim();
    const exact = candidates.find((v) => String(v.name || '').toLowerCase() === needle);
    return exact ? exact.id : null;
  }

  async function fetchEntityDetails(mbid) {
    return fetchMBEntity(mbid);
  }

  function dispatchWorkRelationship(re, workEntity, targetEntity, linkTypeID) {
    if (!workEntity || workEntity.entityType !== 'work') {
      throw new Error(`Ungültige Work-Entity: ${JSON.stringify(workEntity)}`);
    }
    if (!targetEntity || !['artist', 'label'].includes(targetEntity.entityType)) {
      throw new Error(`Ungültige Artist-/Label-Entity: ${JSON.stringify(targetEntity)}`);
    }
    if (!linkTypeID) {
      throw new Error('Keine linkTypeID');
    }

    // MusicBrainz speichert entity0/entity1 entsprechend dem Relationship-Typ.
    // Für Artist->Work und Label->Work sind sowohl Artist- als auch Label-Entities
    // gültige Gegenstellen des Works.
    const swapped = workEntity.entityType > targetEntity.entityType;
    const e0 = swapped ? targetEntity : workEntity;
    const e1 = swapped ? workEntity : targetEntity;

    re.dispatch({
      type: 'update-relationship-state',
      sourceEntity: workEntity,
      batchSelectionCount: null,
      creditsToChangeForSource: '',
      creditsToChangeForTarget: '',
      oldRelationshipState: null,
      newRelationshipState: {
        _lineage: [],
        _original: null,
        _status: 1,
        attributes: null,
        begin_date: null,
        editsPending: false,
        end_date: null,
        ended: false,
        entity0: e0,
        entity0_credit: '',
        entity1: e1,
        entity1_credit: '',
        id: re.getRelationshipStateId(),
        linkOrder: 0,
        linkTypeID,
      },
    });
  }

  function getStoredWorkData(gemaId) {
    const raw = GM_getValue(GM_PREFIX + gemaId, null);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  function addMBStatus(message, ok = false) {
    let box = document.getElementById('gema-work-mb-status');
    if (!box) {
      box = document.createElement('div');
      box.id = 'gema-work-mb-status';
      box.style.cssText = 'margin:1rem 0;padding:.7rem 1rem;border:2px solid #c8a000;border-radius:5px;background:#fffef5;font-family:inherit;';
      const anchor = document.querySelector('#content') || document.body;
      anchor.insertBefore(box, anchor.firstChild);
    }
    box.style.borderColor = ok ? '#57a957' : '#c8a000';
    box.innerHTML = `<strong>${ok ? '✓' : 'GEMA'}</strong> ${escapeHtml(message)}`;
    return box;
  }

  async function importRelationshipsOnWorkCreate(data) {
    // Der gespeicherte GEMA-Datensatz wird in jedem Fall konsumiert, sobald
    // wir hier ankommen – egal ob der Import gelingt, teilweise fehlschlägt
    // oder der Relationship Editor gar nicht gefunden wird. Ein erneuter
    // Versuch würde ohnehin bedeuten, den Import auf der GEMA-Seite neu
    // anzustoßen, daher hinterlässt ein gescheiterter Versuch keinen
    // verwaisten Storage-Eintrag mehr (siehe cleanupStaleImportData für
    // den Fall, dass /work/create nie geladen wird).
    try {
      await importRelationshipsOnWorkCreateInner(data);
    } finally {
      if (data && data.gemaId) GM_deleteValue(GM_PREFIX + data.gemaId);
    }
  }

  async function importRelationshipsOnWorkCreateInner(data) {
    const mapped = (data.roles || []).filter((r) => r.mbid && r.importRole);
    const mappedPublishers = data.importPublishers ? (data.publishers || []).filter((p) => p.mbid) : [];

    if (!mapped.length && !mappedPublishers.length) {
      addMBStatus('Keine gematchten Artists oder Verlage vorhanden – Werk kann normal eingetragen werden.', true);
      return;
    }

    const re = await waitForMBEditor();
    if (!re) {
      addMBStatus('Der MusicBrainz Relationship Editor wurde auf /work/create nicht gefunden. Die Werkdaten wurden trotzdem vorausgefüllt. Bitte Browser-Konsole prüfen.');
      console.warn('[GEMA-Import] Kein MB.relationshipEditor auf /work/create.');
      return;
    }

    const workEntity = re.state.entity;
    let added = 0;
    const failures = [];

    for (const role of mapped) {
      const relation = role.importRole;
      const linkTypeID = resolveLinkTypeId(relation, 'artist', 'work');
      if (!linkTypeID) {
        failures.push(`${role.roleLabel}: Relationship-Typ ${relation} nicht gefunden`);
        continue;
      }
      const artistEntity = await fetchEntityDetails(role.mbid);
      if (!artistEntity) {
        failures.push(`${role.roleLabel}: Artist ${role.mbid} nicht geladen`);
        continue;
      }
      try {
        console.info('[GEMA-Import] Beziehung vorbereiten:', {
          relation,
          linkTypeID,
          workEntity,
          artistEntity,
        });
        dispatchWorkRelationship(re, workEntity, artistEntity, linkTypeID);
        added++;
      } catch (e) {
        console.error('[GEMA-Import] dispatch failed', e);
        failures.push(`${role.roleLabel}: ${e.message || e}`);
      }
    }

    // Originalverlage -> Label-Work / publishing.
    // MusicBrainz beschreibt diesen Relationship-Typ ausdrücklich als
    // Publisher eines Works, nicht als normales Record Label.
    for (const publisher of mappedPublishers) {
      const linkTypeID = resolveLinkTypeId('publishing', 'label', 'work');
      if (!linkTypeID) {
        failures.push(`${publisher.name}: Label-Work-Relationship „publishing“ nicht gefunden`);
        continue;
      }

      const labelEntity = await fetchLabel(publisher.mbid);
      if (!labelEntity) {
        failures.push(`${publisher.name}: Label ${publisher.mbid} nicht geladen`);
        continue;
      }

      try {
        dispatchWorkRelationship(re, workEntity, labelEntity, linkTypeID);
        added++;
      } catch (e) {
        console.error('[GEMA-Import] Label dispatch failed', e);
        failures.push(`${publisher.name}: ${e.message || e}`);
      }
    }

    if (failures.length) {
      addMBStatus(`${added} Beziehung(en) eingefügt; ${failures.length} Problem(e): ${failures.join(' | ')}`);
    } else {
      addMBStatus(`${added} GEMA-Beziehung(en) eingefügt. Bitte im Formular prüfen und anschließend „Werk eintragen“ klicken.`, true);
    }
  }

  async function initWorkPage() {
    if (!/^\/work\/create\/?$/i.test(location.pathname)) return;
    const hash = location.hash || '';
    const m = hash.match(/#gema-work-import:([^&]+)/);
    if (!m) return;
    const gemaId = decodeURIComponent(m[1]);
    console.info('[GEMA-Import] /work/create für GEMA-Import:', gemaId);

    const data = getStoredWorkData(gemaId);
    if (!data) {
      console.warn('[GEMA-Import] Keine gespeicherten GEMA-Daten für', gemaId);
      addMBStatus(`Keine gespeicherten GEMA-Daten für ${gemaId} gefunden.`);
      return;
    }

    addMBStatus(`GEMA-Daten geladen. Warte auf MusicBrainz Relationship Editor…`);
    await importRelationshipsOnWorkCreate(data);
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------
  if (/^portal\.gema\.de$/i.test(location.hostname)) {
    initGemaSide();
  } else if (/^(www\.)?musicbrainz\.org$/i.test(location.hostname)) {
    initWorkPage();
  }
})();
