// ==UserScript==
// @name         YouTube 오래된 순 정주행
// @namespace    youtube-oldest-first-binge
// @version      1.7.0
// @description  채널 동영상을 가장 오래된 영상부터, 재생목록은 정해진 순서(또는 거꾸로)로 이어서 재생합니다.
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/cyclring/youtube-oldest-first/main/youtube-oldest-first.user.js
// @downloadURL  https://raw.githubusercontent.com/cyclring/youtube-oldest-first/main/youtube-oldest-first.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ───────── 목록 가져오기 (브라우저/테스트 공용) ─────────

  function findToken(o) {
    if (!o || typeof o !== 'object') return null;
    if (o.continuationCommand && typeof o.continuationCommand.token === 'string') {
      return o.continuationCommand.token;
    }
    for (const k in o) {
      const t = findToken(o[k]);
      if (t) return t;
    }
    return null;
  }

  function findBadge(o) {
    if (!o || typeof o !== 'object') return '';
    if (o.thumbnailBadgeViewModel && o.thumbnailBadgeViewModel.text) return o.thumbnailBadgeViewModel.text;
    for (const k in o) {
      const t = findBadge(o[k]);
      if (t) return t;
    }
    return '';
  }

  function lockupInfo(lv) {
    const md = (lv.metadata && lv.metadata.lockupMetadataViewModel) || {};
    const rows = (md.metadata && md.metadata.contentMetadataViewModel &&
      md.metadata.contentMetadataViewModel.metadataRows) || [];
    let age = '';
    for (const r of rows) {
      for (const p of r.metadataParts || []) {
        const t = p.text && p.text.content;
        if (t && /(전|ago)$/.test(t)) age = t;
      }
    }
    return { id: lv.contentId, title: (md.title && md.title.content) || '', len: findBadge(lv.contentImage), age };
  }

  function legacyInfo(pv) {
    const t = pv.title || {};
    return {
      id: pv.videoId,
      title: t.simpleText || (t.runs || []).map((r) => r.text).join(''),
      len: (pv.lengthText && pv.lengthText.simpleText) || '',
      age: '',
    };
  }

  // 재생목록 응답 한 페이지에서 영상 정보와 다음 페이지 토큰을 꺼낸다.
  function parsePage(json) {
    const videos = [];
    const playlists = [];
    let token = null;
    (function walk(o) {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (!o || typeof o !== 'object') return;
      const lv = o.lockupViewModel;
      if (lv && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && lv.contentId) {
        videos.push(lockupInfo(lv));
        return;
      }
      if (lv && lv.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' && lv.contentId) {
        const md = (lv.metadata && lv.metadata.lockupMetadataViewModel) || {};
        playlists.push({ id: lv.contentId, title: (md.title && md.title.content) || '', count: findBadge(lv.contentImage) });
        return;
      }
      const pv = o.playlistVideoRenderer; // 예전 형식
      if (pv && pv.videoId) {
        videos.push(legacyInfo(pv));
        return;
      }
      const cont = o.continuationItemViewModel || o.continuationItemRenderer;
      if (cont) {
        token = findToken(cont) || token;
        return;
      }
      for (const k in o) walk(o[k]);
    })([json && json.contents, json && json.onResponseReceivedActions]);
    const meta = json && json.metadata && json.metadata.playlistMetadataRenderer;
    return { videos, playlists, token, title: (meta && meta.title) || '' };
  }

  // 업로드 재생목록 전체를 받아 최신순 배열로 돌려준다.
  async function fetchPlaylist(post, playlistId, onProgress) {
    const items = [];
    const seen = new Set();
    const usedTokens = new Set();
    let res = await post('browse', { browseId: 'VL' + playlistId });
    items.title = parsePage(res).title;
    for (let page = 0; page < 300; page++) {
      const { videos, token } = parsePage(res);
      for (const v of videos) {
        if (!seen.has(v.id)) { seen.add(v.id); items.push(v); }
      }
      if (onProgress) onProgress(items.length);
      if (!token || usedTokens.has(token)) break;
      usedTokens.add(token);
      res = await post('browse', { continuation: token });
    }
    return items;
  }

  // 채널의 일반 동영상(Shorts 제외)을 오래된 순으로. 비어 있으면 전체 업로드로 대체.
  async function fetchOldestFirst(post, channelId, onProgress) {
    const rest = channelId.slice(2);
    let items = await fetchPlaylist(post, 'UULF' + rest, onProgress);
    if (items.length === 0) items = await fetchPlaylist(post, 'UU' + rest, onProgress);
    return items.reverse();
  }

  async function resolveChannelId(post, base) {
    const m = base.match(/^\/channel\/(UC[\w-]{22})$/);
    if (m) return m[1];
    const r = await post('navigation/resolve_url', { url: 'https://www.youtube.com' + base });
    const id = r && r.endpoint && r.endpoint.browseEndpoint && r.endpoint.browseEndpoint.browseId;
    if (/^UC[\w-]{22}$/.test(id || '')) return id;
    throw new Error('채널 ID를 찾지 못했습니다');
  }

  const PLAYLISTS_TAB = 'EglwbGF5bGlzdHPyBgQKAkIA';

  // 채널이 만든 재생목록 목록(재생목록 탭)
  async function fetchChannelPlaylists(post, channelId) {
    const out = [];
    const seen = new Set();
    const usedTokens = new Set();
    let res = await post('browse', { browseId: channelId, params: PLAYLISTS_TAB });
    for (let page = 0; page < 100; page++) {
      const { playlists, token } = parsePage(res);
      for (const p of playlists) {
        if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
      }
      if (!token || usedTokens.has(token)) break;
      usedTokens.add(token);
      res = await post('browse', { continuation: token });
    }
    return out;
  }

  // 정주행 대상: 채널({ channelId | base }) 또는 재생목록({ listId, reverse })
  async function fetchSource(post, src, onProgress) {
    if (src.listId) {
      const items = await fetchPlaylist(post, src.listId, onProgress);
      return src.reverse ? items.reverse() : items;
    }
    const channelId = src.channelId || await resolveChannelId(post, src.base);
    return fetchOldestFirst(post, channelId, onProgress);
  }

  // 내 계정에 비공개 재생목록을 만들고 ids 순서대로 담는다. 추가가 안 되는 영상은 건너뛴다.
  async function savePlaylist(post, title, ids, onProgress, wait) {
    const pause = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const CHUNK = 50;
    let added = 0;
    const skipped = [];
    const report = () => { if (onProgress) onProgress(added + skipped.length); };
    const created = await post('playlist/create', { title, privacyStatus: 'PRIVATE', videoIds: ids.slice(0, 1) });
    const playlistId = created && created.playlistId;
    if (!playlistId) throw new Error('재생목록을 만들지 못했습니다');
    added = 1;
    report();
    async function add(chunk) {
      try {
        await pause(250);
        const r = await post('browse/edit_playlist', {
          playlistId,
          actions: chunk.map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id })),
        });
        if (r && r.status && r.status !== 'STATUS_SUCCEEDED') throw new Error(r.status);
        added += chunk.length;
        report();
      } catch (e) {
        if (e && e.fatal) throw e; // 로그인 문제는 나눠서 다시 해도 소용없다
        if (chunk.length === 1) { skipped.push(chunk[0]); report(); return; }
        const size = chunk.length > 10 ? 10 : 1; // 한 번에 많이 넣는 게 거절되면 잘게 나눠 다시
        for (let i = 0; i < chunk.length; i += size) await add(chunk.slice(i, i + size));
      }
    }
    for (let i = 1; i < ids.length; i += CHUNK) await add(ids.slice(i, i + CHUNK));
    return { playlistId, added, skipped };
  }

  const Core = { parsePage, fetchPlaylist, fetchOldestFirst, resolveChannelId, fetchSource, savePlaylist, fetchChannelPlaylists };
  if (typeof module === 'object' && module.exports) { module.exports = Core; return; }

  // ───────── 여기부터 YouTube 페이지 동작 ─────────

  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function fatal(message) {
    return Object.assign(new Error(message), { fatal: true });
  }

  // YouTube 사이트가 로그인 요청에 붙이는 것과 같은 서명
  async function authHeader() {
    const sid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID') || readCookie('__Secure-1PAPISID');
    if (!sid) throw fatal('YouTube에 로그인돼 있어야 저장할 수 있습니다');
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sid + ' ' + location.origin));
    const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    return 'SAPISIDHASH ' + ts + '_' + hex;
  }

  // signedIn이면 내 계정으로(재생목록 저장용), 아니면 로그아웃 상태로 요청한다.
  function makePost(signedIn) {
    const cfg = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg : null;
    const get = (k, d) => (cfg && cfg.get(k)) || d;
    const context = {
      client: {
        clientName: 'WEB',
        clientVersion: get('INNERTUBE_CLIENT_VERSION', '2.20260904.01.00'),
        hl: get('HL', 'ko'),
        gl: get('GL', 'KR'),
      },
    };
    return async (endpoint, body) => {
      const headers = { 'Content-Type': 'application/json' };
      let query = '?prettyPrint=false';
      if (signedIn) {
        headers.Authorization = await authHeader();
        headers['X-Origin'] = location.origin;
        headers['X-Goog-AuthUser'] = String(get('SESSION_INDEX', '0'));
        headers['X-Youtube-Client-Name'] = '1';
        headers['X-Youtube-Client-Version'] = context.client.clientVersion;
        const pageId = get('DELEGATED_SESSION_ID', '');
        if (pageId) headers['X-Goog-PageId'] = pageId;
        const key = get('INNERTUBE_API_KEY', '');
        if (key) query += '&key=' + encodeURIComponent(key);
      }
      const r = await fetch('/youtubei/v1/' + endpoint + query, {
        method: 'POST',
        credentials: signedIn ? 'include' : 'omit',
        headers,
        body: JSON.stringify(Object.assign({ context }, body)),
      });
      if (signedIn && (r.status === 401 || r.status === 403)) {
        throw fatal('YouTube 로그인 확인에 실패했습니다 (' + r.status + ')');
      }
      if (!r.ok) throw new Error('YouTube 응답 오류 ' + r.status);
      return r.json();
    };
  }

  const KEY = 'oldestFirstBinge.v1';
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 저장 공간 없음 */ }
  }

  function channelBase(pathname) {
    const m = pathname.match(/^\/(@[^/]+|channel\/UC[\w-]{22}|c\/[^/]+|user\/[^/]+)/);
    return m ? '/' + m[1] : null;
  }
  function baseKey(base) {
    try { return decodeURIComponent(base).toLowerCase(); } catch (e) { return base.toLowerCase(); }
  }
  function currentVideoId() {
    return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
  }

  function applyItems(s, items) {
    s.ids = items.map((v) => v.id);
    s.meta = {};
    for (const v of items) s.meta[v.id] = [v.title, v.len, v.age];
  }

  function go(id) {
    const url = '/watch?v=' + id;
    const app = document.querySelector('ytd-app');
    if (app) {
      // YouTube 내부 페이지 이동(전체화면 유지). 안 되면 2.5초 뒤 일반 이동.
      try {
        app.dispatchEvent(new CustomEvent('yt-navigate', {
          bubbles: true,
          composed: true,
          detail: {
            endpoint: {
              commandMetadata: { webCommandMetadata: { url, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } },
              watchEndpoint: { videoId: id },
            },
          },
        }));
      } catch (e) { /* 아래 대체 이동 */ }
      setTimeout(() => { if (currentVideoId() !== id) location.assign(url); }, 2500);
      return;
    }
    location.assign(url);
  }

  function rememberProgress(s) {
    s.progress = s.progress || {};
    s.progress[s.key] = { videoId: s.ids[s.index], index: s.index, total: s.ids.length, reverse: !!s.reverse };
  }

  let movingFrom = null;
  function step(delta) {
    const s = load();
    if (!s.active || !s.ids) return;
    const vid = currentVideoId();
    if (vid && movingFrom === vid) return;
    const pos = vid ? s.ids.indexOf(vid) : -1;
    const next = (pos >= 0 ? pos : s.index) + delta;
    if (next < 0) return;
    if (next >= s.ids.length) {
      s.active = false;
      save(s);
      render();
      alert('정주행 목록의 마지막 영상까지 모두 봤습니다.');
      return;
    }
    movingFrom = vid;
    s.index = next;
    rememberProgress(s);
    save(s);
    go(s.ids[next]);
  }

  function jumpTo(i) {
    const s = load();
    if (!s.active || !s.ids || i < 0 || i >= s.ids.length || i === s.index) return;
    movingFrom = currentVideoId();
    s.index = i;
    rememberProgress(s);
    save(s);
    go(s.ids[i]);
  }

  // 1.0.0에서 시작한 정주행에는 제목 정보가 없어서 한 번 받아 온다.
  let metaLoading = false;
  let metaError = null;
  async function loadMeta() {
    if (metaLoading) return;
    metaLoading = true;
    try {
      const s0 = load();
      const src = s0.listId
        ? { listId: s0.listId, reverse: s0.reverse }
        : { channelId: s0.channelId, base: s0.base || encodeURI(s0.key || '') };
      const items = await fetchSource(makePost(), src);
      const s = load();
      s.meta = {};
      for (const v of items) s.meta[v.id] = [v.title, v.len, v.age];
      save(s);
    } catch (e) {
      metaError = (e && e.message) || String(e);
    } finally {
      metaLoading = false;
      render();
    }
  }

  // ───────── 화면 요소 ─────────

  const ITEM = 'all:unset;box-sizing:border-box;cursor:pointer;display:flex;gap:10px;align-items:flex-start;' +
    'width:100%;padding:6px 8px;border-radius:8px;';
  const SUB = 'all:unset;cursor:pointer;padding:6px 8px;border-radius:8px;';
  const STYLE = {
    // 화면 오른쪽 위(YouTube 상단 바 바로 아래)에 붙는다.
    box: 'position:fixed;top:64px;right:12px;z-index:2147483000;display:flex;flex-direction:column;' +
      'align-items:flex-end;max-width:calc(100vw - 24px);font:500 13px/1.3 Roboto,Arial,sans-serif',
    // 숨었을 때 보이는 손잡이: 밝은 화면과 어두운 화면 모두에서 보이도록 테두리를 둔다.
    tab: 'all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;' +
      'width:36px;height:36px;border-radius:50%;background:rgba(60,64,67,.92);color:#fff;' +
      'font:14px/1 Roboto,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35)',
    panel: 'display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%;box-sizing:border-box;' +
      'background:rgba(15,15,15,.94);color:#fff;padding:8px 10px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.35)',
    row: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center',
    btn: 'all:unset;cursor:pointer;padding:6px 10px;border-radius:8px;background:#3ea6ff;color:#0f0f0f;font-weight:700',
    sub: SUB + 'background:rgba(255,255,255,.14);color:#fff',
    subOn: SUB + 'background:#3ea6ff;color:#0f0f0f;font-weight:700',
    list: 'position:relative;width:400px;max-width:100%;max-height:min(60vh,520px);overflow-y:auto;' +
      'display:flex;flex-direction:column;gap:2px',
    head: 'display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:2px 8px 6px;color:#aaa;font-size:12px',
    small: SUB + 'padding:4px 8px;font-size:12px;background:rgba(255,255,255,.14);color:#fff',
    link: 'color:#3ea6ff;text-decoration:none;font-size:12px',
    pickRow: 'display:flex;gap:6px;align-items:center;padding:6px 8px;border-radius:8px',
    item: ITEM,
    itemCur: ITEM + 'background:rgba(62,166,255,.24)',
    num: 'flex:0 0 32px;text-align:right;color:#aaa;font-variant-numeric:tabular-nums',
    body: 'display:flex;flex-direction:column;gap:2px;min-width:0;flex:1',
    title: 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:#fff;font-weight:500',
    meta: 'color:#aaa;font-size:12px;font-variant-numeric:tabular-nums',
    note: 'padding:8px;color:#ccc',
  };

  function el(tag, style, text, onClick) {
    const e = document.createElement(tag);
    e.style.cssText = style || '';
    if (text) e.textContent = text;
    if (onClick) e.addEventListener('click', onClick);
    return e;
  }

  let box = null;
  let boxSig = '';
  // 내용이 바뀌었을 때만 다시 그린다. 새로 그렸으면 true.
  // 평소에는 아무것도 안 보이고, 마우스가 오른쪽 위 영역에 들어오면 동그란 버튼(tab)이,
  // 그 버튼에 마우스를 올리거나 누르면 패널이 보인다. tabText는 버튼 툴팁.
  function setBox(sig, build, tabText) {
    if (box && boxSig === sig && document.body.contains(box)) return false;
    if (box) box.remove();
    box = null;
    boxSig = sig;
    if (!build) return false;
    box = el('div', STYLE.box);
    box.id = 'oldest-first-binge';
    const tab = el('button', STYLE.tab, '▶', () => {
      lastInside = Date.now() + 1500;
      updateVisibility();
    });
    tab.setAttribute('data-tab', '');
    tab.title = tabText || '오래된 순 정주행';
    tab.setAttribute('aria-label', tab.title);
    const panel = el('div', STYLE.panel);
    panel.setAttribute('data-panel', '');
    build(panel);
    box.appendChild(tab);
    box.appendChild(panel);
    box.addEventListener('pointerdown', () => { lastInside = Date.now() + 1500; });
    document.body.appendChild(box);
    updateVisibility();
    return true;
  }

  // ───────── 자동 숨김 ─────────

  let mouseX = -1;
  let mouseY = -1;
  let lastInside = 0;
  let lastZone = 0;
  const ZONE_W = 200; // 오른쪽 끝에서 이만큼
  const ZONE_TOP = 56; // YouTube 상단 바 아래부터
  const ZONE_H = 110;

  // 버튼이 나타나는 영역. 요소를 깔지 않고 마우스 좌표로만 판단해서 아래 클릭을 막지 않는다.
  function pointerInZone() {
    if (mouseX < 0) return false;
    return mouseX >= window.innerWidth - ZONE_W && mouseY >= ZONE_TOP && mouseY <= ZONE_TOP + ZONE_H;
  }

  function pointerInBox() {
    if (!box || mouseX < 0) return false;
    const r = box.getBoundingClientRect();
    return mouseX >= r.left && mouseX <= r.right && mouseY >= r.top && mouseY <= r.bottom;
  }

  function updateVisibility() {
    if (!box) return;
    const now = Date.now();
    if (pointerInBox()) lastInside = Math.max(lastInside, now);
    if (pointerInZone()) lastZone = now;
    const show = busy || saving || picker.loading || now - lastInside < 800 || !!box.querySelector(':focus-visible');
    const want = show ? 'shown' : now - lastZone < 800 ? 'tab' : 'hidden';
    if (box.dataset.state === want) return;
    box.dataset.state = want;
    box.querySelector('[data-tab]').style.display = want === 'tab' ? 'inline-flex' : 'none';
    box.querySelector('[data-panel]').style.display = want === 'shown' ? 'flex' : 'none';
  }

  let moveQueued = false;
  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(() => { moveQueued = false; updateVisibility(); });
  }, { passive: true });
  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) { mouseX = -1; mouseY = -1; } // 창 밖으로 나감
  });

  function pageName() {
    return document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '');
  }

  // 재생목록 페이지나 재생목록으로 재생 중인 화면이면 목록 ID.
  // 나중에 볼 동영상·좋아요·믹스는 로그인/무한 목록이라 제외.
  function playlistOnPage() {
    if (location.pathname !== '/playlist' && location.pathname !== '/watch') return null;
    const id = new URLSearchParams(location.search).get('list');
    if (!id || /^(WL|LL|LM)$/.test(id) || id.startsWith('RD')) return null;
    return id;
  }

  // ───────── 내 재생목록으로 저장 ─────────

  let saving = false;
  let saveText = '';
  let saveFor = '';
  function setSaveText(key, t) {
    saveFor = key;
    saveText = t;
    const e = box && box.querySelector('[data-save]');
    if (e) e.textContent = t;
  }

  function savedTitle(s) {
    const name = (s.channelName || '정주행').slice(0, 120);
    return s.listId ? name + (s.reverse ? ' (거꾸로)' : ' (순서대로)') : name + ' - 오래된 순';
  }

  async function saveQueue() {
    if (saving) return;
    const s = load();
    if (!s.ids || !s.ids.length) return;
    if (s.saved && s.saved[s.key] &&
        !confirm('이 목록은 이미 내 재생목록으로 저장했습니다.\n새 재생목록을 하나 더 만들까요?')) return;
    const key = s.key;
    const ids = s.ids.slice(0, 5000); // YouTube 재생목록 최대 개수
    const title = savedTitle(s);
    saving = true;
    try {
      const post = makePost(true);
      setSaveText(key, '저장 중… 0/' + ids.length);
      const res = await savePlaylist(post, title, ids, (n) => setSaveText(key, '저장 중… ' + n + '/' + ids.length));
      const cur = load();
      cur.saved = cur.saved || {};
      cur.saved[key] = { playlistId: res.playlistId, count: res.added, title };
      save(cur);
      setSaveText(key, '순서 확인 중…');
      await new Promise((r) => setTimeout(r, 1500));
      let check;
      try {
        const back = (await fetchPlaylist(post, res.playlistId)).map((v) => v.id);
        const want = ids.filter((id) => !res.skipped.includes(id));
        check = back.join() === want.join() ? '순서 확인됨' : '순서가 다르게 보입니다. YouTube에서 확인해 주세요';
      } catch (e) {
        check = '순서는 확인하지 못했습니다';
      }
      setSaveText(key, '저장 완료 ' + res.added + '개' +
        (res.skipped.length ? ' (' + res.skipped.length + '개 건너뜀)' : '') + ' · ' + check +
        (s.ids.length > ids.length ? ' · 최대 5000개까지만 저장' : ''));
    } catch (e) {
      setSaveText(key, '저장 실패: ' + ((e && e.message) || e));
    } finally {
      saving = false;
      render();
    }
  }

  let busy = false;
  // src: { key, name } + 채널({ base }) 또는 재생목록({ listId, reverse })
  async function start(src, fromStart, label) {
    if (busy) return;
    busy = true;
    const show = (t) => { label.textContent = t; };
    try {
      show(src.listId ? '재생목록 확인 중…' : '채널 확인 중…');
      const post = makePost();
      if (!src.listId) src.channelId = await resolveChannelId(post, src.base);
      const items = await fetchSource(post, src, (n) => show('목록 불러오는 중… ' + n + '개'));
      if (items.length === 0) {
        throw new Error(src.listId ? '재생할 영상이 없습니다 (비공개 재생목록은 지원하지 않습니다)' : '재생할 영상이 없습니다');
      }
      const s = load();
      applyItems(s, items);
      const prev = s.progress && s.progress[src.key];
      let index = 0;
      if (!fromStart && prev) {
        index = s.ids.indexOf(prev.videoId);
        if (index < 0) index = Math.min(prev.index || 0, s.ids.length - 1);
      }
      Object.assign(s, {
        active: true,
        key: src.key,
        base: src.base || null,
        channelId: src.channelId || null,
        listId: src.listId || null,
        reverse: !!src.reverse,
        channelName: src.name || items.title || '재생목록',
        index,
        dismissed: false,
      });
      rememberProgress(s);
      save(s);
      go(s.ids[index]);
    } catch (e) {
      show('실패: ' + (e && e.message ? e.message : e) + ' (다시 누르기)');
    } finally {
      busy = false;
    }
  }

  // 채널 페이지의 "재생목록" 고르기
  let picker = { base: '', open: false, loading: false, error: '', items: null };
  async function loadPicker(base) {
    picker = { base, open: true, loading: true, error: '', items: null };
    render();
    try {
      const post = makePost();
      const items = await fetchChannelPlaylists(post, await resolveChannelId(post, base));
      if (picker.base === base) Object.assign(picker, { loading: false, items });
    } catch (e) {
      if (picker.base === base) Object.assign(picker, { loading: false, error: (e && e.message) || String(e) });
    }
    render();
  }
  function togglePicker(base) {
    if (picker.base === base && (picker.items || picker.loading)) {
      picker.open = !picker.open;
      render();
      return;
    }
    loadPicker(base);
  }

  function buildPicker(s) {
    const wrap = el('div', STYLE.list);
    wrap.setAttribute('data-picker', '');
    if (picker.loading) { wrap.appendChild(el('div', STYLE.note, '재생목록 불러오는 중…')); return wrap; }
    if (picker.error) {
      wrap.appendChild(el('div', STYLE.note, '재생목록을 불러오지 못했습니다: ' + picker.error));
      wrap.appendChild(el('button', STYLE.sub, '다시 시도', () => loadPicker(picker.base)));
      return wrap;
    }
    if (!picker.items.length) { wrap.appendChild(el('div', STYLE.note, '이 채널에는 공개 재생목록이 없습니다')); return wrap; }
    wrap.appendChild(el('div', STYLE.head, '채널 재생목록 ' + picker.items.length + '개'));
    for (const p of picker.items) {
      const key = 'pl:' + p.id;
      const prev = s.progress && s.progress[key];
      const row = el('div', STYLE.pickRow);
      const body = el('span', STYLE.body);
      body.appendChild(el('span', STYLE.title, p.title || p.id));
      const status = el('span', STYLE.meta, [p.count,
        prev ? (prev.index + 1) + '/' + prev.total + (prev.reverse ? ' 거꾸로' : '') + ' 보는 중' : ''].filter(Boolean).join(' · '));
      body.appendChild(status);
      row.appendChild(body);
      // 보던 방향이면 이어서, 아니면 처음부터
      const begin = (reverse) => start({ key, listId: p.id, reverse, name: p.title },
        !(prev && !!prev.reverse === reverse), status);
      const fwd = el('button', STYLE.small, '정주행', () => begin(false));
      fwd.title = '재생목록 순서대로' + (prev && !prev.reverse ? ' (보던 곳부터)' : '');
      const rev = el('button', STYLE.small, '거꾸로', () => begin(true));
      rev.title = '재생목록 반대 순서로' + (prev && prev.reverse ? ' (보던 곳부터)' : '');
      row.appendChild(fwd);
      row.appendChild(rev);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderChannel(base) {
    const s = load();
    const prev = s.progress && s.progress[baseKey(base)];
    const pk = picker.base === base ? [picker.open, picker.loading, picker.error, picker.items ? picker.items.length : ''].join(':') : '';
    const sig = 'ch|' + base + '|' + (prev ? prev.index + '/' + prev.total : '') + '|' + pk;
    setBox(sig, (b) => {
      const row = el('div', STYLE.row);
      const src = () => ({ key: baseKey(base), base, name: pageName() });
      const main = el('button', STYLE.btn,
        prev ? '▶ 이어보기 (' + (prev.index + 1) + '/' + prev.total + ')' : '▶ 오래된 순 정주행');
      main.addEventListener('click', () => start(src(), false, main));
      row.appendChild(main);
      if (prev) row.appendChild(el('button', STYLE.sub, '처음부터', () => start(src(), true, main)));
      const open = picker.base === base && picker.open;
      row.appendChild(el('button', open ? STYLE.subOn : STYLE.sub, '재생목록', () => togglePicker(base)));
      b.appendChild(row);
      if (open) b.appendChild(buildPicker(s));
    }, prev ? '이어보기 (' + (prev.index + 1) + '/' + prev.total + ')' : '오래된 순 정주행');
  }

  function renderPlaylist(listId) {
    const s = load();
    const key = 'pl:' + listId;
    const prev = s.progress && s.progress[key];
    const sig = 'pl|' + listId + '|' + (prev ? prev.index + '/' + prev.total + '/' + !!prev.reverse : '');
    setBox(sig, (b) => {
      const row = el('div', STYLE.row);
      const name = location.pathname === '/playlist' ? pageName() : '';
      const src = (reverse) => ({ key, listId, reverse, name });
      if (prev) {
        const main = el('button', STYLE.btn,
          '▶ 이어보기 (' + (prev.index + 1) + '/' + prev.total + (prev.reverse ? ', 거꾸로' : '') + ')');
        main.addEventListener('click', () => start(src(!!prev.reverse), false, main));
        row.appendChild(main);
        row.appendChild(el('button', STYLE.sub, '처음부터', () => start(src(!!prev.reverse), true, main)));
        row.appendChild(el('button', STYLE.sub, prev.reverse ? '▶ 순서대로 처음부터' : '⇅ 거꾸로 처음부터',
          () => start(src(!prev.reverse), true, main)));
      } else {
        const main = el('button', STYLE.btn, '▶ 재생목록 정주행');
        main.addEventListener('click', () => start(src(false), true, main));
        row.appendChild(main);
        row.appendChild(el('button', STYLE.sub, '⇅ 거꾸로 정주행', () => start(src(true), true, main)));
      }
      b.appendChild(row);
    }, '재생목록 정주행');
  }

  function buildList(s) {
    const list = el('div', STYLE.list);
    list.setAttribute('data-list', '');
    if (!s.meta) {
      list.appendChild(el('div', STYLE.note, metaError ? '목록을 불러오지 못했습니다: ' + metaError : '목록 불러오는 중…'));
      if (metaError) {
        list.appendChild(el('button', STYLE.sub, '다시 시도', () => { metaError = null; loadMeta(); render(); }));
      }
      return list;
    }
    const head = el('div', STYLE.head);
    head.appendChild(el('span', '',
      (s.listId ? (s.reverse ? '재생목록 거꾸로' : '재생목록 순서') : '오래된 순') +
      ' · 전체 ' + s.ids.length + '개 · 본 영상 ' + s.index + '개'));
    const saveBtn = el('button', STYLE.small,
      (saveFor === s.key && saveText) || '재생목록으로 저장', saveQueue);
    saveBtn.setAttribute('data-save', '');
    saveBtn.title = '이 순서 그대로 내 YouTube 재생목록(비공개)으로 저장합니다';
    head.appendChild(saveBtn);
    const saved = s.saved && s.saved[s.key];
    if (saved) {
      const a = el('a', STYLE.link, '저장한 재생목록 열기');
      a.href = '/playlist?list=' + encodeURIComponent(saved.playlistId);
      a.target = '_blank';
      a.rel = 'noopener';
      head.appendChild(a);
    }
    list.appendChild(head);
    s.ids.forEach((id, i) => {
      const m = s.meta[id] || ['(제목 정보 없음)', '', ''];
      const cur = i === s.index;
      const item = el('button', cur ? STYLE.itemCur : STYLE.item, null, () => jumpTo(i));
      item.title = m[0];
      if (cur) item.setAttribute('data-current', '');
      if (i < s.index) item.style.opacity = '0.55';
      item.appendChild(el('span', STYLE.num, cur ? '▶' : String(i + 1)));
      const body = el('span', STYLE.body);
      body.appendChild(el('span', STYLE.title, m[0] || '(제목 없음)'));
      const info = [m[1], m[2]].filter(Boolean).join(' · ');
      if (info) body.appendChild(el('span', STYLE.meta, info));
      item.appendChild(body);
      list.appendChild(item);
    });
    return list;
  }

  function renderWatch(s) {
    const open = !!s.listOpen;
    const savedId = s.saved && s.saved[s.key] ? s.saved[s.key].playlistId : '';
    const sig = ['w', s.index, s.ids.length, open, !!s.meta, metaLoading, metaError, savedId].join('|');
    const rebuilt = setBox(sig, (b) => {
      const row = el('div', STYLE.row);
      const label = el('span', 'opacity:.85;padding:0 4px;max-width:260px;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap',
        '정주행 ' + (s.channelName || '') + '  ' + (s.index + 1) + ' / ' + s.ids.length);
      label.title = s.channelName || '';
      row.appendChild(label);
      row.appendChild(el('button', STYLE.sub, '◀ 이전', () => step(-1)));
      row.appendChild(el('button', STYLE.sub, '다음 ▶', () => step(1)));
      row.appendChild(el('button', open ? STYLE.subOn : STYLE.sub, '목록', () => {
        const cur = load();
        cur.listOpen = !cur.listOpen;
        save(cur);
        render();
      }));
      row.appendChild(el('button', STYLE.sub, '끄기', () => {
        const cur = load();
        cur.active = false;
        save(cur);
        render();
      }));
      b.appendChild(row);
      if (open) b.appendChild(buildList(s));
    }, '정주행 ' + (s.index + 1) + '/' + s.ids.length);
    if (rebuilt && open) {
      // 지금 보는 영상이 목록 가운데 오도록
      const list = box.querySelector('[data-list]');
      const cur = list && list.querySelector('[data-current]');
      if (cur) list.scrollTop = cur.offsetTop - list.clientHeight / 2 + cur.offsetHeight / 2;
    }
    if (open && !s.meta && !metaLoading && !metaError) loadMeta();
  }

  // 정주행 중인 영상이 맞으면 상태를 돌려준다.
  function syncWatch() {
    const s = load();
    const vid = currentVideoId();
    if (!s.active || !s.ids || !vid) return null;
    const pos = s.ids.indexOf(vid);
    if (pos < 0) return null;
    if (pos !== s.index) {
      s.index = pos; // 목록 안의 다른 영상을 직접 골랐을 때
      rememberProgress(s);
      save(s);
    }
    return s;
  }

  // 다른 화면에서도 마지막 정주행을 이어볼 수 있게 손잡이를 남긴다.
  function renderResume(s, prev) {
    const sig = 'r|' + s.key + '|' + prev.index + '/' + prev.total + '|' + !!s.active;
    setBox(sig, (b) => {
      const row = el('div', STYLE.row);
      const main = el('button', STYLE.btn + ';max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        '▶ 이어보기: ' + (s.channelName || '') + ' (' + (prev.index + 1) + '/' + prev.total + ')');
      main.addEventListener('click', () => {
        const cur = load();
        const i = cur.ids.indexOf(prev.videoId);
        cur.index = i >= 0 ? i : Math.min(prev.index || 0, cur.ids.length - 1);
        cur.active = true;
        save(cur);
        go(cur.ids[cur.index]);
      });
      row.appendChild(main);
      row.appendChild(el('button', STYLE.sub, '숨기기', () => {
        const cur = load();
        cur.dismissed = true; // 새 정주행을 시작하면 다시 나타난다
        save(cur);
        render();
      }));
      b.appendChild(row);
    }, '이어보기: ' + (s.channelName || ''));
  }

  function render() {
    if (!document.body) return;
    const s = syncWatch();
    if (s) { renderWatch(s); return; }
    const listId = playlistOnPage();
    if (listId) { renderPlaylist(listId); return; }
    const base = channelBase(location.pathname);
    if (base) { renderChannel(base); return; }
    const last = load();
    const prev = last.ids && last.ids.length && !last.dismissed && last.progress && last.progress[last.key];
    if (prev) { renderResume(last, prev); return; }
    setBox('', null);
  }

  // ───────── 영상 끝 감지 ─────────

  function mainVideoEnded() {
    const vid = currentVideoId();
    const p = document.getElementById('movie_player');
    if (!vid || !p || p.classList.contains('ad-showing')) return false;
    try {
      const data = p.getVideoData();
      if (!data || data.video_id !== vid) return false; // 이전 영상 정보가 남아 있는 전환 순간
      const dur = p.getDuration();
      const cur = p.getCurrentTime();
      return dur > 0 && cur >= dur - 3;
    } catch (e) {
      return false;
    }
  }

  let errorSince = 0;
  function tick() {
    const vid = currentVideoId();
    if (movingFrom && vid !== movingFrom) movingFrom = null;
    render();
    updateVisibility();
    if (!syncWatch()) { errorSince = 0; return; }
    const p = document.getElementById('movie_player');
    if (!p) return;
    let state = null;
    try { state = p.getPlayerState(); } catch (e) { /* 플레이어 준비 전 */ }
    if (state === 0 && mainVideoEnded()) { step(1); return; }
    // 재생 불가(회원 전용 등) 화면이 4초 넘게 떠 있으면 건너뛴다.
    const err = p.querySelector('.ytp-error');
    if (err && err.offsetParent !== null) {
      if (!errorSince) errorSince = Date.now();
      else if (Date.now() - errorSince > 4000) { errorSince = 0; step(1); }
    } else {
      errorSince = 0;
    }
  }

  document.addEventListener('ended', (e) => {
    const p = document.getElementById('movie_player');
    if (!(e.target instanceof HTMLVideoElement) || !p || !p.contains(e.target)) return;
    if (syncWatch() && mainVideoEnded()) step(1);
  }, true);

  document.addEventListener('yt-navigate-finish', () => setTimeout(render, 0));
  setInterval(tick, 500);
  render();
})();
