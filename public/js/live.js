// live.js — グループのライブ配信。
// 配信者のカメラ・マイクを、見ている人それぞれへWebRTCで直接送る(サーバーは名簿と合図だけ)。
// 見る人は受け取るだけで、自分のカメラ・マイクは使わない。
(function () {
  const ICE_FALLBACK = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  const I = {
    live: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/></svg>',
    close: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    flip: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-3l-2-3H9L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M9 13.5a3 3 0 0 1 5.2-2M15 12.5a3 3 0 0 1-5.2 2"/><path d="M14.5 9.5v2h-2M9.5 15.5v-2h2"/></svg>',
    mic: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
    micOff: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
    screen: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M9 10l3-3 3 3M12 7v6"/></svg>',
    send: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
    spk: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
    spkOff: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
    gear: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  };

  let cfg = null, ice = ICE_FALLBACK, iceLoaded = false;
  let role = null; // 'host' | 'viewer' | null
  let stream = null, facing = 'user', micOn = true;
  // 画面共有中: 見ている人に送る映像をカメラから画面に差し替える(カメラ映像は手元に残しておき、やめたら戻す)
  let screen = null; // { stream, video, mix: AudioContext|null, audio: MediaStreamTrack|null }
  const canShare = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  let hostId = null, hostName = '', startedAt = 0, tick = null, hostReady = false;
  // 配信の設定(タイトル・フレームレート・コメント)。つなぎ直した時にも送り直す
  let meta = { title: '', comments: true, fps: 30 };
  let roster = { host: null, viewers: [] }; // 「誰が見ているか」(サーバーから)
  let rosterReady = false;
  let ttsOn = false, ttsPending = 0, bannerTitle = '';
  let statTimer = null;
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const BITRATE = { 30: 2500000, 60: 4500000, 120: 7000000 };   // 1人あたりの上限
  const TOTAL_CAP = { 30: 10000000, 60: 14000000, 120: 20000000 }; // 配信者の回線(上り)の目安
  const SPEECH_LANG = { ja: 'ja-JP', en: 'en-US', 'zh-CN': 'zh-CN', ko: 'ko-KR' };
  const pcs = new Map(); // 配信者: viewerId -> pc / 見る人: 'host' -> pc
  const el = {};

  // ログイン済み(auth_ok)のWebSocketにだけ送る。まだなら貯めておき、つながった時に送る。
  // 以前はつながっていない間の live_start を黙って捨てていて、配信者の画面では配信中なのに
  // サーバーは知らない = 誰の画面にもLIVEが出ない、ということが起きていた
  let authedWs = null;
  const queue = [];
  const send = o => {
    const ws = cfg.getWs();
    if (ws && ws === authedWs && ws.readyState === 1) { ws.send(JSON.stringify(o)); return; }
    if (queue.length < 50) queue.push(o);
  };
  let authedEarly = false;
  function onAuthed() {
    if (!cfg) { authedEarly = true; return; } // init より先にログインが済んだ
    authedWs = cfg.getWs();
    const q = queue.splice(0);
    // つなぎ直した時は、配信中/視聴中だったことをサーバーに伝え直す(サーバーは同じ部屋に戻す)
    if (role === 'host' && !q.some(o => o.type === 'live_start')) q.unshift({ type: 'live_start', groupId: cfg.groupId, title: meta.title, comments: meta.comments, fps: meta.fps });
    if (role === 'viewer' && !q.some(o => o.type === 'live_join')) q.unshift({ type: 'live_join', groupId: cfg.groupId });
    q.forEach(send);
  }
  const T = (k, fb) => (window.i18n && i18n.t ? i18n.t(k, fb) : fb);

  function css() {
    if (document.getElementById('liveCss')) return;
    const st = document.createElement('style');
    st.id = 'liveCss';
    st.textContent = `
#liveBanner{position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 112px);z-index:20000;display:none;align-items:center;gap:10px;padding:10px 12px 10px 14px;border-radius:16px;background:rgba(225,29,72,.94);color:#fff;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
#liveBanner.on{display:flex}
#liveBanner .lb-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#liveBanner button{border:0;border-radius:12px;padding:7px 14px;background:#fff;color:#e11d48;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit}
#liveOv{position:fixed;inset:0;z-index:30000;background:#000;display:none;color:#fff;font-family:inherit}
#liveOv.on{display:block}
#liveOv video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}
#liveOv video.mirror{transform:scaleX(-1)}
#liveOv video.wide{object-fit:contain}
#liveOv .lo-btn[disabled]{opacity:.35;cursor:default}
#liveOv .lo-top{position:absolute;left:0;right:0;top:0;padding:calc(env(safe-area-inset-top,0px) + 12px) 14px 30px;display:flex;align-items:center;gap:8px;background:linear-gradient(rgba(0,0,0,.55),transparent)}
#liveOv .lo-badge{background:#e11d48;border-radius:6px;padding:3px 8px;font-weight:800;font-size:12px;letter-spacing:.06em}
#liveOv .lo-cnt{display:flex;align-items:center;gap:4px;background:rgba(0,0,0,.45);border-radius:6px;padding:3px 8px;font-size:12px}
#liveOv .lo-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:15px;text-shadow:0 1px 3px rgba(0,0,0,.5)}
#liveOv .lo-x{width:40px;height:40px;border-radius:50%;border:0;background:rgba(0,0,0,.45);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}
#liveOv .lo-bot{position:absolute;left:0;right:0;bottom:0;padding:30px 20px calc(env(safe-area-inset-bottom,0px) + 22px);display:flex;justify-content:center;gap:22px;background:linear-gradient(transparent,rgba(0,0,0,.55))}
#liveOv .lo-btn{width:56px;height:56px;border-radius:50%;border:0;background:rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}
#liveOv .lo-btn.off{background:#fff;color:#111}
#liveOv .lo-end{width:auto;padding:0 24px;border-radius:28px;background:#e11d48;font-weight:700;font-size:15px;font-family:inherit}
#liveOv .lo-msg{position:absolute;left:0;right:0;top:45%;text-align:center;font-size:15px;opacity:.85;padding:0 24px;pointer-events:none}
#liveOv .lo-cnt{cursor:pointer;border:0;color:#fff;font:inherit;font-size:12px}
#liveOv .lo-ttl{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
#liveOv .lo-ttl b{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,.5)}
#liveOv .lo-ttl small{font-size:12px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,.5)}
#liveOv .lo-fps{background:rgba(0,0,0,.45);border-radius:6px;padding:3px 7px;font-size:11px;font-weight:700;letter-spacing:.02em;display:none}
#liveOv .lo-fps.on{display:block}
#liveOv .lo-stack{position:absolute;left:0;right:0;bottom:var(--lo-kb,0px);display:flex;flex-direction:column;background:linear-gradient(transparent,rgba(0,0,0,.55) 40%);padding-top:24px}
#liveOv .lo-chat{max-height:34vh;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:7px;padding:0 14px;pointer-events:none;-webkit-mask-image:linear-gradient(transparent,#000 40%);mask-image:linear-gradient(transparent,#000 40%)}
#liveOv .lo-c{display:flex;gap:8px;align-items:flex-start;font-size:14px;line-height:1.35;text-shadow:0 1px 3px rgba(0,0,0,.75);word-break:break-word;animation:loIn .18s ease-out}
@keyframes loIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
#liveOv .lo-c .av{width:26px;height:26px;border-radius:50%;background:#475569 center/cover no-repeat;flex:none;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
#liveOv .lo-c b{font-weight:700;opacity:.8;margin-right:6px}
#liveOv .lo-c.host b{color:#fda4af;opacity:1}
#liveOv .lo-c.sys{font-size:12px;opacity:.7;padding-left:34px}
#liveOv .lo-in{display:flex;gap:8px;align-items:center;padding:8px 12px 4px}
#liveOv .lo-in input{flex:1;min-width:0;height:42px;border-radius:21px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);color:#fff;padding:0 16px;font:inherit;font-size:16px;outline:none}
#liveOv .lo-in input::placeholder{color:rgba(255,255,255,.6)}
#liveOv .lo-in input:disabled{opacity:.5}
#liveOv .lo-in .lo-btn{width:42px;height:42px;flex:none}
#liveOv .lo-in .lo-btn.on{background:#fff;color:#111}
#liveOv .lo-in .lo-send{background:#e11d48}
#liveOv .lo-in .lo-send[disabled]{background:rgba(255,255,255,.18)}
#liveOv .lo-bot{position:static;background:none;padding:10px 16px calc(env(safe-area-inset-bottom,0px) + 14px);gap:10px;align-items:center}
#liveOv .lo-bot .lo-btn{width:48px;height:48px;flex:none}
#liveOv .lo-bot .lo-end{width:auto;height:48px;padding:0 18px;font-size:14px;white-space:nowrap;flex:none}
#liveOv.viewer .lo-bot{display:none}
#liveOv.viewer .lo-in{padding-bottom:calc(env(safe-area-inset-bottom,0px) + 12px)}
#liveOv .lo-panel{position:absolute;left:0;right:0;bottom:0;max-height:70%;overflow:auto;z-index:100;background:rgba(24,24,27,.96);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border-radius:20px 20px 0 0;padding:14px 16px calc(env(safe-area-inset-bottom,0px) + 16px);z-index:5;animation:loUp .22s ease-out}
@keyframes loUp{from{transform:translateY(30px);opacity:0}to{transform:none;opacity:1}}
#liveOv .lo-ph{display:flex;align-items:center;margin-bottom:10px}
#liveOv .lo-ph b{flex:1;font-size:16px}
#liveOv .lo-ph button{border:0;background:rgba(255,255,255,.14);color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer}
#liveOv .lo-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid rgba(255,255,255,.08)}
#liveOv .lo-row:first-of-type{border-top:0}
#liveOv .lo-row .av{width:36px;height:36px;border-radius:50%;background:#475569 center/cover no-repeat;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700}
#liveOv .lo-row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}
#liveOv .lo-row .tag{font-size:11px;background:#e11d48;border-radius:5px;padding:2px 6px;margin-left:6px;font-weight:700}
#liveOv .lo-row button{border:0;background:rgba(255,255,255,.14);color:#fff;border-radius:16px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
#liveOv .lo-row button.on{background:#fff;color:#111}
#liveOv .lo-empty{opacity:.6;font-size:14px;padding:10px 0;text-align:center}
#liveOv .lo-field{display:block;margin:8px 0 14px}
#liveOv .lo-field span{display:block;font-size:12px;opacity:.7;margin-bottom:6px}
#liveOv .lo-field input[type=text]{width:100%;height:44px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;padding:0 14px;font:inherit;font-size:16px;outline:none;box-sizing:border-box}
#liveOv .lo-check{display:flex;align-items:center;gap:10px;font-size:15px;margin:6px 0 16px}
#liveOv .lo-check input{width:20px;height:20px}
#liveOv .lo-primary{width:100%;height:46px;border:0;border-radius:23px;background:#e11d48;color:#fff;font:inherit;font-weight:700;font-size:15px;cursor:pointer}
#liveSheet{position:fixed;inset:0;z-index:30100;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;font-family:inherit}
#liveSheet .ls{width:100%;max-width:520px;background:#fff;color:#0f172a;border-radius:22px 22px 0 0;padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 18px);animation:loUp .22s ease-out}
html.dark-mode #liveSheet .ls{background:#1c1c1e;color:#f1f5f9}
#liveSheet h3{margin:0 0 4px;font-size:18px}
#liveSheet p{margin:0 0 14px;font-size:13px;opacity:.7;line-height:1.45}
#liveSheet label.f{display:block;margin:0 0 14px}
#liveSheet label.f span{display:block;font-size:12px;opacity:.7;margin-bottom:6px;font-weight:600}
#liveSheet input[type=text]{width:100%;box-sizing:border-box;height:46px;border-radius:12px;border:1px solid rgba(120,120,128,.35);background:transparent;color:inherit;padding:0 14px;font:inherit;font-size:16px;outline:none}
#liveSheet .fps{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
#liveSheet .fps button{height:46px;border-radius:12px;border:1.5px solid rgba(120,120,128,.35);background:transparent;color:inherit;font:inherit;font-weight:700;cursor:pointer;line-height:1.1}
#liveSheet .fps button small{display:block;font-weight:500;font-size:10px;opacity:.65}
#liveSheet .fps button[aria-checked=true]{border-color:#e11d48;color:#e11d48;background:rgba(225,29,72,.08)}
#liveSheet .chk{display:flex;align-items:center;gap:10px;font-size:15px;margin:2px 0 16px}
#liveSheet .chk input{width:20px;height:20px}
#liveSheet .acts{display:flex;gap:10px}
#liveSheet .acts button{flex:1;height:48px;border-radius:24px;border:0;font:inherit;font-weight:700;font-size:15px;cursor:pointer}
#liveSheet .acts .no{background:rgba(120,120,128,.18);color:inherit}
#liveSheet .acts .go{background:#e11d48;color:#fff;flex:1.4}
`;
    document.head.appendChild(st);
  }

  function build() {
    css();
    el.banner = document.createElement('div');
    el.banner.id = 'liveBanner';
    el.banner.innerHTML = `<span style="display:flex">${I.live}</span><span class="lb-t"></span><button type="button"></button>`;
    el.banner.querySelector('button').textContent = T('live_watch', '見る');
    el.banner.querySelector('button').addEventListener('click', watch);
    document.body.appendChild(el.banner);

    el.ov = document.createElement('div');
    el.ov.id = 'liveOv';
    el.ov.innerHTML = `<video playsinline autoplay></video><div class="lo-msg"></div>
      <div class="lo-top"><span class="lo-badge">LIVE</span><button type="button" class="lo-cnt" aria-label="視聴者">${I.eye}<b>0</b></button><span class="lo-fps"></span><span class="lo-ttl"><b></b><small></small></span><button type="button" class="lo-x" aria-label="閉じる">${I.close}</button></div>
      <div class="lo-stack"><div class="lo-chat"></div>
        <div class="lo-in"><input type="text" maxlength="200" enterkeyhint="send" autocomplete="off"><button type="button" class="lo-btn lo-tts" aria-label="読み上げ">${I.spkOff}</button><button type="button" class="lo-btn lo-send" aria-label="送信" disabled>${I.send}</button></div>
        <div class="lo-bot"></div></div>`;
    document.body.appendChild(el.ov);
    el.video = el.ov.querySelector('video');
    el.msg = el.ov.querySelector('.lo-msg');
    el.cnt = el.ov.querySelector('.lo-cnt b');
    el.cntBtn = el.ov.querySelector('.lo-cnt');
    el.fps = el.ov.querySelector('.lo-fps');
    el.ttl = el.ov.querySelector('.lo-ttl b');
    el.sub = el.ov.querySelector('.lo-ttl small');
    el.chat = el.ov.querySelector('.lo-chat');
    el.input = el.ov.querySelector('.lo-in input');
    el.sendBtn = el.ov.querySelector('.lo-send');
    el.ttsBtn = el.ov.querySelector('.lo-tts');
    el.bot = el.ov.querySelector('.lo-bot');
    el.ov.querySelector('.lo-x').addEventListener('click', () => (role === 'host' ? confirmEnd() : stop()));
    el.cntBtn.addEventListener('click', openRoster);
    el.input.addEventListener('input', () => { el.sendBtn.disabled = !el.input.value.trim(); });
    el.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendComment(); } });
    el.sendBtn.addEventListener('click', sendComment);
    el.ttsBtn.addEventListener('click', toggleTts);
    ttsOn = lsGet('liveTts') === '1' && 'speechSynthesis' in window;
    paintTts();
  }

  // ---- コメント ----
  function sendComment() {
    const t = el.input.value.trim();
    if (!t || !role) return;
    send({ type: 'live_comment', groupId: cfg.groupId, text: t });
    el.input.value = ''; el.sendBtn.disabled = true;
  }
  function paintAvatar(node, name, pic) {
    node.textContent = '';
    if (typeof pic === 'string' && /^(https:\/\/|\/)/.test(pic)) node.style.backgroundImage = 'url("' + pic.replace(/["\\\n\r]/g, '') + '")';
    else { node.style.backgroundImage = ''; node.textContent = (name || '?').trim().charAt(0).toUpperCase(); }
  }
  function addChat(c, sys) {
    const row = document.createElement('div');
    row.className = 'lo-c' + (sys ? ' sys' : '') + (c && c.host ? ' host' : '');
    if (sys) row.textContent = sys;
    else {
      const av = document.createElement('div'); av.className = 'av'; paintAvatar(av, c.name, c.pic);
      const body = document.createElement('div');
      const nm = document.createElement('b'); nm.textContent = c.name;
      body.append(nm, document.createTextNode(c.text));
      row.append(av, body);
      row.dataset.id = c.id;
      if (role === 'host') { row.style.pointerEvents = 'auto'; row.addEventListener('click', () => { if (confirm(T('live_del_q', 'このコメントを消しますか?'))) send({ type: 'live_comment_delete', groupId: cfg.groupId, id: c.id }); }); }
    }
    el.chat.appendChild(row);
    while (el.chat.children.length > 40) el.chat.firstChild.remove();
  }
  function onComment(c) {
    if (!c) return;
    addChat(c);
    if (ttsOn && c.userId !== cfg.myUserId) speak(c.text);
  }

  // ---- 読み上げ ----
  function paintTts() {
    if (!el.ttsBtn) return;
    el.ttsBtn.innerHTML = ttsOn ? I.spk : I.spkOff;
    el.ttsBtn.classList.toggle('on', ttsOn);
    el.ttsBtn.style.display = 'speechSynthesis' in window ? '' : 'none';
  }
  function toggleTts() {
    if (!('speechSynthesis' in window)) return;
    ttsOn = !ttsOn; lsSet('liveTts', ttsOn ? '1' : '0'); paintTts();
    if (!ttsOn) { try { speechSynthesis.cancel(); } catch (_) {} ttsPending = 0; }
    else {
      if (role === 'host') el.msg.textContent = T('live_tts_echo', 'スピーカーで聞くと読み上げの声が配信に入ります。イヤホンがおすすめです');
      setTimeout(() => { if (el.msg.textContent === T('live_tts_echo', 'スピーカーで聞くと読み上げの声が配信に入ります。イヤホンがおすすめです')) el.msg.textContent = ''; }, 4000);
      speak(T('live_tts_on', 'コメントを読み上げます')); // 音が出るか確認でき、iOSは操作の中で一度鳴らさないと後から鳴らない
    }
  }
  function speak(text) {
    try {
      let t = String(text || '').replace(/https?:\/\/\S+/g, T('live_tts_url', 'URL')).replace(/(.)\1{4,}/g, '$1$1$1').trim().slice(0, 100);
      if (!t) return;
      if (ttsPending >= 4) { speechSynthesis.cancel(); ttsPending = 0; } // 流れが速い時は古いのを捨てて追いつく
      const u = new SpeechSynthesisUtterance(t);
      const lang = (window.i18n && i18n.getLang && i18n.getLang()) || 'ja';
      u.lang = SPEECH_LANG[lang] || 'ja-JP'; u.rate = 1.1;
      u.onend = u.onerror = () => { ttsPending = Math.max(0, ttsPending - 1); };
      ttsPending++;
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  // ---- 視聴者の名簿 ----
  function closePanel() { const p = el.ov.querySelector('.lo-panel'); if (p) p.remove(); }
  function panel(title) {
    closePanel();
    const pn = document.createElement('div'); pn.className = 'lo-panel';
    const h = document.createElement('div'); h.className = 'lo-ph';
    const b = document.createElement('b'); b.textContent = title;
    const x = document.createElement('button'); x.type = 'button'; x.innerHTML = I.close.replace('width="22" height="22"', 'width="16" height="16"'); x.setAttribute('aria-label', T('close', '閉じる'));
    x.addEventListener('click', closePanel);
    h.append(b, x); pn.appendChild(h); el.ov.appendChild(pn);
    return pn;
  }
  function openRoster() {
    if (!role) return;
    const pn = panel(T('live_viewers_title', '視聴者') + ' ' + roster.viewers.length);
    pn.dataset.kind = 'roster';
    paintRoster(pn);
  }
  function paintRoster(pn) {
    pn.querySelectorAll('.lo-row,.lo-empty').forEach(n => n.remove());
    pn.querySelector('.lo-ph b').textContent = T('live_viewers_title', '視聴者') + ' ' + roster.viewers.length;
    const mk = (u, isHost) => {
      const row = document.createElement('div'); row.className = 'lo-row';
      const av = document.createElement('div'); av.className = 'av'; paintAvatar(av, u.name, u.pic);
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = u.name;
      if (isHost) { const tg = document.createElement('span'); tg.className = 'tag'; tg.textContent = T('live_host', 'ホスト'); nm.appendChild(tg); }
      row.append(av, nm);
      if (!isHost && role === 'host') {
        const mu = document.createElement('button'); mu.type = 'button'; mu.className = u.muted ? 'on' : '';
        mu.textContent = u.muted ? T('live_unmute', 'コメント解除') : T('live_mute', 'コメント禁止');
        mu.addEventListener('click', () => send({ type: 'live_mute', groupId: cfg.groupId, userId: u.id, on: !u.muted }));
        const kk = document.createElement('button'); kk.type = 'button'; kk.textContent = T('live_kick', '退出させる');
        kk.addEventListener('click', () => { if (confirm(T('live_kick_q', '{name}さんを退出させますか?').replace('{name}', u.name))) send({ type: 'live_kick', groupId: cfg.groupId, userId: u.id }); });
        row.append(mu, kk);
      }
      return row;
    };
    if (roster.host) pn.appendChild(mk(roster.host, true));
    if (!roster.viewers.length) { const e = document.createElement('div'); e.className = 'lo-empty'; e.textContent = T('live_no_viewers', 'まだ誰も見ていません'); pn.appendChild(e); }
    roster.viewers.forEach(u => pn.appendChild(mk(u, false)));
  }
  function onRoster(d) {
    const prev = new Set(roster.viewers.map(v => v.id));
    roster = { host: d.host || null, viewers: Array.isArray(d.viewers) ? d.viewers : [] };
    el.cnt.textContent = String(roster.viewers.length);
    // 入室をコメント欄に出す(最初に名簿を受け取った時は、元からいた人なので出さない)
    if (rosterReady) roster.viewers.forEach(v => { if (!prev.has(v.id) && v.id !== cfg.myUserId) addChat(null, T('live_joined', '{name}さんが入室').replace('{name}', v.name)); });
    rosterReady = true;
    const pn = el.ov.querySelector('.lo-panel[data-kind="roster"]');
    if (pn) paintRoster(pn);
    if (role === 'host') applyBitrate();
  }

  // ---- タイトル・コメント許可 ----
  function paintMeta() {
    const t = (meta.title || '').trim();
    if (role === 'host') { el.ttl.textContent = t || T('live_you', 'あなたが配信中'); el.sub.textContent = ''; }
    else { el.ttl.textContent = t || hostName || T('live', 'ライブ配信'); el.sub.textContent = t ? hostName : ''; }
    el.sub.style.display = el.sub.textContent ? '' : 'none';
    const canType = role === 'host' || meta.comments !== false;
    el.input.disabled = !canType;
    el.input.placeholder = canType ? T('live_comment_ph', 'コメントを書く') : T('live_comments_off', 'コメントはオフです');
    if (!canType) { el.input.value = ''; el.sendBtn.disabled = true; }
  }
  function openSettings() {
    const pn = panel(T('live_settings', '配信の設定'));
    const f = document.createElement('label'); f.className = 'lo-field';
    const sp = document.createElement('span'); sp.textContent = T('live_title_label', 'タイトル');
    const inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 60; inp.value = meta.title || '';
    inp.placeholder = T('live_title_ph', 'タイトル(任意)');
    f.append(sp, inp);
    const ck = document.createElement('label'); ck.className = 'lo-check';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = meta.comments !== false;
    ck.append(cb, document.createTextNode(T('live_comments_on', 'コメントを受け付ける')));
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'lo-primary'; ok.textContent = T('save', '保存する');
    ok.addEventListener('click', () => {
      send({ type: 'live_settings', groupId: cfg.groupId, title: inp.value, comments: cb.checked });
      meta.title = inp.value.trim().slice(0, 60); meta.comments = cb.checked; paintMeta(); closePanel();
    });
    pn.append(f, ck, ok);
  }

  // ---- 配信開始シート(タイトル・フレームレート・コメント) ----
  function askStart() {
    return new Promise(resolve => {
      const saved = parseInt(lsGet('liveFps'), 10);
      let fps = [30, 60, 120].includes(saved) ? saved : 30;
      const wrap = document.createElement('div'); wrap.id = 'liveSheet';
      const box = document.createElement('div'); box.className = 'ls';
      const h = document.createElement('h3'); h.textContent = T('live_start_title', 'ライブ配信を始める');
      const pp = document.createElement('p'); pp.textContent = cfg.confirmText || T('live_confirm', 'グループのみんなにライブ配信を始めますか?(カメラとマイクを使います)');
      const lt = document.createElement('label'); lt.className = 'f';
      const lts = document.createElement('span'); lts.textContent = T('live_title_label', 'タイトル');
      const ti = document.createElement('input'); ti.type = 'text'; ti.maxLength = 60; ti.placeholder = T('live_title_ph', 'タイトル(任意)');
      lt.append(lts, ti);
      const lf = document.createElement('div'); lf.className = 'f';
      lf.style.margin = '0 0 14px';
      const lfs = document.createElement('span'); lfs.textContent = T('live_quality', 'フレームレート');
      lfs.style.cssText = 'display:block;font-size:12px;opacity:.7;margin-bottom:6px;font-weight:600';
      const row = document.createElement('div'); row.className = 'fps'; row.setAttribute('role', 'radiogroup');
      const note = document.createElement('p'); note.style.cssText = 'margin:8px 0 0;font-size:12px';
      const notes = {
        30: T('live_fps_note_30', '標準です。どの端末・回線でも安定します'),
        60: T('live_fps_note_60', 'なめらかです。端末が対応していて、見る人の回線も速い時に向いています'),
        120: T('live_fps_note_120', '対応する端末はごくわずかです。非対応なら自動で下がります。回線(上り)をたくさん使います'),
      };
      const btns = [30, 60, 120].map(v => {
        const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio');
        b.innerHTML = v + '<small>fps</small>';
        b.addEventListener('click', () => { fps = v; paint(); });
        row.appendChild(b); return b;
      });
      const paint = () => { btns.forEach((b, i) => b.setAttribute('aria-checked', [30, 60, 120][i] === fps ? 'true' : 'false')); note.textContent = notes[fps]; };
      paint();
      lf.append(lfs, row, note);
      const ck = document.createElement('label'); ck.className = 'chk';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = lsGet('liveComments') !== '0';
      ck.append(cb, document.createTextNode(T('live_comments_on', 'コメントを受け付ける')));
      const acts = document.createElement('div'); acts.className = 'acts';
      const no = document.createElement('button'); no.type = 'button'; no.className = 'no'; no.textContent = T('cancel', 'キャンセル');
      const go = document.createElement('button'); go.type = 'button'; go.className = 'go'; go.textContent = T('live_start_btn', '配信開始');
      const done = v => { wrap.remove(); resolve(v); };
      no.addEventListener('click', () => done(null));
      wrap.addEventListener('click', e => { if (e.target === wrap) done(null); });
      go.addEventListener('click', () => { lsSet('liveFps', String(fps)); lsSet('liveComments', cb.checked ? '1' : '0'); done({ title: ti.value.trim(), fps, comments: cb.checked }); });
      acts.append(no, go);
      box.append(h, pp, lt, lf, ck, acts); wrap.appendChild(box); document.body.appendChild(wrap);
    });
  }

  // 実際に出ているフレームレート(配信者=カメラ、見る人=受信)を、上のバーに小さく出す
  function showFps(n) {
    if (!el.fps) return;
    if (!n) { el.fps.classList.remove('on'); return; }
    el.fps.textContent = Math.round(n) + 'fps'; el.fps.classList.add('on');
  }
  async function pollStats() {
    const pc = pcs.get('host'); if (!pc || role !== 'viewer') return;
    try {
      const rep = await pc.getStats();
      let v = null; rep.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') v = r; });
      if (v && typeof v.framesPerSecond === 'number') showFps(v.framesPerSecond);
    } catch (_) {}
  }

  // 見ている人の数に合わせて、1人あたりの送信ビットレートとフレームレートの上限を決める
  function applyBitrate() {
    if (role !== 'host') return;
    const n = Math.max(1, pcs.size);
    const fps = meta.fps || 30;
    const per = Math.round(Math.max(600000, Math.min(BITRATE[fps] || BITRATE[30], (TOTAL_CAP[fps] || TOTAL_CAP[30]) / n)));
    pcs.forEach(pc => pc.getSenders().forEach(snd => {
      if (!snd.track || snd.track.kind !== 'video') return;
      try {
        const prm = snd.getParameters();
        if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
        prm.encodings[0].maxBitrate = per;
        prm.encodings[0].maxFramerate = fps;
        prm.degradationPreference = 'maintain-framerate';
        snd.setParameters(prm).catch(() => {});
      } catch (_) {}
    }));
  }
  function camConstraints() {
    const fps = meta.fps || 30;
    return { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 }, frameRate: { ideal: fps } };
  }

  async function loadIce() {
    if (iceLoaded) return;
    try {
      const r = await fetch('/api/ice', { headers: { Authorization: 'Bearer ' + cfg.token } });
      const d = await r.json();
      if (Array.isArray(d.iceServers) && d.iceServers.length) ice = d.iceServers.concat(ICE_FALLBACK);
      iceLoaded = true;
    } catch (_) {}
  }

  function newPc(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ice });
    pc.onicecandidate = e => { if (e.candidate) send({ type: 'live_signal', groupId: cfg.groupId, to: peerId, kind: 'ice', candidate: e.candidate }); };
    pc._pending = [];
    return pc;
  }
  async function flushIce(pc) { for (const c of pc._pending.splice(0)) { try { await pc.addIceCandidate(c); } catch (_) {} } }

  function showOverlay(name) {
    el.ov.classList.add('on');
    el.ov.classList.toggle('viewer', role !== 'host');
    el.bot.textContent = '';
    closePanel(); el.chat.textContent = ''; showFps(0); rosterReady = false;
    roster = { host: null, viewers: [] }; el.cnt.textContent = '0';
    paintMeta();
    if (role === 'host') {
      const flip = btn(I.flip, 'カメラ切替', flipCam);
      const mic = btn(I.mic, 'マイク', () => {
        micOn = !micOn;
        stream && stream.getAudioTracks().forEach(t => { t.enabled = micOn; });
        mic.innerHTML = micOn ? I.mic : I.micOff;
        mic.classList.toggle('off', !micOn);
      });
      const end = document.createElement('button');
      end.type = 'button'; end.className = 'lo-btn lo-end'; end.textContent = T('live_end', '配信を終わる');
      end.addEventListener('click', confirmEnd);
      const set = btn(I.gear, T('live_settings', '配信の設定'), openSettings);
      el.flip = flip;
      if (canShare()) {
        const sc = btn(I.screen, '画面共有', () => (screen ? stopScreen() : startScreen()));
        el.scr = sc;
        el.bot.append(flip, sc, set, end, mic);
      } else el.bot.append(flip, set, end, mic);
    }
  }
  function btn(svg, label, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'lo-btn'; b.innerHTML = svg; b.setAttribute('aria-label', label);
    b.addEventListener('click', fn);
    return b;
  }

  // ---- 配信する ----
  async function start() {
    if (role) return;
    if (!navigator.mediaDevices || !window.RTCPeerConnection) { alert('この端末では配信できません'); return; }
    if (cfg.feed) cfg.groupId = 'u:' + cfg.myUserId;
    const opt = await askStart();
    if (!opt) return;
    meta = { title: opt.title, comments: opt.comments, fps: opt.fps };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: camConstraints(), audio: true });
    } catch (e) {
      // フレームレートの指定で断られる端末は、指定なしでもう一度
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 } }, audio: true }); }
      catch (e2) { alert('カメラ/マイクにアクセスできません'); return; }
    }
    const vt = stream.getVideoTracks()[0];
    try { vt.contentHint = 'motion'; } catch (_) {} // 細かさより動きのなめらかさを優先
    role = 'host'; micOn = true;
    await loadIce();
    el.video.srcObject = stream; el.video.muted = true; el.video.classList.toggle('mirror', facing === 'user');
    el.msg.textContent = '';
    showOverlay(T('live_you', 'あなたが配信中'));
    // 端末が出せる上限まで。頼んだ数字に届かなければ知らせる
    const real = vt && vt.getSettings && vt.getSettings().frameRate;
    if (real) {
      showFps(real);
      if (meta.fps > 30 && real < meta.fps - 2) {
        el.msg.textContent = T('live_fps_actual', 'この端末のカメラは{n}fpsまでです').replace('{n}', Math.round(real));
        setTimeout(() => { if (role === 'host' && /fps/.test(el.msg.textContent)) el.msg.textContent = ''; }, 5000);
      }
    }
    send({ type: 'live_start', groupId: cfg.groupId, title: meta.title, comments: meta.comments, fps: meta.fps });
    hostReady = false;
    setTimeout(() => { if (role === 'host' && !hostReady) el.msg.textContent = T('live_waiting_server', 'サーバーにつないでいます...(まだ誰にも見えていません)'); }, 5000);
    if (window.LiquidGlass) window.LiquidGlass.haptic('medium');
  }

  async function flipCam() {
    if (!stream || screen) return;
    facing = facing === 'user' ? 'environment' : 'user';
    try {
      const ns = await navigator.mediaDevices.getUserMedia({ video: camConstraints() });
      const nt = ns.getVideoTracks()[0];
      try { nt.contentHint = 'motion'; } catch (_) {}
      const old = stream.getVideoTracks()[0];
      pcs.forEach(pc => pc.getSenders().forEach(s => { if (s.track && s.track.kind === 'video') s.replaceTrack(nt); }));
      if (old) { stream.removeTrack(old); old.stop(); }
      stream.addTrack(nt);
      el.video.srcObject = stream; el.video.classList.toggle('mirror', facing === 'user');
      applyBitrate();
    } catch (e) { facing = facing === 'user' ? 'environment' : 'user'; }
  }

  async function offerTo(viewerId) {
    const old = pcs.get(viewerId); if (old) old.close();
    const pc = newPc(viewerId);
    pcs.set(viewerId, pc);
    outTracks().forEach(t => pc.addTrack(t, stream));
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') { pc.close(); pcs.delete(viewerId); } };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'live_signal', groupId: cfg.groupId, to: viewerId, kind: 'offer', sdp: pc.localDescription });
    applyBitrate();
  }

  // 今見ている人に送るべきトラック(画面共有中は画面と、マイク+画面の音を混ぜたもの)
  function outTracks() {
    const v = screen ? screen.video : stream.getVideoTracks()[0];
    const a = screen && screen.audio ? screen.audio : stream.getAudioTracks()[0];
    return [a, v].filter(Boolean);
  }
  function swap(kind, track) {
    pcs.forEach(pc => pc.getSenders().forEach(s => { if (s.track && s.track.kind === kind) s.replaceTrack(track).catch(() => {}); }));
  }

  async function startScreen() {
    if (!stream || screen) return;
    let ds;
    const quit = e => !e || e.name === 'NotAllowedError' || e.name === 'AbortError'; // 自分でやめた
    try {
      ds = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: Math.min(60, meta.fps || 30) } }, audio: true });
    } catch (e) {
      if (quit(e)) return;
      // 音付きを断られる環境があるので、映像だけでもう一度
      try { ds = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: Math.min(60, meta.fps || 30) } }, audio: false }); }
      catch (e2) {
        if (quit(e2)) return;
        // デスクトップ版の古いexe(1.0.3より前)は画面共有の仕組みが入っていない
        const dv = /BroChatDesktop\/(\d+)\.(\d+)\.(\d+)/.exec(navigator.userAgent);
        const old = dv && (+dv[1] * 1e6 + +dv[2] * 1e3 + +dv[3]) < 1000003;
        alert(old ? 'このデスクトップ版は古くて画面共有ができません。GitHubのReleasesから最新のBroChatSetup.exeを入れ直してください。'
          : '画面共有を始められませんでした(' + ((e2 && (e2.name || e2.message)) || '不明') + ')');
        return;
      }
    }
    const v = ds.getVideoTracks()[0];
    if (!v) { ds.getTracks().forEach(t => t.stop()); return; }
    try { v.contentHint = 'detail'; } catch (_) {} // 文字がつぶれないように(動きより細かさを優先)
    screen = { stream: ds, video: v, mix: null, audio: null };
    // 画面(タブ・PC)の音もある時は、マイクと混ぜて1本にする(つなぎ直しをせずに差し替えられる)
    const da = ds.getAudioTracks()[0];
    const mic = stream.getAudioTracks()[0];
    if (da && window.AudioContext) {
      try {
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        ctx.createMediaStreamSource(new MediaStream([da])).connect(dest);
        if (mic) ctx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
        screen.mix = ctx; screen.audio = dest.stream.getAudioTracks()[0];
        swap('audio', screen.audio);
      } catch (_) {}
    }
    swap('video', v);
    v.addEventListener('ended', stopScreen); // ブラウザの「共有を停止」を押された時
    el.video.srcObject = new MediaStream([v]);
    el.video.classList.remove('mirror');
    if (el.scr) el.scr.classList.add('off');
    if (el.flip) el.flip.disabled = true;
  }

  function stopScreen() {
    if (!screen) return;
    const s = screen; screen = null;
    if (stream) {
      const cam = stream.getVideoTracks()[0], mic = stream.getAudioTracks()[0];
      if (cam) swap('video', cam);
      if (s.audio && mic) swap('audio', mic);
      el.video.srcObject = stream; el.video.classList.toggle('mirror', facing === 'user');
    }
    s.stream.getTracks().forEach(t => t.stop());
    if (s.mix) s.mix.close().catch(() => {});
    if (el.scr) el.scr.classList.remove('off');
    if (el.flip) el.flip.disabled = false;
  }

  function confirmEnd() { if (confirm(T('live_end_q', '配信を終わりますか?'))) stop(); }

  // ---- 見る ----
  async function watch() {
    if (role) return;
    if (!window.RTCPeerConnection) { alert('この端末では見られません'); return; }
    role = 'viewer';
    await loadIce();
    el.video.srcObject = null; el.video.muted = false; el.video.classList.remove('mirror');
    el.msg.textContent = T('live_connecting', 'つないでいます...');
    meta = { title: '', comments: true, fps: 30 };
    showOverlay(hostName || T('live', 'ライブ配信'));
    if (statTimer) clearInterval(statTimer);
    statTimer = setInterval(pollStats, 2000);
    send({ type: 'live_join', groupId: cfg.groupId });
  }

  async function onOffer(from, sdp) {
    if (role !== 'viewer' || from !== hostId) return;
    const old = pcs.get('host'); if (old) old.close();
    const pc = newPc(from);
    pcs.set('host', pc);
    pc.ontrack = e => {
      el.video.srcObject = e.streams[0];
      el.msg.textContent = '';
      el.video.play().catch(() => { el.msg.textContent = T('live_tap', '画面をタップすると音が出ます'); el.video.muted = true; el.video.play().catch(() => {}); });
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') el.msg.textContent = T('live_failed', 'つながりませんでした'); };
    await pc.setRemoteDescription(sdp);
    await flushIce(pc);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    send({ type: 'live_signal', groupId: cfg.groupId, to: from, kind: 'answer', sdp: pc.localDescription });
  }

  // ---- 終わる ----
  function stop(silent) {
    if (role) send({ type: role === 'host' ? 'live_end' : 'live_leave', groupId: cfg.groupId });
    if (screen) stopScreen();
    pcs.forEach(pc => { try { pc.close(); } catch (_) {} });
    pcs.clear();
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    el.video.srcObject = null;
    el.ov.classList.remove('on');
    closePanel(); el.chat.textContent = ''; showFps(0);
    if (statTimer) { clearInterval(statTimer); statTimer = null; }
    try { speechSynthesis.cancel(); } catch (_) {} ttsPending = 0;
    roster = { host: null, viewers: [] }; rosterReady = false;
    role = null;
    if (!silent) send({ type: 'live_status', groupId: cfg.groupId });
  }

  function setBanner(live) {
    if (cfg.noBanner) return;
    if (live && hostId && hostId !== cfg.myUserId && role !== 'viewer') {
      el.banner.querySelector('.lb-t').textContent = T('live_now', '{name}がライブ配信中').replace('{name}', hostName || '') + (bannerTitle ? ' ・ ' + bannerTitle : '');
      el.banner.classList.add('on');
    } else el.banner.classList.remove('on');
  }

  // ---- サーバーからの合図 ----
  async function handle(d) {
    if (!d || d.groupId !== cfg.groupId) return;
    switch (d.type) {
      case 'live_status':
      case 'live_started':
        if (d.type === 'live_status' && !d.live) { hostId = null; setBanner(false); return; }
        hostId = d.hostId; hostName = d.hostName || '';
        bannerTitle = d.title || '';
        setBanner(true);
        return;
      case 'live_meta':
        meta.title = d.title || ''; meta.comments = d.comments !== false;
        paintMeta();
        return;
      case 'live_viewers':
        onRoster(d);
        return;
      case 'live_comment':
        onComment(d.comment);
        return;
      case 'live_chat':
        (d.items || []).forEach(c => addChat(c));
        return;
      case 'live_comment_deleted': {
        const n = el.chat.querySelector('[data-id="' + String(d.id).replace(/[^\w-]/g, '') + '"]');
        if (n) n.remove();
        return;
      }
      case 'live_comment_rejected':
        el.msg.textContent = d.reason === 'muted' ? T('live_muted', 'コメントを止められています')
          : d.reason === 'off' ? T('live_comments_off', 'コメントはオフです') : T('live_rate', 'コメントが速すぎます');
        setTimeout(() => { if (el.msg.textContent && /コメント|comment/i.test(el.msg.textContent)) el.msg.textContent = ''; }, 2000);
        return;
      case 'live_ended':
        hostId = null; setBanner(false);
        if (role === 'viewer') { el.msg.textContent = T('live_over', '配信は終わりました'); setTimeout(() => stop(true), 1500); }
        return;
      case 'live_ready':
        hostReady = true;
        if (role === 'host' && el.msg.textContent === T('live_waiting_server', 'サーバーにつないでいます...(まだ誰にも見えていません)')) el.msg.textContent = '';
        return;
      case 'live_error':
        alert(d.error || 'ライブ配信でエラーが起きました');
        if (role) stop(true);
        return;
      case 'live_count':
        el.cnt.textContent = String(d.viewers || 0);
        return;
      case 'live_viewer':
        if (role === 'host' && stream) offerTo(d.userId).catch(e => console.warn('[live] offer failed', e));
        return;
      case 'live_viewer_left': {
        const pc = pcs.get(d.userId); if (pc) { pc.close(); pcs.delete(d.userId); }
        return;
      }
      case 'live_signal': {
        if (d.kind === 'offer') return onOffer(d.from, d.sdp).catch(e => console.warn('[live] answer failed', e));
        const pc = role === 'host' ? pcs.get(d.from) : pcs.get('host');
        if (!pc) return;
        if (d.kind === 'answer') { try { await pc.setRemoteDescription(d.sdp); await flushIce(pc); } catch (_) {} }
        else if (d.kind === 'ice' && d.candidate) {
          if (pc.remoteDescription) { try { await pc.addIceCandidate(d.candidate); } catch (_) {} }
          else pc._pending.push(d.candidate);
        }
      }
    }
  }

  function init(c) {
    cfg = c;
    build();
    if (authedEarly) { authedEarly = false; onAuthed(); }
    // 横長(画面共有など)は切らずに全体を見せる。縦長のカメラは今まで通り画面いっぱい
    el.video.addEventListener('resize', () => { el.video.classList.toggle('wide', el.video.videoWidth > el.video.videoHeight * 1.1); });
    el.video.addEventListener('click', () => { if (role === 'viewer' && el.video.muted) { el.video.muted = false; el.msg.textContent = ''; } });
    window.addEventListener('pagehide', () => { if (role) stop(true); });
    // スマホのキーボードが出ても、入力欄とコメントが隠れないように持ち上げる
    if (window.visualViewport) {
      const lift = () => {
        const vv = window.visualViewport;
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        el.ov.style.setProperty('--lo-kb', kb > 80 ? kb + 'px' : '0px');
      };
      window.visualViewport.addEventListener('resize', lift);
      window.visualViewport.addEventListener('scroll', lift);
    }
  }
  function requestStatus() { if (cfg.groupId) send({ type: 'live_status', groupId: cfg.groupId }); }
  // 投稿タブ: 一覧から選んだ人のライブを見る
  function watchFeed(key, hId, hName) {
    if (role) return;
    cfg.groupId = key; hostId = hId; hostName = hName || '';
    watch();
  }
  const isBusy = () => !!role;

  window.Live = { init, start, watch, watchFeed, stop, handle, requestStatus, isBusy, onAuthed, ICON: I.live };
})();
