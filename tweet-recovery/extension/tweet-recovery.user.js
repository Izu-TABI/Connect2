// ==UserScript==
// @name         Tweet Recovery - 見たツイート履歴
// @namespace    https://github.com/Izu-TABI
// @version      0.1.0
// @description  X (Twitter) で画面に表示されたツイートを自動でブラウザ内に記録し、タイムラインを更新して見失ったツイートを後から探せるようにします。
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

// このファイルはユーザースクリプトとしても、Chrome 拡張機能のコンテンツスクリプトとしても動く。
// 記録はすべてブラウザ内 (x.com の IndexedDB) に保存され、外部には一切送信しない。

(() => {
  'use strict';

  // 拡張機能とユーザースクリプトを両方入れていても二重に動かないようにする
  const docEl = document.documentElement;
  if (docEl.hasAttribute('data-tweet-recovery')) return;
  docEl.setAttribute('data-tweet-recovery', '');

  /* ------------------------------------------------------------------ *
   * 設定
   * ------------------------------------------------------------------ */

  const DB_NAME = 'tweet-recovery';
  const STORE = 'tweets';
  const SETTINGS_KEY = 'tweet-recovery:settings';
  const DEFAULT_SETTINGS = { retentionDays: 30, paused: false, fab: null };
  const SEEN_RATIO = 0.5; // 画面に半分以上入ったら「見た」とみなす
  const TICK_MS = 1000;
  const PAGE_SIZE = 30;
  const MAX_MEDIA = 4;
  const DAY = 86400000;
  const HANDLE_RE = /^\w{1,50}$/;

  // X の DOM で頼りにしている目印。X 側の変更で記録されなくなったら、まずここを直す。
  const SEL = {
    tweet: 'article[data-testid="tweet"]',
    text: '[data-testid="tweetText"]',
    showMore: '[data-testid="tweet-text-show-more-link"]',
    userName: '[data-testid="User-Name"]',
    avatar: '[data-testid="Tweet-User-Avatar"] img',
    photo: '[data-testid="tweetPhoto"] img',
    video: 'video',
    context: '[data-testid="socialContext"]',
    quoteBox: 'div[role="link"]',
  };

  const settings = loadSettings();

  function loadSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // プライベートモードなどで保存できなくても動作は続ける
    }
  }

  const warn = (...args) => console.warn('[tweet-recovery]', ...args);

  /* ------------------------------------------------------------------ *
   * 保存 (IndexedDB)
   * ------------------------------------------------------------------ */

  let dbPromise = null;

  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('lastSeenAt', 'lastSeenAt');
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => {
          dbPromise = null;
          reject(req.error);
        };
      });
    }
    return dbPromise;
  }

  async function tx(mode) {
    const t = (await openDB()).transaction(STORE, mode);
    const done = new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error);
    });
    done.catch(() => {}); // 読み取り専用では done を待たないので、未処理の reject にしない
    return { store: t.objectStore(STORE), done };
  }

  const result = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  // 1 秒ごとにまとめて書き込む。id -> { rec, dwell, seenAt }
  const pending = new Map();
  let flushChain = Promise.resolve();

  function enqueue(id, rec, dwell, seenAt) {
    const p = pending.get(id);
    if (p) {
      if (rec) p.rec = rec;
      p.dwell += dwell;
      p.seenAt = Math.max(p.seenAt, seenAt);
    } else {
      pending.set(id, { id, rec, dwell, seenAt });
    }
  }

  function flush() {
    flushChain = flushChain.then(writePending);
    return flushChain;
  }

  async function writePending() {
    if (!pending.size) return;
    const batch = [...pending.values()];
    pending.clear();
    try {
      const { store, done } = await tx('readwrite');
      for (const p of batch) {
        store.get(p.id).onsuccess = (e) => {
          const merged = merge(e.target.result, p.rec, p.dwell, p.seenAt);
          if (merged) store.put(merged);
        };
      }
      await done;
    } catch (err) {
      warn('保存に失敗しました', err);
    }
  }

  function merge(old, rec, dwell, seenAt) {
    if (!old && !rec) return null;
    const out = old
      ? { ...old }
      : { id: rec.id, firstSeenAt: seenAt, lastSeenAt: 0, dwellMs: 0, starred: 0, seenOn: rec.seenOn };
    if (rec) {
      for (const k of ['handle', 'name', 'avatar', 'time', 'context', 'quote']) {
        if (rec[k]) out[k] = rec[k];
      }
      // 詳細ページで全文を見た後にタイムラインの省略版で上書きしない
      if (!(old && !old.truncated && rec.truncated)) {
        out.text = rec.text;
        out.truncated = rec.truncated;
      }
      if (!out.media || rec.media.length >= out.media.length) out.media = rec.media;
    }
    out.lastSeenAt = Math.max(out.lastSeenAt, seenAt);
    out.dwellMs += dwell;
    return out;
  }

  async function search({ q, rangeMs, sort, starredOnly, offset, limit }) {
    const tokens = normalize(q).split(/\s+/).filter(Boolean);
    const range = rangeMs ? IDBKeyRange.lowerBound(Date.now() - rangeMs) : null;
    // 「見た順」は索引の順番のまま必要な分だけ読めばよい。「表示時間が長い順」は全件を並べ替える。
    const want = sort === 'recent' ? offset + limit + 1 : Infinity;
    const hits = [];
    const { store } = await tx('readonly');
    await new Promise((resolve, reject) => {
      const req = store.index('lastSeenAt').openCursor(range, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        const t = c.value;
        if ((!starredOnly || t.starred) && matches(t, tokens)) hits.push(t);
        if (hits.length >= want) return resolve();
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    if (sort === 'dwell') hits.sort((a, b) => b.dwellMs - a.dwellMs || b.lastSeenAt - a.lastSeenAt);
    return { items: hits.slice(offset, offset + limit), hasMore: hits.length > offset + limit };
  }

  function normalize(s) {
    return String(s || '').normalize('NFKC').toLowerCase();
  }

  function matches(t, tokens) {
    if (!tokens.length) return true;
    const q = t.quote || {};
    const hay = normalize(
      [t.text, t.name, '@' + t.handle, t.context, q.text, q.name, q.handle && '@' + q.handle].join('\n'),
    );
    return tokens.every((tok) => hay.includes(tok));
  }

  async function updateTweet(id, fn) {
    const { store, done } = await tx('readwrite');
    store.get(id).onsuccess = (e) => {
      if (e.target.result) store.put(fn(e.target.result));
    };
    await done;
  }

  async function removeTweet(id) {
    const { store, done } = await tx('readwrite');
    store.delete(id);
    await done;
  }

  async function clearAll() {
    const { store, done } = await tx('readwrite');
    store.clear();
    await done;
  }

  async function countAll() {
    const { store } = await tx('readonly');
    return result(store.count());
  }

  async function getAll() {
    const { store } = await tx('readonly');
    return result(store.getAll());
  }

  // 保存期間を過ぎたものを消す (★付きは残す)
  async function prune() {
    const days = Number(settings.retentionDays);
    if (!days) return;
    const { store, done } = await tx('readwrite');
    const req = store.index('lastSeenAt').openCursor(IDBKeyRange.upperBound(Date.now() - days * DAY));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (!c.value.starred) c.delete();
      c.continue();
    };
    await done;
  }

  async function importTweets(list) {
    const records = list.map(sanitize).filter(Boolean);
    const { store, done } = await tx('readwrite');
    for (const r of records) {
      store.get(r.id).onsuccess = (e) => {
        const old = e.target.result;
        store.put(
          old
            ? {
                ...r,
                ...old,
                starred: old.starred || r.starred ? 1 : 0,
                dwellMs: Math.max(old.dwellMs, r.dwellMs),
                firstSeenAt: Math.min(old.firstSeenAt, r.firstSeenAt),
                lastSeenAt: Math.max(old.lastSeenAt, r.lastSeenAt),
              }
            : r,
        );
      };
    }
    await done;
    return records.length;
  }

  // インポートするファイルは信用せず、形を整えてから保存する
  function sanitize(r) {
    if (!r || typeof r !== 'object' || !/^\d{1,25}$/.test(String(r.id))) return null;
    const str = (v) => (typeof v === 'string' ? v : '');
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const lastSeenAt = num(r.lastSeenAt) || Date.now();
    return {
      id: String(r.id),
      handle: handleOf(r.handle),
      name: str(r.name),
      avatar: str(r.avatar),
      text: str(r.text),
      truncated: Boolean(r.truncated),
      time: str(r.time),
      context: str(r.context),
      media: Array.isArray(r.media) ? r.media.filter((m) => typeof m === 'string').slice(0, MAX_MEDIA) : [],
      quote:
        r.quote && typeof r.quote === 'object'
          ? { name: str(r.quote.name), handle: handleOf(r.quote.handle), text: str(r.quote.text) }
          : null,
      seenOn: str(r.seenOn),
      firstSeenAt: num(r.firstSeenAt) || lastSeenAt,
      lastSeenAt,
      dwellMs: Math.max(0, num(r.dwellMs)),
      starred: r.starred ? 1 : 0,
    };
  }

  function handleOf(v) {
    return typeof v === 'string' && HANDLE_RE.test(v) ? v : '';
  }

  /* ------------------------------------------------------------------ *
   * ツイートの読み取り
   * ------------------------------------------------------------------ */

  // X は絵文字を <img alt="😂"> で描くので、alt も文字として拾う
  function richText(node) {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) s += n.data;
      else if (n.nodeType !== Node.ELEMENT_NODE) continue;
      else if (n.tagName === 'IMG') s += n.getAttribute('alt') || '';
      else if (n.tagName === 'BR') s += '\n';
      else s += richText(n);
    }
    return s;
  }

  function readUser(el) {
    if (!el) return { name: '', handle: '' };
    // User-Name の 1 つ目の子に表示名、2 つ目の子に @ID と時刻が入っている
    const [nameBox, rest] = el.children;
    const name = richText(nameBox || el).trim();
    const m = richText(rest || el).match(/@(\w{1,50})/);
    return { name, handle: m ? m[1] : '' };
  }

  function extract(article) {
    const quoteBox = [...article.querySelectorAll(SEL.quoteBox)].find((el) => el.querySelector(SEL.userName));
    const own = (sel) => [...article.querySelectorAll(sel)].filter((el) => !(quoteBox && quoteBox.contains(el)));

    // 時刻のリンクがツイートのパーマリンク。広告にはこれが無いので記録されない。
    const timeEl = own('time')[0];
    const link = timeEl && timeEl.closest('a[href*="/status/"]');
    const m = link && link.getAttribute('href').match(/\/([^/?#]+)\/status\/(\d+)/);
    if (!m) return null;

    const user = readUser(own(SEL.userName)[0]);
    const textEl = own(SEL.text)[0];
    const avatar = own(SEL.avatar)[0];
    const context = own(SEL.context)[0];
    const media = [...own(SEL.photo).map((img) => img.src), ...own(SEL.video).map((v) => v.poster)].filter(Boolean);

    let quote = null;
    if (quoteBox) {
      const q = readUser(quoteBox.querySelector(SEL.userName));
      const qText = quoteBox.querySelector(SEL.text);
      quote = { name: q.name, handle: q.handle, text: qText ? richText(qText).trim() : '' };
    }

    return {
      id: m[2],
      handle: handleOf(m[1]) && m[1] !== 'i' ? m[1] : user.handle,
      name: user.name,
      avatar: avatar ? avatar.src : '',
      text: textEl ? richText(textEl).trim() : '',
      truncated: own(SEL.showMore).length > 0,
      time: timeEl.getAttribute('datetime') || '',
      context: context ? richText(context).trim() : '',
      media: [...new Set(media)].slice(0, MAX_MEDIA),
      quote,
      seenOn: location.pathname,
    };
  }

  /* ------------------------------------------------------------------ *
   * 画面に出たツイートの追跡
   * ------------------------------------------------------------------ */

  const observed = new Set(); // 監視中の article
  const visible = new Map(); // 画面に出ている article -> { id, since }
  let panelOpen = false;

  // 履歴パネルを見ている間や別タブにいる間は表示時間に数えない
  const countingDwell = () => !document.hidden && !panelOpen && !settings.paused;

  const io = new IntersectionObserver(
    (entries) => {
      const now = Date.now();
      entries.forEach((e, i) => {
        const seen =
          e.isIntersecting &&
          (e.intersectionRatio >= SEEN_RATIO ||
            // 画面より背の高いツイートは、画面の半分以上を占めていれば見たとみなす
            (e.rootBounds && e.intersectionRect.height >= e.rootBounds.height * SEEN_RATIO));
        if (seen) begin(e.target, now + i);
        else end(e.target, now);
      });
    },
    { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] },
  );

  function begin(el, now) {
    if (visible.has(el) || settings.paused) return;
    const rec = extract(el);
    if (!rec) return;
    visible.set(el, { id: rec.id, since: now });
    enqueue(rec.id, rec, 0, now);
  }

  function end(el, now) {
    const v = visible.get(el);
    if (!v) return;
    visible.delete(el);
    if (countingDwell() && now > v.since) enqueue(v.id, null, now - v.since, now);
  }

  // 見ていた時間を記録に足し込み、計測をそこからやり直す
  function accrue(now, counted) {
    for (const v of visible.values()) {
      if (counted && now > v.since) enqueue(v.id, null, now - v.since, now);
      v.since = now;
    }
  }

  function tick() {
    const now = Date.now();
    if (!countingDwell()) {
      accrue(now, false);
    } else {
      // 同じ瞬間に見えていたものは、画面の下にあるほど「後に見た」扱いにする
      const rows = [...visible].map(([el, v]) => ({ el, v, top: el.isConnected ? el.getBoundingClientRect().top : 0 }));
      rows.sort((a, b) => a.top - b.top);
      rows.forEach(({ el, v }, i) => {
        if (!el.isConnected) return end(el, now);
        // 画像の遅延読み込みなどで中身が増えるので、毎回読み直す
        const rec = extract(el);
        if (!rec) return end(el, now);
        if (rec.id !== v.id) {
          // 要素が別のツイートに使い回された
          end(el, now);
          return begin(el, now);
        }
        enqueue(rec.id, rec, now - v.since, now + i);
        v.since = now;
      });
    }
    flush();
  }

  let scanTimer = 0;

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 200);
  }

  function scan() {
    scanTimer = 0;
    for (const el of document.querySelectorAll(SEL.tweet)) {
      if (!observed.has(el)) {
        observed.add(el);
        io.observe(el);
      }
    }
    for (const el of observed) {
      if (!el.isConnected) {
        end(el, Date.now());
        io.unobserve(el);
        observed.delete(el);
      }
    }
    if (host && !host.isConnected) document.body.append(host);
  }

  function setPaused(paused, persist = true) {
    if (paused === settings.paused) return;
    if (paused) {
      accrue(Date.now(), countingDwell());
      visible.clear();
    }
    settings.paused = paused;
    if (persist) saveSettings();
    if (!paused) {
      // 監視し直すと、いま画面に出ているものについて改めて通知が来る
      io.disconnect();
      for (const el of observed) io.observe(el);
    }
    syncControls();
    flush();
  }

  /* ------------------------------------------------------------------ *
   * 画面 (Shadow DOM の中に作るので X の CSS とは干渉しない)
   * ------------------------------------------------------------------ */

  const ICONS = {
    history:
      'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
    close:
      'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    refresh:
      'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button, input, select { font: inherit; color: inherit; }
    svg { width: 22px; height: 22px; fill: currentColor; }
    [hidden] { display: none !important; }

    .fab {
      position: fixed; left: 12px; bottom: 140px; z-index: 2147483000;
      width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%;
      display: grid; place-items: center; cursor: pointer; touch-action: none;
      background: #1d9bf0; color: #fff; opacity: .6; transition: opacity .15s;
      box-shadow: 0 2px 10px rgba(0, 0, 0, .25); -webkit-tap-highlight-color: transparent;
    }
    .fab:hover, .fab:focus-visible, .fab.dragging { opacity: 1; }
    .fab.paused { background: #8b98a5; }

    .panel {
      --bg: #fff; --fg: #0f1419; --sub: #536471; --line: #eff3f4; --field: #eff3f4;
      --hover: rgba(15, 20, 25, .03); --accent: #1d9bf0; --accent-bg: rgba(29, 155, 240, .1);
      position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483001;
      width: min(440px, 100vw); display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg); border-left: 1px solid var(--line);
      box-shadow: -8px 0 32px rgba(0, 0, 0, .18);
      font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans",
        "Hiragino Kaku Gothic ProN", "Noto Sans JP", Meiryo, sans-serif;
      padding-bottom: env(safe-area-inset-bottom);
    }
    .panel.dark {
      --fg: #e7e9ea; --sub: #71767b; --line: #2f3336; --field: #202327; --hover: rgba(231, 233, 234, .03);
    }

    header {
      display: flex; align-items: center; gap: 2px;
      padding: calc(8px + env(safe-area-inset-top)) 8px 8px 16px;
    }
    h2 { margin: 0; font-size: 19px; font-weight: 800; white-space: nowrap; }
    .count { color: var(--sub); font-size: 13px; margin-left: 8px; white-space: nowrap; }
    .spacer { flex: 1; }
    .icon-btn {
      width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%;
      display: grid; place-items: center; background: transparent; cursor: pointer;
    }
    .icon-btn:hover { background: var(--accent-bg); color: var(--accent); }
    .icon-btn svg { width: 20px; height: 20px; }

    .controls { display: grid; gap: 8px; padding: 0 16px 10px; border-bottom: 1px solid var(--line); }
    input[type="search"] {
      width: 100%; height: 40px; padding: 0 16px; border: 1px solid transparent; border-radius: 999px;
      background: var(--field); outline: none;
    }
    input[type="search"]:focus { border-color: var(--accent); background: var(--bg); }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; }
    select {
      height: 32px; padding: 0 6px; border: 1px solid var(--line); border-radius: 8px;
      background: var(--bg); cursor: pointer;
    }
    .check { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
    .check input { margin: 0; accent-color: var(--accent); }

    .list { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
    .item { display: flex; gap: 12px; padding: 12px 16px 6px; border-bottom: 1px solid var(--line); }
    .item:hover { background: var(--hover); }
    .avatar { flex: none; width: 40px; height: 40px; border-radius: 50%; background: var(--field); object-fit: cover; }
    .main { flex: 1; min-width: 0; }
    .ctx { margin-bottom: 2px; color: var(--sub); font-size: 13px; font-weight: 700; }
    .link { display: block; color: inherit; text-decoration: none; }
    .head { display: flex; align-items: baseline; gap: 4px; min-width: 0; white-space: nowrap; }
    .name { overflow: hidden; text-overflow: ellipsis; font-weight: 700; }
    .sub { overflow: hidden; text-overflow: ellipsis; color: var(--sub); }
    .head .sub:last-child { flex: none; }
    .text {
      margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 8; overflow: hidden;
    }
    .quote { margin-top: 8px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 12px; font-size: 14px; }
    .quote .text { -webkit-line-clamp: 4; }
    .media { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 4px; margin-top: 8px; }
    .media img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid var(--line); border-radius: 8px; }
    .foot { display: flex; align-items: center; gap: 2px; margin-top: 4px; color: var(--sub); font-size: 13px; }
    .seen { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .foot button {
      flex: none; padding: 4px 8px; border: 0; border-radius: 999px; background: transparent;
      color: var(--sub); font-size: 13px; cursor: pointer;
    }
    .foot button:hover { background: var(--accent-bg); color: var(--accent); }
    .foot .star.on { color: #f5a623; }
    .empty { padding: 32px 24px; color: var(--sub); text-align: center; line-height: 1.7; white-space: pre-line; }
    .more { display: block; width: 100%; padding: 14px; border: 0; background: transparent; color: var(--accent); cursor: pointer; }
    .more:hover { background: var(--hover); }

    footer { display: grid; gap: 4px; padding: 8px 16px; border-top: 1px solid var(--line); font-size: 14px; }
    summary { color: var(--sub); cursor: pointer; }
    .settings { display: grid; gap: 10px; padding: 8px 0 4px; }
    .settings small { color: var(--sub); }
    .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
    .btn {
      height: 32px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px;
      background: transparent; font-weight: 700; cursor: pointer;
    }
    .btn:hover { background: var(--hover); }
    .btn.danger { color: #f4212e; }
    .status { min-height: 1.2em; color: var(--accent); font-size: 13px; }
  `;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid != null && kid !== false && kid !== '') el.append(kid);
    }
    return el;
  }

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function select(label, options, value, onChange) {
    const el = h(
      'select',
      { 'aria-label': label, onchange: () => onChange(el.value) },
      options.map(([v, text]) => h('option', { value: String(v) }, text)),
    );
    el.value = String(value);
    return el;
  }

  function debounce(fn, ms) {
    let t = 0;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  const pad = (n) => String(n).padStart(2, '0');

  function fmtDate(v) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}/`;
    return `${year}${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtSeen(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'たった今見た';
    if (s < 3600) return `${Math.floor(s / 60)}分前に見た`;
    if (s < DAY / 1000) return `${Math.floor(s / 3600)}時間前に見た`;
    return `${fmtDate(ts)}に見た`;
  }

  function fmtDwell(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}秒`;
    return `${Math.floor(s / 60)}分${s % 60 ? `${s % 60}秒` : ''}`;
  }

  function placeLabel(path) {
    if (!path) return '';
    if (path === '/home') return 'ホーム';
    if (path.startsWith('/search')) return '検索';
    if (path.startsWith('/explore')) return '話題を検索';
    if (path.startsWith('/notifications')) return '通知';
    if (path.startsWith('/i/bookmarks')) return 'ブックマーク';
    if (path.includes('/lists/')) return 'リスト';
    if (/\/status\/\d+/.test(path)) return 'ツイート詳細';
    const m = path.match(/^\/(\w{1,50})(\/|$)/);
    return m && m[1] !== 'i' ? `@${m[1]}` : '';
  }

  function tweetUrl(t) {
    return `https://${location.host}/${handleOf(t.handle) || 'i/web'}/status/${t.id}`;
  }

  function safeImg(u) {
    return typeof u === 'string' && /^(https:\/\/([\w-]+\.)*twimg\.com\/|data:image\/)/.test(u) ? u : '';
  }

  const view = { q: '', rangeMs: 0, sort: 'recent', starredOnly: false, shown: 0, gen: 0 };
  let host, shadow, fab, panel, listEl, countEl, statusEl, searchEl, pauseEl, retentionEl, fileEl;
  let statusTimer = 0;

  function mountUI() {
    host = h('div', { id: 'tweet-recovery-root' });
    shadow = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      shadow.append(h('style', null, CSS));
    }

    fab = h(
      'button',
      { class: 'fab', type: 'button', title: '見たツイート履歴（Alt+Shift+H）', 'aria-label': '見たツイート履歴を開く' },
      icon('history'),
    );
    makeDraggable(fab);

    searchEl = h('input', {
      type: 'search',
      placeholder: '本文・名前・@ID で検索',
      'aria-label': '検索',
      oninput: debounce(() => {
        view.q = searchEl.value;
        refresh();
      }, 200),
    });
    const starredEl = h('input', {
      type: 'checkbox',
      onchange: () => {
        view.starredOnly = starredEl.checked;
        refresh();
      },
    });
    pauseEl = h('input', { type: 'checkbox', onchange: () => setPaused(pauseEl.checked) });
    retentionEl = select(
      '保存期間',
      [[7, '7日'], [30, '30日'], [90, '90日'], [365, '1年'], [0, '無期限']],
      settings.retentionDays,
      async (v) => {
        settings.retentionDays = Number(v);
        saveSettings();
        await prune().catch(warn);
        updateCount();
      },
    );
    fileEl = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: onImport });

    listEl = h('div', { class: 'list' });
    countEl = h('span', { class: 'count' });
    statusEl = h('div', { class: 'status', role: 'status' });

    panel = h(
      'aside',
      { class: 'panel', hidden: true, 'aria-label': '見たツイート履歴' },
      h(
        'header',
        null,
        h('h2', null, '見たツイート履歴'),
        countEl,
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', type: 'button', title: '再読み込み', onclick: () => refresh() }, icon('refresh')),
        h('button', { class: 'icon-btn', type: 'button', title: '閉じる（Esc）', onclick: closePanel }, icon('close')),
      ),
      h(
        'div',
        { class: 'controls' },
        searchEl,
        h(
          'div',
          { class: 'row' },
          select(
            '期間',
            [[0, '全期間'], [3600000, '1時間以内'], [DAY, '24時間以内'], [7 * DAY, '7日以内']],
            view.rangeMs,
            (v) => {
              view.rangeMs = Number(v);
              refresh();
            },
          ),
          select('並び順', [['recent', '見た順'], ['dwell', '表示時間が長い順']], view.sort, (v) => {
            view.sort = v;
            refresh();
          }),
          h('label', { class: 'check' }, starredEl, '★のみ'),
        ),
      ),
      listEl,
      h(
        'footer',
        null,
        h('label', { class: 'check' }, pauseEl, '記録を一時停止'),
        h(
          'details',
          null,
          h('summary', null, '設定・バックアップ'),
          h(
            'div',
            { class: 'settings' },
            h('label', null, '保存期間 ', retentionEl, h('small', null, '（★を付けたものは消えません）')),
            h(
              'div',
              { class: 'buttons' },
              h('button', { class: 'btn', type: 'button', onclick: doExport }, 'エクスポート'),
              h('button', { class: 'btn', type: 'button', onclick: () => fileEl.click() }, 'インポート'),
              h('button', { class: 'btn danger', type: 'button', onclick: doClear }, '全部削除'),
            ),
            fileEl,
          ),
        ),
        statusEl,
      ),
    );

    shadow.append(fab, panel);
    document.body.append(host);

    // パネル内の入力が X のキーボードショートカット (j/k/l など) に拾われないようにする
    for (const type of ['keydown', 'keyup', 'keypress']) {
      host.addEventListener(type, (e) => {
        if (type === 'keydown' && e.key === 'Escape') closePanel();
        e.stopPropagation();
      });
    }
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyH') {
          e.preventDefault();
          e.stopPropagation();
          if (panelOpen) closePanel();
          else openPanel();
        } else if (e.key === 'Escape' && panelOpen) {
          closePanel();
        }
      },
      true,
    );
    window.addEventListener('resize', () => placeFab(settings.fab));

    placeFab(settings.fab);
    syncControls();
  }

  function makeDraggable(btn) {
    let drag = null;
    let suppressClick = false;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      suppressClick = false;
      const r = btn.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
      btn.setPointerCapture(e.pointerId);
    });
    btn.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      btn.classList.add('dragging');
      placeFab({ left: drag.left + dx, top: drag.top + dy });
    });
    const stop = () => {
      if (drag && drag.moved) {
        suppressClick = true;
        const r = btn.getBoundingClientRect();
        settings.fab = { left: Math.round(r.left), top: Math.round(r.top) };
        saveSettings();
      }
      drag = null;
      btn.classList.remove('dragging');
    };
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      openPanel();
    });
  }

  function placeFab(pos) {
    if (!pos) return;
    const clamp = (v, size) => Math.max(4, Math.min(v, size - 48));
    fab.style.left = `${clamp(pos.left, innerWidth)}px`;
    fab.style.top = `${clamp(pos.top, innerHeight)}px`;
    fab.style.bottom = 'auto';
  }

  function syncControls() {
    if (!fab) return;
    pauseEl.checked = settings.paused;
    retentionEl.value = String(settings.retentionDays);
    fab.classList.toggle('paused', settings.paused);
    fab.title = settings.paused ? '見たツイート履歴（記録を一時停止中）' : '見たツイート履歴（Alt+Shift+H）';
  }

  // X のテーマ (ライト / ダークブルー / ブラック) に合わせる
  function applyTheme() {
    const bg = pageBackground();
    const [r, g, b] = bg ? bg.match(/[\d.]+/g).map(Number) : [255, 255, 255];
    panel.classList.toggle('dark', (r * 299 + g * 587 + b * 114) / 1000 < 128);
    panel.style.setProperty('--bg', bg || '#fff');
  }

  function pageBackground() {
    const opaque = (c) => {
      const n = (c || '').match(/[\d.]+/g);
      return n && n.length >= 3 && (n.length < 4 || Number(n[3]) > 0) ? c : '';
    };
    const fromBody = opaque(getComputedStyle(document.body).backgroundColor);
    if (fromBody) return fromBody;
    const fromHtml = opaque(getComputedStyle(docEl).backgroundColor);
    if (fromHtml) return fromHtml;
    // X はテーマに合わせて theme-color を書き換えている
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return '';
    host.style.color = meta.content;
    const c = getComputedStyle(host).color;
    host.style.color = '';
    return opaque(c);
  }

  function openPanel() {
    if (panelOpen) return;
    accrue(Date.now(), countingDwell());
    panelOpen = true;
    applyTheme();
    panel.hidden = false;
    fab.hidden = true;
    refresh();
    // スマホではキーボードが勝手に開かないよう、マウス環境のときだけ検索欄にフォーカス
    if (matchMedia('(pointer: fine)').matches) searchEl.focus({ preventScroll: true });
  }

  function closePanel() {
    if (!panelOpen) return;
    accrue(Date.now(), false);
    panelOpen = false;
    panel.hidden = true;
    fab.hidden = false;
  }

  function setStatus(msg) {
    statusEl.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusEl.textContent = '';
    }, 5000);
  }

  async function updateCount() {
    try {
      countEl.textContent = `${(await countAll()).toLocaleString()}件`;
    } catch (err) {
      warn(err);
    }
  }

  async function refresh() {
    const gen = ++view.gen;
    await flush();
    let res;
    try {
      res = await search({ ...view, offset: 0, limit: PAGE_SIZE });
    } catch (err) {
      warn(err);
      setStatus('読み込みに失敗しました');
      return;
    }
    if (gen !== view.gen) return;
    view.shown = 0;
    listEl.replaceChildren();
    listEl.scrollTop = 0;
    showResults(res);
    updateCount();
  }

  async function loadMore(btn) {
    const gen = view.gen;
    btn.disabled = true;
    let res;
    try {
      res = await search({ ...view, offset: view.shown, limit: PAGE_SIZE });
    } catch (err) {
      warn(err);
      setStatus('読み込みに失敗しました');
      btn.disabled = false;
      return;
    }
    if (gen !== view.gen) return;
    btn.remove();
    showResults(res);
  }

  function showResults({ items, hasMore }) {
    if (!view.shown && !items.length) {
      const filtered = view.q || view.rangeMs || view.starredOnly;
      listEl.append(
        h(
          'div',
          { class: 'empty' },
          filtered
            ? '条件に合うツイートがありません。'
            : 'まだ何も記録されていません。\nタイムラインをスクロールすると、画面に表示されたツイートが自動で記録されます。',
        ),
      );
      return;
    }
    view.shown += items.length;
    listEl.append(...items.map(itemEl));
    if (hasMore) {
      const btn = h('button', { class: 'more', type: 'button', onclick: () => loadMore(btn) }, 'もっと見る');
      listEl.append(btn);
    }
  }

  function itemEl(t) {
    const avatar = safeImg(t.avatar);
    const media = (t.media || []).map(safeImg).filter(Boolean);
    const q = t.quote;
    const where = placeLabel(t.seenOn);
    const seen = [fmtSeen(t.lastSeenAt), t.dwellMs >= 1000 && `${fmtDwell(t.dwellMs)}表示`, where]
      .filter(Boolean)
      .join(' · ');

    const star = h(
      'button',
      {
        class: `star${t.starred ? ' on' : ''}`,
        type: 'button',
        title: '★を付けると保存期間を過ぎても消えません',
        onclick: async () => {
          t.starred = t.starred ? 0 : 1;
          star.classList.toggle('on', Boolean(t.starred));
          star.textContent = t.starred ? '★ スター' : '☆ スター';
          await updateTweet(t.id, (v) => ({ ...v, starred: t.starred })).catch(warn);
        },
      },
      t.starred ? '★ スター' : '☆ スター',
    );

    const el = h(
      'div',
      { class: 'item' },
      avatar ? h('img', { class: 'avatar', src: avatar, alt: '', loading: 'lazy' }) : h('div', { class: 'avatar' }),
      h(
        'div',
        { class: 'main' },
        t.context && h('div', { class: 'ctx' }, t.context),
        h(
          'a',
          { class: 'link', href: tweetUrl(t), target: '_blank', rel: 'noopener', title: 'X で開く' },
          h(
            'div',
            { class: 'head' },
            h('span', { class: 'name' }, t.name || t.handle || '(名前不明)'),
            t.handle && h('span', { class: 'sub' }, `@${t.handle}`),
            t.time && h('span', { class: 'sub' }, `· ${fmtDate(t.time)}`),
          ),
          t.text && h('div', { class: 'text' }, t.truncated ? `${t.text}…` : t.text),
          q &&
            h(
              'div',
              { class: 'quote' },
              h(
                'div',
                { class: 'head' },
                h('span', { class: 'name' }, q.name || ''),
                q.handle && h('span', { class: 'sub' }, `@${q.handle}`),
              ),
              q.text && h('div', { class: 'text' }, q.text),
            ),
          media.length > 0 && h('div', { class: 'media' }, media.map((src) => h('img', { src, alt: '', loading: 'lazy' }))),
        ),
        h(
          'div',
          { class: 'foot' },
          h('span', { class: 'seen', title: new Date(t.lastSeenAt).toLocaleString() }, seen),
          h('span', { class: 'spacer' }),
          star,
          h(
            'button',
            {
              type: 'button',
              title: '履歴から削除',
              onclick: async () => {
                await removeTweet(t.id).catch(warn);
                el.remove();
                updateCount();
              },
            },
            '削除',
          ),
        ),
      ),
    );
    return el;
  }

  async function doExport() {
    try {
      await flush();
      const tweets = await getAll();
      const json = JSON.stringify({ app: 'tweet-recovery', version: 1, exportedAt: new Date().toISOString(), tweets });
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const d = new Date();
      const a = h('a', { href: url, download: `tweet-recovery-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json` });
      shadow.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setStatus(`${tweets.length}件を書き出しました`);
    } catch (err) {
      warn(err);
      setStatus('エクスポートに失敗しました');
    }
  }

  async function onImport() {
    const file = fileEl.files[0];
    fileEl.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data && data.tweets;
      if (!Array.isArray(list)) throw new Error('ファイルの形式が違います');
      const n = await importTweets(list);
      setStatus(`${n}件を読み込みました`);
      refresh();
    } catch (err) {
      warn(err);
      setStatus(`インポートに失敗しました: ${err.message}`);
    }
  }

  async function doClear() {
    if (!confirm('記録をすべて削除します。★を付けたものも消えます。よろしいですか？')) return;
    try {
      pending.clear();
      await clearAll();
      setStatus('すべて削除しました');
      refresh();
    } catch (err) {
      warn(err);
      setStatus('削除に失敗しました');
    }
  }

  /* ------------------------------------------------------------------ *
   * 起動
   * ------------------------------------------------------------------ */

  function init() {
    mountUI();
    scan();
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    setInterval(tick, TICK_MS);

    document.addEventListener('visibilitychange', () => {
      // 別タブに移ったらそこまでの時間を記録し、戻ってきたら計測をやり直す
      accrue(Date.now(), document.hidden && !panelOpen && !settings.paused);
      flush();
    });
    window.addEventListener('pagehide', () => {
      accrue(Date.now(), countingDwell());
      flush();
    });
    // 別タブで設定を変えたら追従する
    window.addEventListener('storage', (e) => {
      if (e.key !== SETTINGS_KEY) return;
      const next = loadSettings();
      settings.retentionDays = next.retentionDays;
      setPaused(next.paused, false);
      syncControls();
    });

    setTimeout(() => prune().catch(warn), 5000);
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
