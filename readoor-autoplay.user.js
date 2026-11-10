// ==UserScript==
// @name         Readoor 阅门户 云学堂自动刷课
// @namespace    readoor-autoplay
// @version      2.0.0
// @description  在 Readoor(阅门户/云学堂)课程页自动 16 倍速播放，一节看完自动点「课程目录」里的下一节，逐节刷完。适配 a.readoor.cn / app.readoor.cn / byyxt.pupedu.cn
// @match        https://byyxt.pupedu.cn/*
// @match        https://a.readoor.cn/*
// @match        https://app.readoor.cn/*
// @downloadURL  https://raw.githubusercontent.com/MARSONag/readoor-autoplay/main/readoor-autoplay.user.js
// @updateURL    https://raw.githubusercontent.com/MARSONag/readoor-autoplay/main/readoor-autoplay.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    rate: 16,               // 起始倍速
    mute: true,             // 静音（绕过浏览器自动播放限制）
    autoNext: true,         // 一节看完自动点下一节
    autoStart: true,        // 页面里没有在播视频时，自动挑一节没看过的点开
    pollMs: 800,            // 轮询间隔
    advanceDelayMs: 1500,   // 点下一节前的停顿
    stallLimitMs: 5000,     // 进度不动多久算卡住，开始降倍速
    autoStartIdleMs: 5000,  // 页面闲置多久后自动挑一节开始
  };
  const RATES = [CFG.rate, 8, 4, 2, 1].filter((r, i, a) => a.indexOf(r) === i);

  // 目录行文字形如「1.1.3中国现代国防观」「1.1.1国防的内涵」
  const ROW_RE = /^\s*\d+(\.\d+){1,3}\s*[^\d\s]/;

  const S = {
    rows: [], idx: -1, rateIdx: 0, done: false, advancing: false,
    lastSrc: '', lastTime: -1, lastChange: Date.now(), idleSince: Date.now(),
    stalledHint: false, stopped: false, paused: false, finishedCount: 0,
  };

  const log = (...a) => console.log('%c[readoor]', 'color:#0b8a5f;font-weight:bold', ...a);

  /* ====================== 面板 ====================== */
  let panel = null, statusEl = null;
  function mountPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;background:#0f172a;color:#e2e8f0;' +
      'font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;border-radius:10px;padding:10px 12px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.35);width:300px;';
    const t = document.createElement('div');
    t.textContent = 'Readoor 自动刷课 v2';
    t.style.cssText = 'font-weight:700;margin-bottom:6px;';
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'color:#94a3b8;white-space:pre-wrap;word-break:break-all;max-height:150px;overflow:auto;min-height:36px;';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'flex:1;border:0;border-radius:6px;padding:5px 0;cursor:pointer;font-size:12px;background:#334155;color:#e2e8f0;';
      b.onclick = fn;
      return b;
    };
    bar.append(
      mk('暂停', () => { S.paused = !S.paused; setStatus(S.paused ? '已暂停（点「暂停」继续）' : '继续…'); }),
      mk('下一个', () => advance(true)),
      mk('停止', () => { S.stopped = true; setStatus('已停止'); })
    );
    panel.append(t, statusEl, bar);
    document.body.appendChild(panel);
  }
  function setStatus(text) { log(text); mountPanel(); if (statusEl) statusEl.textContent = text; }

  /* ====================== 目录行识别 ====================== */
  function rowText(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }

  function getRows() {
    const out = [];
    const nodes = document.querySelectorAll('div,li,a,span');
    for (const el of nodes) {
      const tx = rowText(el);
      if (!tx || tx.length > 70 || !ROW_RE.test(tx)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 12 || r.height > 110 || r.width < 70) continue;
      // 只保留最内层的那个（外层容器也会匹配到同样的文字）
      let hasInner = false;
      for (const c of el.querySelectorAll('div,li,a,span')) {
        if (ROW_RE.test(rowText(c))) { hasInner = true; break; }
      }
      if (hasInner) continue;
      out.push(el);
    }
    // 同一行文字只保留一个
    const seen = new Set();
    const rows = [];
    for (const el of out) {
      const tx = rowText(el);
      if (seen.has(tx)) continue;
      seen.add(tx);
      rows.push(el);
    }
    rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return rows;
  }

  // 已完成的行后面有个绿色对勺，尽力识别
  function rowDone(row) {
    const html = (row.innerHTML || '').slice(0, 600);
    if (/success|checked|complete|finish|done|yiwancheng|isok/i.test(html)) return true;
    const nodes = row.querySelectorAll('img,svg,i,use');
    for (const n of nodes) {
      const s = (n.getAttribute && (n.getAttribute('src') || n.getAttribute('xlink:href') || n.getAttribute('href') || n.getAttribute('class') || n.getAttribute('data-icon') || '')) || '';
      if (/success|check|done|complete|finish|yes|dui|tick/i.test(s)) return true;
    }
    return false;
  }

  function findRowFrom(node) {
    let el = node;
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
      if (S.rows && S.rows.indexOf(el) >= 0) return el;
      if (el.nodeType === 1 && ROW_RE.test(rowText(el))) {
        const r = el.getBoundingClientRect();
        if (r.height <= 110 && r.height >= 12) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // 用户（或脚本）点了哪一行，都记下来，用于「下一个」
  document.addEventListener('click', function (e) {
    try {
      const row = findRowFrom(e.target);
      if (!row) return;
      const rows = S.rows && S.rows.length ? S.rows : getRows();
      let i = -1;
      for (let k = 0; k < rows.length; k++) {
        if (rows[k] === row || rowText(rows[k]) === rowText(row)) { i = k; break; }
      }
      if (i >= 0) { S.idx = i; S.stalledHint = false; S.done = false; }
    } catch (err) {}
  }, true);

  /* ====================== 视频 ====================== */
  function rectOf(v) { try { return v.getBoundingClientRect(); } catch (e) { return { width: 0, height: 0 }; } }
  function visible(v) {
    try {
      const r = rectOf(v);
      const st = getComputedStyle(v);
      return r.width > 60 && r.height > 30 && st.display !== 'none' && st.visibility !== 'hidden';
    } catch (e) { return false; }
  }
  function pickVideo() {
    let vids = [].slice.call(document.querySelectorAll('video'));
    const ifr = document.querySelectorAll('iframe');
    for (const f of ifr) {
      try { const d = f.contentDocument; if (d) vids = vids.concat([].slice.call(d.querySelectorAll('video'))); } catch (e) {}
    }
    if (!vids.length) return null;
    const vis = vids.filter(visible);
    const pool = vis.length ? vis : vids;
    return pool.sort(function (a, b) {
      const ra = rectOf(a), rb = rectOf(b);
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
  }
  function describe(v) {
    if (!v) return '无视频';
    const r = rectOf(v);
    const dur = Number.isFinite(v.duration) ? v.duration.toFixed(0) + 's' : '未知';
    return '尺寸 ' + Math.round(r.width) + '×' + Math.round(r.height) + ' | 缓存 ' + v.readyState + '/4 | 时长 ' + dur +
      ' | 进度 ' + (v.currentTime || 0).toFixed(1) + 's | 暂停 ' + v.paused + ' | 倍速 ' + v.playbackRate +
      ' | 错误 ' + (v.error ? v.error.code : '无');
  }

  function clickPlayUi() {
    const sels = ['.vjs-big-play-button', '.prism-big-play-btn', '.dplayer-play-icon', '.xgplayer-start',
      '.m-video-playbtn', '.play-btn', '.def_img_box', '[class*="big-play"]', '[class*="play-btn"]', '[class*="playIcon"]'];
    for (const s of sels) {
      const list = document.querySelectorAll(s);
      for (const el of list) {
        try {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.click(); return true; }
        } catch (e) {}
      }
    }
    return false;
  }

  function playVideo(video) {
    try {
      if (!video.muted) video.muted = CFG.mute;
      const want = RATES[S.rateIdx];
      if (Math.abs(video.playbackRate - want) > 0.01) video.playbackRate = want;
      if (video.paused && !video.ended) {
        const p = video.play();
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {}
  }

  /* ====================== 主循环 ====================== */
  function advance(manual) {
    if (S.stopped) return;
    const rows = getRows();
    if (!rows.length) { setStatus('没找到「课程目录」条目，请确认这个页面有目录列表'); return; }

    if (S.idx < 0) {
      let i = -1;
      for (let k = 0; k < rows.length; k++) { if (!rowDone(rows[k])) { i = k; break; } }
      S.idx = i;
      if (S.idx < 0) { setStatus('目录里所有条目都已完成 ✅'); return; }
    }
    const next = rows[S.idx + 1];
    if (!next) { setStatus('已经刷到目录最后一条了 ✅（完成 ' + S.finishedCount + ' 节）'); return; }

    S.idx = S.idx + 1;
    S.advancing = true;
    S.done = false;
    S.stalledHint = false;
    S.lastTime = -1;
    S.lastChange = Date.now();
    S.rateIdx = 0;
    try { next.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { next.click(); } catch (e) {}
    setStatus((manual ? '手动' : '自动') + '切到下一节: ' + rowText(next));
    setTimeout(function () { S.advancing = false; }, CFG.advanceDelayMs + 2000);
  }

  function tick() {
    if (S.stopped || S.paused) return;
    mountPanel();

    const rows = getRows();
    if (rows.length) S.rows = rows;

    const video = pickVideo();

    if (!video) {
      if (CFG.autoStart && S.idx < 0 && rows.length && Date.now() - S.idleSince > CFG.autoStartIdleMs) advance(false);
      else render(null);
      return;
    }

    const src = (video.currentSrc || '').slice(-50);
    if (src !== S.lastSrc) {
      S.lastSrc = src;
      S.done = false;
      S.stalledHint = false;
      S.lastTime = -1;
      S.lastChange = Date.now();
      S.rateIdx = 0;
    }

    if (video.ended) {
      if (!S.done) {
        S.done = true;
        S.finishedCount++;
        setStatus('本节播完 ✅ 共完成 ' + S.finishedCount + ' 节');
      }
      if (CFG.autoNext && !S.advancing) advance(false);
      return;
    }

    playVideo(video);

    if (Math.abs(video.currentTime - S.lastTime) > 0.05) {
      S.lastTime = video.currentTime;
      S.lastChange = Date.now();
      S.stalledHint = false;
    } else if (Date.now() - S.lastChange > CFG.stallLimitMs) {
      if (S.rateIdx < RATES.length - 1) {
        S.rateIdx++;
        log('进度不动，降到 ' + RATES[S.rateIdx] + ' 倍速');
        clickPlayUi();
        playVideo(video);
      } else {
        S.stalledHint = true;
        clickPlayUi();
      }
      S.lastChange = Date.now();
    }

    render(video);
  }

  function render(video) {
    const rows = S.rows || [];
    const cur = (S.idx >= 0 && rows[S.idx]) ? rowText(rows[S.idx]) : '（未选中）';
    const head = '当前 ' + (S.idx >= 0 ? (S.idx + 1) : '?') + '/' + rows.length + '：' + cur;
    let body = describe(video);
    if (!video) body = '这个页面没有找到 video 元素（可能在 iframe 里或还没加载出来）。';
    else if (S.stalledHint) body += '\n\n视频不动：请手动点一下视频中间的播放按钮，点一次即可，之后脚本接管。';
    else body += '\n已完成 ' + S.finishedCount + ' 节，倍速 ' + RATES[S.rateIdx] + 'x';
    setStatus(head + '\n' + body);
  }

  /* ====================== 启动 ====================== */
  function boot() {
    mountPanel();
    setStatus('已加载，正在等待课程页…');
    let n = 0;
    const wait = setInterval(function () {
      n++;
      const ok = document.querySelector('video') || getRows().length;
      if (ok || n > 40) {
        clearInterval(wait);
        S.idleSince = Date.now();
        setStatus('已接管，开始扫描…');
        tick();
        setInterval(tick, CFG.pollMs);
      }
    }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
