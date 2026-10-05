// ==UserScript==
// @name         YouTube 오래된 순 정주행
// @namespace    youtube-oldest-first-binge
// @version      1.2.0
// @description  채널 동영상을 가장 오래된 영상부터 순서대로 이어서 재생합니다.
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
    let token = null;
    (function walk(o) {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (!o || typeof o !== 'object') return;
      const lv = o.lockupViewModel;
      if (lv && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && lv.contentId) {
        videos.push(lockupInfo(lv));
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
    return { videos, token };
  }

  // 업로드 재생목록 전체를 받아 최신순 배열로 돌려준다.
  async function fetchPlaylist(post, playlistId, onProgress) {
    const items = [];
    const seen = new Set();
    const usedTokens = new Set();
    let res = await post('browse', { browseId: 'VL' + playlistId });
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

  const Core = { parsePage, fetchPlaylist, fetchOldestFirst, resolveChannelId };
  if (typeof module === 'object' && module.exports) { module.exports = Core; return; }

  // ───────── 여기부터 YouTube 페이지 동작 ─────────

  function makePost() {
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
      const r = await fetch('/youtubei/v1/' + endpoint + '?prettyPrint=false', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ context }, body)),
      });
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
    s.progress[s.key] = { videoId: s.ids[s.index], index: s.index, total: s.ids.length };
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
      const post = makePost();
      const channelId = s0.channelId || await resolveChannelId(post, s0.base || encodeURI(s0.key || ''));
      const items = await fetchOldestFirst(post, channelId);
      const s = load();
      s.meta = {};
      for (const v of items) s.meta[v.id] = [v.title, v.len, v.age];
      s.channelId = channelId;
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
    box: 'position:fixed;top:64px;right:0;z-index:2147483000;display:flex;align-items:stretch;gap:6px;' +
      'max-width:calc(100vw - 24px);background:rgba(15,15,15,.94);color:#fff;padding:8px 10px 8px 6px;' +
      'border-radius:12px 0 0 12px;font:500 13px/1.3 Roboto,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)',
    grip: 'flex:0 0 4px;margin:4px 0;border-radius:2px;background:rgba(255,255,255,.45)',
    inner: 'display:flex;flex-direction:column;gap:8px;min-width:0',
    row: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center',
    btn: 'all:unset;cursor:pointer;padding:6px 10px;border-radius:8px;background:#3ea6ff;color:#0f0f0f;font-weight:700',
    sub: SUB + 'background:rgba(255,255,255,.14);color:#fff',
    subOn: SUB + 'background:#3ea6ff;color:#0f0f0f;font-weight:700',
    list: 'position:relative;width:400px;max-width:100%;max-height:min(60vh,520px);overflow-y:auto;' +
      'display:flex;flex-direction:column;gap:2px',
    head: 'padding:2px 8px 6px;color:#aaa;font-size:12px',
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
  let peekKey = '';
  // 내용이 바뀌었을 때만 다시 그린다. 새로 그렸으면 true.
  // key가 바뀌면(새 영상, 다른 채널) 잠깐 보여 줬다가 숨긴다.
  function setBox(sig, build, key) {
    if (box && boxSig === sig && document.body.contains(box)) return false;
    if (box) box.remove();
    box = null;
    boxSig = sig;
    if (!build) return false;
    box = el('div', STYLE.box);
    box.id = 'oldest-first-binge';
    if (!REDUCED_MOTION) box.style.transition = 'transform .18s ease, opacity .18s ease';
    box.appendChild(el('div', STYLE.grip));
    const inner = el('div', STYLE.inner);
    build(inner);
    box.appendChild(inner);
    box.addEventListener('pointerdown', () => { lastInside = Date.now() + 1500; });
    document.body.appendChild(box);
    if (key && key !== peekKey) {
      peekKey = key;
      peekUntil = Date.now() + 3000;
    }
    updateVisibility();
    return true;
  }

  // ───────── 자동 숨김 ─────────
  // 숨었을 때는 오른쪽 끝에 손잡이(14px)만 남고, 마우스를 올리면 펼쳐진다.

  const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const HIDDEN = 'translateX(calc(100% - 14px))';
  let mouseX = -1;
  let mouseY = -1;
  let lastInside = 0;
  let peekUntil = 0;

  function pointerInBox() {
    if (!box || mouseX < 0) return false;
    const r = box.getBoundingClientRect();
    return mouseX >= r.left && mouseX <= r.right && mouseY >= r.top && mouseY <= r.bottom;
  }

  function updateVisibility() {
    if (!box) return;
    const now = Date.now();
    if (pointerInBox()) lastInside = Math.max(lastInside, now);
    const show = busy || now < peekUntil || now - lastInside < 800 || !!box.querySelector(':focus-visible');
    const want = show ? 'shown' : 'hidden';
    if (box.dataset.state === want) return;
    box.dataset.state = want;
    box.style.transform = show ? 'none' : HIDDEN;
    box.style.opacity = show ? '1' : '0.6';
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

  let busy = false;
  async function start(base, fromStart, label) {
    if (busy) return;
    busy = true;
    const show = (t) => { label.textContent = t; };
    try {
      show('채널 확인 중…');
      const post = makePost();
      const channelId = await resolveChannelId(post, base);
      const items = await fetchOldestFirst(post, channelId, (n) => show('목록 불러오는 중… ' + n + '개'));
      if (items.length === 0) throw new Error('재생할 영상이 없습니다');
      const s = load();
      const key = baseKey(base);
      applyItems(s, items);
      const prev = s.progress && s.progress[key];
      let index = 0;
      if (!fromStart && prev) {
        index = s.ids.indexOf(prev.videoId);
        if (index < 0) index = Math.min(prev.index || 0, s.ids.length - 1);
      }
      Object.assign(s, {
        active: true,
        key,
        base,
        channelId,
        channelName: document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, ''),
        index,
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

  function renderChannel(base) {
    const s = load();
    const prev = s.progress && s.progress[baseKey(base)];
    const sig = 'ch|' + base + '|' + (prev ? prev.index + '/' + prev.total : '');
    setBox(sig, (b) => {
      const row = el('div', STYLE.row);
      const main = el('button', STYLE.btn,
        prev ? '▶ 이어보기 (' + (prev.index + 1) + '/' + prev.total + ')' : '▶ 오래된 순 정주행');
      main.addEventListener('click', () => start(base, false, main));
      row.appendChild(main);
      if (prev) row.appendChild(el('button', STYLE.sub, '처음부터', () => start(base, true, main)));
      b.appendChild(row);
    }, 'ch|' + base);
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
    list.appendChild(el('div', STYLE.head,
      '오래된 순 · 전체 ' + s.ids.length + '개 · 본 영상 ' + s.index + '개'));
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
    const sig = ['w', s.index, s.ids.length, open, !!s.meta, metaLoading, metaError].join('|');
    const rebuilt = setBox(sig, (b) => {
      const row = el('div', STYLE.row);
      row.appendChild(el('span', 'opacity:.85;padding:0 4px',
        '정주행 ' + (s.channelName || '') + '  ' + (s.index + 1) + ' / ' + s.ids.length));
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
    }, 'w|' + s.index);
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

  function render() {
    if (!document.body) return;
    const s = syncWatch();
    if (s) { renderWatch(s); return; }
    const base = channelBase(location.pathname);
    if (base) { renderChannel(base); return; }
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
