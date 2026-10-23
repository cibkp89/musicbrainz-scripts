// ==UserScript==
// @name         AKM Work Importer for MusicBrainz
// @namespace    akm-work-importer
// @version      0.4.1
// @description  AKM/AUME: AR-Berechtigte per IPI mit MusicBrainz matchen, Werkdaten prüfen und danach ein neues Werk auf /work/create öffnen
// @author       (dein Name)
// @match        https://www.akm-aume.at/akm-webapp/*
// @match        https://musicbrainz.org/work/create*
// @match        https://*.musicbrainz.org/work/create*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      musicbrainz.org
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    mbLanguageId: '145',
    mbWerknummerAttributeTypeId: '23',
    mbWorkTypeId: '17',
  };

  const AKM_ROLE_MAP = {
    KomponistIn: 'composer',
    TextdichterIn: 'lyricist',
    ArrangeurIn: 'arranger',
  };

  const GM_PREFIX = 'akm-work:';
  const MB_PREFIX = 'akm-work-import:';

  function stripText(el) {
    return (el && el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getGlobalInfo() {
    return {
      title: stripText(document.querySelector('[data-testid="kv_pair_value_Titel"]')),
      werknummer: stripText(document.querySelector('[data-testid="kv_pair_value_Werknummer"]')),
    };
  }

  const VERSION_HEADER_RE = /^Version\s+(\d+)\s*-\s*ISWC\s*-\s*([A-Za-z0-9]+)\s*-\s*(.+?)\s*-\s*(\S+)$/;

  function parseVersionHeader(text) {
    const m = VERSION_HEADER_RE.exec(text.trim());
    if (!m) return null;
    return { versionNr: m[1], iswc: m[2], title: m[3].trim(), suffix: m[4].trim() };
  }

  function extractAR(versionEl) {
    const blocks = versionEl.querySelectorAll('akm-werksuche-detail-berechtigte');
    for (const block of blocks) {
      const h3 = block.querySelector('.summary__title h3');
      if (!h3 || h3.textContent.trim() !== 'AR') continue;
      const rows = block.querySelectorAll('.berechtigte_grid.smallGrid:not(.header)');
      const out = [];
      rows.forEach((row) => {
        const role = stripText(row.querySelector('.rolle'));
        const name = stripText(row.querySelector('.name'));
        const ipi = stripText(row.querySelector('.ipName'));
        if (role && name) out.push({ role, name, ipi });
      });
      return out;
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // MusicBrainz API helpers. They run on AKM, before we navigate to MB.
  // -------------------------------------------------------------------------

  function mbRequestJson(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Accept: 'application/json' },
        timeout: 15000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); } catch (_) { resolve(null); }
          } else resolve(null);
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  async function resolveArtistsByIpi(ipi) {
    if (!ipi) return [];
    const clean = String(ipi).replace(/[^0-9]/g, '');
    if (!clean) return [];
    const variants = [...new Set([clean, clean.replace(/^0+/, '')].filter(Boolean))];

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
      // Kleine Pause, damit mehrere IPI-Suchen nicht unnötig schnell aufeinander folgen.
      await new Promise((r) => setTimeout(r, 250));
    }
    return [];
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
      console.warn('[AKM-Import] /ws/js/entity lieferte keine Artist-Entity:', entity);
      return null;
    }
    return entity;
  }

  // -------------------------------------------------------------------------
  // AKM UI
  // -------------------------------------------------------------------------

  function injectButtons() {
    const globalInfo = getGlobalInfo();
    document.querySelectorAll('akm-werksuche-detail-version').forEach((versionEl) => {
      const h3 = versionEl.querySelector(':scope > akm-summary > div.summary > div.summary__title > h3');
      if (!h3) return;
      const parsed = parseVersionHeader(h3.textContent);
      if (!parsed) return;

      const content = versionEl.querySelector(
        ':scope > akm-summary > div.summary > div.summary__title > div.summary_content'
      );
      if (!content || content.dataset.akmWorkInjected) return;
      content.dataset.akmWorkInjected = '1';

      const ar = extractAR(versionEl);
      const unmapped = ar.filter((r) => !AKM_ROLE_MAP[r.role]);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `🎵 Werk anlegen (${ar.length} Beteiligte)`;
      btn.title = unmapped.length
        ? `Nicht gemappte Rollen: ${[...new Set(unmapped.map((r) => r.role))].join(', ')}`
        : 'AKM-Berechtigte prüfen und danach MusicBrainz-Werk anlegen';
      btn.style.cssText =
        'font-size:0.78rem;padding:0.2rem 0.55rem;border:1px solid #e8771d;border-radius:0.3rem;' +
        'background:#fff8f0;color:#c25e0a;cursor:pointer;margin-left:0.5rem;';
      btn.addEventListener('click', () => openReview({
        title: globalInfo.title || parsed.title,
        languageId: CONFIG.mbLanguageId,
        werknummer: globalInfo.werknummer ? `${globalInfo.werknummer}-${parsed.suffix}` : parsed.suffix,
        iswc: parsed.iswc,
        akmUrl: location.href,
        roles: ar,
      }));
      content.appendChild(btn);
    });
  }

  function makeEl(tag, css, text) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (text != null) el.textContent = text;
    return el;
  }

  function openReview(data) {
    const existing = document.getElementById('akm-work-review-overlay');
    if (existing) existing.remove();

    const overlay = makeEl('div',
      'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:4vh 2vw;overflow:auto;');
    overlay.id = 'akm-work-review-overlay';

    const dialog = makeEl('div',
      'width:min(1100px,96vw);max-height:92vh;overflow:auto;background:#fff;border-radius:8px;box-shadow:0 12px 50px rgba(0,0,0,.35);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;');

    const header = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.25rem;border-bottom:1px solid #ddd;background:#fffaf1;position:sticky;top:0;z-index:2;');
    const h = makeEl('div', 'font-weight:700;font-size:1.1rem;', `AKM → MusicBrainz: ${data.title}`);
    const close = makeEl('button', 'border:0;background:transparent;font-size:1.5rem;cursor:pointer;line-height:1;', '×');
    close.title = 'Schließen';
    close.onclick = () => overlay.remove();
    header.append(h, close);
    dialog.appendChild(header);

    const info = makeEl('div', 'padding:.75rem 1.25rem;font-size:.85rem;color:#555;');
    info.innerHTML = `<strong>ISWC:</strong> ${escapeHtml(data.iswc)} &nbsp; <strong>AKM-Werknummer:</strong> ${escapeHtml(data.werknummer)}<br>` +
      `<span>Die MusicBrainz-Suche läuft jetzt auf der AKM-Seite. Titel und Lyricsprache kannst du vor dem Öffnen von MusicBrainz korrigieren.</span>`;
    dialog.appendChild(info);

    // Bearbeitbare Werk-Metadaten. AKM liefert Titel üblicherweise in Großbuchstaben;
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
    langSelect.value = String(data.languageId || CONFIG.mbLanguageId || '145');
    if (langSelect.value !== String(data.languageId || CONFIG.mbLanguageId || '145')) {
      langSelect.value = '145';
    }
    langWrap.appendChild(langSelect);

    const langHint = makeEl('div', 'grid-column:2;font-size:.74rem;color:#777;margin-top:-.45rem;', 'Die Auswahl wird direkt als MusicBrainz-Sprach-ID übernommen.');
    meta.append(titleWrap, langWrap, langHint);
    dialog.appendChild(meta);

    const table = makeEl('table', 'border-collapse:collapse;width:calc(100% - 2.5rem);margin:0 1.25rem;font-size:.86rem;');
    const headRow = makeEl('tr', 'background:#f3e8a8;');
    ['Rolle', 'AKM-Name / IPI', 'MusicBrainz-Match', 'Aktion'].forEach((x) => {
      headRow.appendChild(makeEl('th', 'text-align:left;padding:.45rem .55rem;border:1px solid #d5c77b;', x));
    });
    table.appendChild(headRow);

    const states = data.roles.map((r) => ({ role: r, selected: null, candidates: [], status: 'pending' }));
    const rowRefs = [];

    data.roles.forEach((r, idx) => {
      const tr = makeEl('tr');
      const roleTd = makeEl('td', 'padding:.45rem .55rem;border:1px solid #ddd;white-space:nowrap;');
      roleTd.textContent = AKM_ROLE_MAP[r.role] ? r.role : `${r.role} ⚠`;
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

      const clearBtn = makeEl('button', 'padding:.25rem .55rem;cursor:pointer;', 'Auswahl löschen');
      clearBtn.onclick = () => { states[idx].selected = null; render(); };
      actionTd.appendChild(clearBtn);

      tr.append(roleTd, nameTd, matchTd, actionTd);
      table.appendChild(tr);
      rowRefs.push({ tr, status, candidatesBox, searchInput });

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
          const a = await fetchArtist(m[0]);
          if (a) list = [a];
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
        if (!AKM_ROLE_MAP[r.role]) {
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

    dialog.appendChild(table);

    const footer = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.25rem;position:sticky;bottom:0;background:#fff;border-top:1px solid #ddd;');
    const footerStatus = makeEl('div', 'font-size:.85rem;color:#666;', 'Bitte alle gemappten Rollen prüfen.');
    const createBtn = makeEl('button', 'border:0;border-radius:4px;padding:.55rem 1rem;background:#2b7cff;color:#fff;font-weight:700;cursor:pointer;', '✓ Werk in MusicBrainz erstellen →');
    createBtn.onclick = () => {
      const unresolvedMapped = states.filter((s) => AKM_ROLE_MAP[s.role.role] && !s.selected);
      if (unresolvedMapped.length) {
        alert(`Noch nicht aufgelöst:\n\n${unresolvedMapped.map((s) => `${s.role.role}: ${s.role.name}`).join('\n')}\n\nBitte einen Treffer auswählen oder manuell suchen.`);
        return;
      }
      createBtn.disabled = true;
      createBtn.textContent = 'Speichere…';
      const prepared = {
        ...data,
        title: titleInput.value.trim() || data.title,
        languageId: langSelect.value.trim(),
        roles: states.map((s) => ({
          ...s.role,
          mbid: s.selected ? s.selected.id : null,
          mbName: s.selected ? s.selected.name : null,
        })),
      };
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
    GM_setValue(GM_PREFIX + data.iswc, JSON.stringify(data));

    const params = new URLSearchParams();
    params.set('edit-work.name', data.title);
    params.set('edit-work.iswcs.0', data.iswc);
    params.set('edit-work.type_id', CONFIG.mbWorkTypeId);

    // Werknummer als MusicBrainz-Attribut. Der AKM-Wert wird unverändert
    // (abgesehen von führenden/abschließenden Leerzeichen) übernommen.
    if (CONFIG.mbWerknummerAttributeTypeId && !String(CONFIG.mbWerknummerAttributeTypeId).startsWith('TODO') && data.werknummer) {
      params.set('edit-work.attributes.0.type_id', CONFIG.mbWerknummerAttributeTypeId);
      params.set('edit-work.attributes.0.value', String(data.werknummer).trim());
    }

    // MusicBrainz erwartet beim Work-Seed die numerische Sprach-ID.
    // Die Auswahl stammt direkt aus der auf der AKM-Prüfmaske angezeigten
    // Zuordnung (z. B. Deutsch = 145).
    if (data.languageId) {
      params.set('edit-work.languages.0', String(data.languageId));
    }
    params.set('edit-work.edit_note', `${data.akmUrl}\nISWC: ${data.iswc}\nAKM-Werknummer: ${data.werknummer}`);

    const createUrl = `https://musicbrainz.org/work/create?${params.toString()}#${MB_PREFIX}${encodeURIComponent(data.iswc)}`;
    const tab = window.open(createUrl, '_blank');
    if (!tab) {
      alert('Popup blockiert — bitte Popups für musicbrainz.org erlauben und erneut versuchen.');
    }
  }

  function initAkmSide() {
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
        console.info('[AKM-Import] relationshipEditor bereit:', re.state.entity);
        return re;
      }
      if (waited % 3000 === 0) {
        console.info('[AKM-Import] warte auf relationshipEditor…', waited, {
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

  function dispatchWorkRelationship(re, workEntity, artistEntity, linkTypeID) {
    if (!workEntity || workEntity.entityType !== 'work') {
      throw new Error(`Ungültige Work-Entity: ${JSON.stringify(workEntity)}`);
    }
    if (!artistEntity || artistEntity.entityType !== 'artist') {
      throw new Error(`Ungültige Artist-Entity: ${JSON.stringify(artistEntity)}`);
    }
    if (!linkTypeID) {
      throw new Error('Keine linkTypeID');
    }

    // Identisch mit der robusten Logik des Credit Hoarder:
    // source/target werden anhand entityType in entity0/entity1 sortiert.
    const swapped = workEntity.entityType > artistEntity.entityType;
    const e0 = swapped ? artistEntity : workEntity;
    const e1 = swapped ? workEntity : artistEntity;

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

  function getStoredWorkData(iswc) {
    const raw = GM_getValue(GM_PREFIX + iswc, null);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  function addMBStatus(message, ok = false) {
    let box = document.getElementById('akm-work-mb-status');
    if (!box) {
      box = document.createElement('div');
      box.id = 'akm-work-mb-status';
      box.style.cssText = 'margin:1rem 0;padding:.7rem 1rem;border:2px solid #c8a000;border-radius:5px;background:#fffef5;font-family:inherit;';
      const anchor = document.querySelector('#content') || document.body;
      anchor.insertBefore(box, anchor.firstChild);
    }
    box.style.borderColor = ok ? '#57a957' : '#c8a000';
    box.innerHTML = `<strong>${ok ? '✓' : 'AKM'}</strong> ${escapeHtml(message)}`;
    return box;
  }

  async function importRelationshipsOnWorkCreate(data) {
    const mapped = data.roles.filter((r) => AKM_ROLE_MAP[r.role] && r.mbid);
    if (!mapped.length) {
      addMBStatus('Keine gematchten Artists vorhanden – Werk kann normal eingetragen werden.', true);
      return;
    }

    const re = await waitForMBEditor();
    if (!re) {
      addMBStatus('Der MusicBrainz Relationship Editor wurde auf /work/create nicht gefunden. Die Werkdaten wurden trotzdem vorausgefüllt. Bitte Browser-Konsole prüfen.');
      console.warn('[AKM-Import] Kein MB.relationshipEditor auf /work/create.');
      return;
    }

    const workEntity = re.state.entity;
    let added = 0;
    const failures = [];

    for (const role of mapped) {
      const relation = AKM_ROLE_MAP[role.role];
      const linkTypeID = resolveLinkTypeId(relation, 'artist', 'work');
      if (!linkTypeID) {
        failures.push(`${role.role}: Relationship-Typ ${relation} nicht gefunden`);
        continue;
      }
      const artistEntity = await fetchEntityDetails(role.mbid);
      if (!artistEntity) {
        failures.push(`${role.role}: Artist ${role.mbid} nicht geladen`);
        continue;
      }
      try {
        console.info('[AKM-Import] Beziehung vorbereiten:', {
          relation,
          linkTypeID,
          workEntity,
          artistEntity,
        });
        dispatchWorkRelationship(re, workEntity, artistEntity, linkTypeID);
        added++;
      } catch (e) {
        console.error('[AKM-Import] dispatch failed', e);
        failures.push(`${role.role}: ${e.message || e}`);
      }
    }

    if (failures.length) {
      addMBStatus(`${added} Beziehung(en) eingefügt; ${failures.length} Problem(e): ${failures.join(' | ')}`);
    } else {
      addMBStatus(`${added} AKM-Beziehung(en) eingefügt. Bitte im Formular prüfen und anschließend „Werk eintragen“ klicken.`, true);
    }

    GM_deleteValue(GM_PREFIX + data.iswc);
  }

  async function initWorkPage() {
    if (!/^\/work\/create\/?$/i.test(location.pathname)) return;
    const hash = location.hash || '';
    const m = hash.match(/#akm-work-import:([^&]+)/);
    if (!m) return;
    const iswc = decodeURIComponent(m[1]);
    console.info('[AKM-Import] /work/create für AKM-Import:', iswc);

    const data = getStoredWorkData(iswc);
    if (!data) {
      console.warn('[AKM-Import] Keine gespeicherten AKM-Daten für', iswc);
      addMBStatus(`Keine gespeicherten AKM-Daten für ${iswc} gefunden.`);
      return;
    }

    addMBStatus(`AKM-Daten geladen. Warte auf MusicBrainz Relationship Editor…`);
    await importRelationshipsOnWorkCreate(data);
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------
  if (/^www\.akm-aume\.at$/i.test(location.hostname) || /akm-aume\.at$/i.test(location.hostname)) {
    initAkmSide();
  } else if (/^(www\.)?musicbrainz\.org$/i.test(location.hostname)) {
    initWorkPage();
  }
})();
