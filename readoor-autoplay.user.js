// ==UserScript==
// @name         Readoor 阅门户 云学堂视频自动播放完成
// @namespace    byyxt-autoplay
// @version      1.1.0-readoor
// @description  自动逐个播放 Readoor(阅门户/云学堂)平台的课程视频,完成后自动返回列表继续下一个,直到全部完成。适配 a.readoor.cn / app.readoor.cn / byyxt.pupedu.cn
// @match        https://byyxt.pupedu.cn/*
// @match        https://a.readoor.cn/*
// @match        https://app.readoor.cn/*
// @downloadURL  https://raw.githubusercontent.com/MARSONag/readoor-autoplay/main/readoor-autoplay.user.js
// @updateURL    https://raw.githubusercontent.com/MARSONag/readoor-autoplay/main/readoor-autoplay.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ====================== 配置 ====================== */
  const CFG = {
    autoStart: true,          // 进入任务详情页后自动开始
    rate: 16,                 // 播放倍速(Chrome 最大 16)
    mute: true,               // 静音播放(绕过自动播放限制)
    fastSeek: false,          // true:先尝试直接跳到结尾(仅在未开启防拖拽时生效)
    doneWaitMs: 3500,         // 服务端确认完成后的停留时间
    sectionTimeoutMs: 30000,  // 等待课程区域/视频出现的超时
    maxWatchMs: 45 * 60 * 1000, // 单个视频最长等待(到时间还没完成就跳过)
    pollMs: 700,              // 状态轮询间隔
  };
  // 允许外部程序(命令行执行器)覆盖配置
  try { if (window.__BYYXT_CONFIG__) Object.assign(CFG, window.__BYYXT_CONFIG__); } catch (e) {}

  const STATE_KEY = '__byyxt_autoplay__';
  // pStatIf 完成上报加密密钥(平台前端内置的固定值)
  const AES_KEY_HEX = '8c1ef35c1a24f94ce6422f3c4b77e19bec2aaec9c0d72251b82ccf40b22561a84c876c19d2cb9a';

  const log = (...a) => console.log('%c[byyxt]', 'color:#0b8a5f;font-weight:bold', ...a);

  /* ====================== 状态 ====================== */
  const State = { doneReported: false };

  let state = {
    running: false,
    paused: false,
    stopped: false,
    returnUrl: '',
    currentName: '',
    totalPending: null,
    doneCount: 0,
    playCounts: {},
    attempts: {},   // 课程名 -> 尝试次数
    skip: [],       // 跳过名单
  };

  function loadState() {
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (raw) state = Object.assign(state, JSON.parse(raw));
    } catch (e) {}
  }
  function saveState() {
    try { sessionStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function resetState() {
    state = { running: false, paused: false, stopped: false, returnUrl: '', currentName: '', totalPending: null, doneCount: 0, playCounts: {}, attempts: {}, skip: [] };
    try { sessionStorage.removeItem(STATE_KEY); } catch (e) {}
  }

  /* ====================== 加密 / 完成上报检测 ====================== */
  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function decryptPayload(body) {
    let obj = body;
    if (typeof body === 'string') obj = JSON.parse(body);
    if (!obj || typeof obj !== 'object' || !obj.data || !obj.jfug) return null;
    const keyBuf = await crypto.subtle.digest('SHA-256', hexToBytes(AES_KEY_HEX));
    const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
    const iv = b64ToBytes(obj.jfug);
    const ct = b64ToBytes(obj.data);
    const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  }
  function isDoneReport(payload) {
    try {
      const base = payload && payload.base_data;
      const lesson = payload && payload.lesson_data && payload.lesson_data[0];
      if (!base || !lesson) return false;
      const key = btoa(String(base.time_stamp)).slice(2, 8);
      return String(lesson[key]) === '1';
    } catch (e) {
      return false;
    }
  }

  function hookPStatIf() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try { this.__byyxtUrl = typeof url === 'string' ? url : String(url); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        const url = this.__byyxtUrl || '';
        if (url.includes('stat/pStatIf')) {
          const xhr = this;
          xhr.addEventListener('loadend', () => {
            decryptPayload(body).then(payload => {
              if (isDoneReport(payload)) {
                State.doneReported = true;
                log('检测到完成上报(服务端已收到)');
              }
            }).catch(() => {});
          });
        }
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  }

  /* ====================== 拦截 window.open,把课程页转到当前标签 ====================== */
  function hookWindowOpen() {
    const orig = window.open;
    window.open = function (url, name, features) {
      try {
        const u = String(url || '');
        if (/\/c\/pc\/viewer|\/e-textbook2/.test(u) && /pupedu\.cn|readoor\.cn/.test(location.hostname)) {
          try { sessionStorage.setItem(STATE_KEY + '_nav', u); } catch (e) {}
          setTimeout(() => { location.assign(u); }, 60);
          return null;
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  }

  /* ====================== 通用工具 ====================== */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(fn, timeout, interval = 500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(interval);
    }
    return null;
  }
  const isTrainingPage = () => /\/statudentsHomeDetails/.test(location.pathname);
  const isViewerPage = () => /\/c\/pc\/viewer|\/e-textbook2/.test(location.pathname);
  const loginLimited = () => /登录超过最大限制数|登录设备数超限|已在别处登录|账号在其它设备登录/.test(document.body ? document.body.innerText : '');
  const warnStop = msg => {
    state.running = false;
    saveState();
    setStatus(msg);
  };

  /* ====================== 悬浮面板 ====================== */
  let panel = null, statusEl = null;
  function ensurePanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:999999;background:#0f172a;color:#e2e8f0;' +
      'font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;border-radius:10px;padding:10px 12px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:300px;';
    const title = document.createElement('div');
    title.textContent = 'Readoor 视频自动播放';
    title.style.cssText = 'font-weight:700;margin-bottom:4px;';
    statusEl = document.createElement('div');
    statusEl.id = 'byyxt-status';
    statusEl.style.cssText = 'color:#94a3b8;min-height:20px;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-top:6px;';
    const mkBtn = (text, fn) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'flex:1;border:0;border-radius:6px;padding:4px 0;cursor:pointer;font-size:12px;';
      b.style.background = '#334155';
      b.style.color = '#e2e8f0';
      b.onclick = fn;
      return b;
    };
    const pauseBtn = mkBtn('暂停', () => {
      state.paused = !state.paused;
      saveState();
      pauseBtn.textContent = state.paused ? '继续' : '暂停';
      if (!state.paused) run();
    });
    const stopBtn = mkBtn('停止', () => {
      state.running = false; state.stopped = true; saveState();
      setStatus('已停止');
    });
    bar.append(pauseBtn, stopBtn);
    panel.append(title, statusEl, bar);
    document.body.appendChild(panel);
  }
  function setStatus(text) {
    log(text);
    ensurePanel();
    if (statusEl) statusEl.textContent = text;
  }

  /* ====================== 任务列表页 ====================== */
  function getItemName(el) {
    const s = el.querySelector('.categroy_item_left span');
    return (s ? s.textContent : '').trim() || '(未知课程)';
  }
  function isVideoItem(el) {
    const img = el.querySelector('img.CoursewareIcon');
    if (!img) return false;
    const src = img.getAttribute('src') || '';
    return /video_icon\.png|video\.png/.test(src);
  }
  function isDoneItem(el) {
    const icon = el.querySelector('.done_box .ymhicon');
    const cls = icon ? icon.className : '';
    return /Union|successTrainTeg/.test(cls);
  }
  function getPendingVideos() {
    return [...document.querySelectorAll('.categroy_item')].filter(el =>
      isVideoItem(el) && !isDoneItem(el) && !state.skip.includes(getItemName(el))
    );
  }
  async function clickTabByName(text) {
    const tabs = [...document.querySelectorAll('.headerBox p, .tabBox p, p.active')];
    const tab = tabs.find(t => (t.textContent || '').includes(text));
    if (tab) { tab.click(); await sleep(2500); }
  }
  function recordAttempt(name) {
    state.attempts[name] = (state.attempts[name] || 0) + 1;
    if (state.attempts[name] >= 2 && !state.skip.includes(name)) {
      state.skip.push(name);
      log('连续两次无法完成,跳过:', name);
    }
    saveState();
  }

  async function trainingLoop() {
    if (!state.running || state.paused || state.stopped) return;
    // 外部(测试驱动)可写入该标记让脚本在下一轮停止
    try {
      if (sessionStorage.getItem('__byyxt_autoplay_stop__') === '1') {
        state.running = false;
        saveState();
        setStatus('⏹ 已按限制停止');
        return;
      }
    } catch (e) {}
    if (loginLimited()) { warnStop('⚠ 检测到该账号存在其他登录(登录设备数超限),已停止。请在其他设备退出登录后重试'); return; }
    await waitFor(() => document.querySelector('.categroy_item'), 30000);
    let items = getPendingVideos();
    if (!items.length) {
      if (loginLimited()) { warnStop('⚠ 检测到该账号存在其他登录(登录设备数超限),已停止。请在其他设备退出登录后重试'); return; }
      await clickTabByName('内容目录');
      await waitFor(() => document.querySelector('.categroy_item'), 15000);
      items = getPendingVideos();
    }
    if (loginLimited()) { warnStop('⚠ 检测到该账号存在其他登录(登录设备数超限),已停止。请在其他设备退出登录后重试'); return; }
    if (!items.length) {
      setStatus('✅ 没有待处理的视频(已全部完成或已跳过)');
      state.running = false;
      saveState();
      return;
    }
    if (state.totalPending === null) {
      state.totalPending = items.length;
      saveState();
    }
    const item = items[0];
    const name = getItemName(item);
    const played = (state.playCounts && state.playCounts[name]) || 0;
    if (played >= 2) {
      if (!state.skip.includes(name)) {
        state.skip.push(name);
        saveState();
      }
      if (items.length <= 1) {
        state.running = false;
        saveState();
        setStatus('⚠ 同一视频反复播放仍未被标记完成,可能是登录失效或任务未开放,已停止');
        return;
      }
      setStatus(`跳过反复无法完成的视频: ${name}`);
      await sleep(300);
      trainingLoop();
      return;
    }
    state.playCounts[name] = played + 1;
    state.currentName = name;
    state.returnUrl = location.href;
    saveState();
    setStatus(`待处理 ${items.length}/${state.totalPending} 个 → 打开: ${name}`);
    try { item.scrollIntoView({ block: 'center' }); } catch (e) {}
    item.click();
    await sleep(2500);
    if (isTrainingPage()) {
      recordAttempt(name);
      setStatus('页面未跳转,尝试下一个…');
      await sleep(500);
      trainingLoop();
    }
  }

  /* ====================== 课程播放页 ====================== */
  function rectOf(v) { try { return v.getBoundingClientRect(); } catch (e) { return { width: 0, height: 0 }; } }
  function isVisible(v) {
    try {
      const r = rectOf(v);
      const st = getComputedStyle(v);
      return r.width > 80 && r.height > 40 && st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.1;
    } catch (e) { return false; }
  }
  function allVideos() {
    let vids = [...document.querySelectorAll('video')];
    // 同源 iframe 里的播放器也算
    for (const f of document.querySelectorAll('iframe')) {
      try { const d = f.contentDocument; if (d) vids = vids.concat([...d.querySelectorAll('video')]); } catch (e) {}
    }
    return vids;
  }
  function pickVideo() {
    const vids = allVideos();
    if (!vids.length) return null;
    const vis = vids.filter(isVisible);
    const pool = vis.length ? vis : vids;
    // 面积最大的那个最可能是主播放器（列表页缩略图/装饰视频面积很小）
    return pool.sort((a, b) => {
      const ra = rectOf(a), rb = rectOf(b);
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
  }
  function describe(v) {
    if (!v) return '未找到视频元素';
    const r = rectOf(v);
    const dur = Number.isFinite(v.duration) ? v.duration.toFixed(0) + 's' : '未知';
    return `尺寸 ${Math.round(r.width)}×${Math.round(r.height)} | 已缓存 ${v.readyState}/4 | 时长 ${dur} | 进度 ${(v.currentTime || 0).toFixed(1)}s | 暂停 ${v.paused} | 倍速 ${v.playbackRate} | 错误 ${v.error ? v.error.code : '无'} | src ${(v.currentSrc || '').slice(0, 40)}`;
  }
  function clickPlayUi() {
    const sels = ['.vjs-big-play-button', '.prism-big-play-btn', '.dplayer-play-icon', '.xgplayer-start',
                  '.m-video-playbtn', '.play-btn', '.def_img_box', '[class*="big-play"]', '[class*="play-btn"]'];
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

  function setupVideo(video, rate) {
    try {
      video.muted = CFG.mute;
      video.defaultPlaybackRate = rate;
      video.playbackRate = rate;
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  // 持续维持"在播 + 目标倍速"；视频不走就逐级降倍速，最后提示手动点一下
  async function enforcePlayback(video) {
    if (!video) return false;
    const RATES = [CFG.rate, 8, 4, 2, 1].filter((r, i, a) => a.indexOf(r) === i);
    let rateIdx = 0;
    let finished = false;
    let lastTime = -1, lastChange = Date.now(), tick = 0, manualHinted = false;
    const start = Date.now();

    const finish = () => { if (finished) return; finished = true; clearInterval(iv); };
    video.addEventListener('ended', () => { State.doneReported = true; finish(); }, { once: true });
    video.addEventListener('error', finish, { once: true });
    // 站点常在自己监听的 ratechange 里把倍速重置回 1，这里再抢回来
    video.addEventListener('ratechange', () => {
      if (finished) return;
      const want = RATES[rateIdx];
      if (Math.abs(video.playbackRate - want) > 0.01) { try { video.playbackRate = want; } catch (e) {} }
    });

    const apply = () => {
      const want = RATES[rateIdx];
      try { if (!video.muted) video.muted = CFG.mute; } catch (e) {}
      try { if (Math.abs(video.playbackRate - want) > 0.01) video.playbackRate = want; } catch (e) {}
    };
    const play = () => {
      apply();
      try { const p = video.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    };
    play();

    if (CFG.fastSeek) {
      try {
        const seek = () => { video.currentTime = Math.max(0, video.duration - 1); };
        if (video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 30) seek();
        else video.addEventListener('loadedmetadata', seek, { once: true });
      } catch (e) {}
    }

    const iv = setInterval(() => {
      if (finished) return;
      tick++;
      if (loginLimited()) { finish(); return; }
      if (State.doneReported || video.ended) { finish(); return; }
      if (Date.now() - start > CFG.maxWatchMs) { log('超时未完成,跳过:', state.currentName); finish(); return; }

      if (Math.abs(video.currentTime - lastTime) > 0.05) {
        lastTime = video.currentTime;
        lastChange = Date.now();
        manualHinted = false;
        if (tick % 5 === 0) setStatus(`播放中: ${state.currentName} @${RATES[rateIdx]}x\n${describe(video)}`);
        return;
      }

      if (video.paused && !video.ended) play();
      else apply();

      if (Date.now() - lastChange > 6000) {
        if (rateIdx < RATES.length - 1) {
          rateIdx++;
          log('视频不动,降倍速到', RATES[rateIdx]);
          clickPlayUi();
          play();
          setStatus(`视频没动，已降到 ${RATES[rateIdx]} 倍速重试…\n${describe(video)}`);
        } else {
          clickPlayUi();
          play();
          manualHinted = true;
          setStatus(`视频始终没在走，请手动点一下视频中间的播放按钮（点一次即可，之后脚本自动接管）\n${describe(video)}`);
        }
        lastChange = Date.now();
      } else if (!manualHinted && tick % 5 === 0) {
        setStatus(`播放中: ${state.currentName} @${RATES[rateIdx]}x\n${describe(video)}`);
      }
    }, CFG.pollMs);

    await new Promise(r => { const t = setInterval(() => { if (finished) { clearInterval(t); r(); } }, 300); });
    return !!(State.doneReported || video.ended);
  }

  function goBack() {
    const ret = state.returnUrl;
    if (ret && ret !== location.href) {
      location.assign(ret);
    } else if (history.length > 1) {
      history.back();
    } else {
      location.assign(ret || '/');
    }
  }

  async function viewerLoop() {
    if (!state.running || state.stopped) return;
    if (loginLimited()) { warnStop('⚠ 检测到该账号存在其他登录(登录设备数超限),已停止。请在其他设备退出登录后重试'); return; }
    setStatus(`正在寻找播放器: ${state.currentName || '(课程)'}`);
    const guid = new URLSearchParams(location.search).get('section_guid');

    let video = await waitFor(pickVideo, CFG.sectionTimeoutMs);

    // 旧版课程区域兜底:展开标题并点播放遮罩
    if (!video && guid) {
      const section = await waitFor(() => document.getElementById(guid), 8000);
      if (section) {
        const title = section.querySelector('.video_title');
        if (title) { try { title.click(); } catch (e) {} await sleep(600); }
        const overlay = section.querySelector('.def_img_box') || document.querySelector('.def_img_box');
        if (overlay) { try { overlay.click(); } catch (e) {} }
        video = await waitFor(pickVideo, 12000);
      }
    }
    if (video) setStatus(`已找到播放器 @${CFG.rate}x\n${describe(video)}`);

    if (!video && !State.doneReported) {
      // 可能视频接口较慢或页面未就绪:整页重载一次再试(状态仍在 sessionStorage)
      if (!new URL(location.href).searchParams.has('__retry')) {
        const u = new URL(location.href);
        u.searchParams.set('__retry', '1');
        location.replace(u.toString());
        return;
      }
      recordAttempt(state.currentName);
      setStatus('未找到视频,返回列表');
      goBack();
      return;
    }

    if (State.doneReported) {
      state.doneCount = (state.doneCount || 0) + 1;
      saveState();
      setStatus('已完成,返回列表…');
    } else {
      setupVideo(video, CFG.rate);
      const ok = await enforcePlayback(video);
      if (ok) {
        state.doneCount = (state.doneCount || 0) + 1;
        saveState();
        setStatus('已完成,返回列表…');
      } else {
        recordAttempt(state.currentName);
        setStatus('视频播放异常,返回列表重试');
      }
    }
    await sleep(CFG.doneWaitMs);
    goBack();
  }

  /* ====================== 主入口 ====================== */
  function run() {
    loadState();
    ensurePanel();
    if (!state.running || state.paused || state.stopped) {
      if (state.stopped) setStatus('已停止');
      return;
    }
    if (isTrainingPage()) trainingLoop();
    else if (isViewerPage()) viewerLoop();
  }

  function bootOnce() {
    ensurePanel();
    if (CFG.autoStart && isTrainingPage() && !state.stopped) {
      state.running = true;
      saveState();
      setStatus('自动播放已启动,正在扫描视频…');
      trainingLoop();
      return;
    }
    if (isViewerPage()) { run(); return; }
    // 两个都不匹配时:不自动跑,只在面板上把当前路径打出来,方便你按实际情况改下面的判断
    setStatus('未识别当前页面路径: ' + location.pathname + '\n如需适配,请把这段加进 isTrainingPage/isViewerPage');
    ensurePanel();
  }

  function boot() {
    try { hookWindowOpen(); } catch (e) { log('window.open 拦截失败', e); }
    try { hookPStatIf(); } catch (e) { log('上报拦截失败', e); }
    loadState();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootOnce);
    } else {
      bootOnce();
    }
  }

  boot();
})();
