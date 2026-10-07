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
    eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  };

  let cfg = null, ice = ICE_FALLBACK, iceLoaded = false;
  let role = null; // 'host' | 'viewer' | null
  let stream = null, facing = 'user', micOn = true;
  let hostId = null, hostName = '', startedAt = 0, tick = null;
  const pcs = new Map(); // 配信者: viewerId -> pc / 見る人: 'host' -> pc
  const el = {};

  const send = o => { const ws = cfg.getWs(); if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
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
#liveOv .lo-top{position:absolute;left:0;right:0;top:0;padding:calc(env(safe-area-inset-top,0px) + 12px) 14px 30px;display:flex;align-items:center;gap:8px;background:linear-gradient(rgba(0,0,0,.55),transparent)}
#liveOv .lo-badge{background:#e11d48;border-radius:6px;padding:3px 8px;font-weight:800;font-size:12px;letter-spacing:.06em}
#liveOv .lo-cnt{display:flex;align-items:center;gap:4px;background:rgba(0,0,0,.45);border-radius:6px;padding:3px 8px;font-size:12px}
#liveOv .lo-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:15px;text-shadow:0 1px 3px rgba(0,0,0,.5)}
#liveOv .lo-x{width:40px;height:40px;border-radius:50%;border:0;background:rgba(0,0,0,.45);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}
#liveOv .lo-bot{position:absolute;left:0;right:0;bottom:0;padding:30px 20px calc(env(safe-area-inset-bottom,0px) + 22px);display:flex;justify-content:center;gap:22px;background:linear-gradient(transparent,rgba(0,0,0,.55))}
#liveOv .lo-btn{width:56px;height:56px;border-radius:50%;border:0;background:rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}
#liveOv .lo-btn.off{background:#fff;color:#111}
#liveOv .lo-end{width:auto;padding:0 24px;border-radius:28px;background:#e11d48;font-weight:700;font-size:15px;font-family:inherit}
#liveOv .lo-msg{position:absolute;left:0;right:0;top:45%;text-align:center;font-size:15px;opacity:.85;padding:0 24px}
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
      <div class="lo-top"><span class="lo-badge">LIVE</span><span class="lo-cnt">${I.eye}<b>0</b></span><span class="lo-name"></span><button type="button" class="lo-x" aria-label="閉じる">${I.close}</button></div>
      <div class="lo-bot"></div>`;
    document.body.appendChild(el.ov);
    el.video = el.ov.querySelector('video');
    el.msg = el.ov.querySelector('.lo-msg');
    el.cnt = el.ov.querySelector('.lo-cnt b');
    el.name = el.ov.querySelector('.lo-name');
    el.bot = el.ov.querySelector('.lo-bot');
    el.ov.querySelector('.lo-x').addEventListener('click', () => (role === 'host' ? confirmEnd() : stop()));
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
    el.name.textContent = name;
    el.ov.classList.add('on');
    el.bot.textContent = '';
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
      el.bot.append(flip, end, mic);
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
    if (!confirm(T('live_confirm', 'グループのみんなにライブ配信を始めますか?(カメラとマイクを使います)'))) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 } }, audio: true });
    } catch (e) { alert('カメラ/マイクにアクセスできません'); return; }
    role = 'host'; micOn = true;
    await loadIce();
    el.video.srcObject = stream; el.video.muted = true; el.video.classList.toggle('mirror', facing === 'user');
    el.msg.textContent = '';
    showOverlay(T('live_you', 'あなたが配信中'));
    el.cnt.textContent = '0';
    send({ type: 'live_start', groupId: cfg.groupId });
    if (window.LiquidGlass) window.LiquidGlass.haptic('medium');
  }

  async function flipCam() {
    if (!stream) return;
    facing = facing === 'user' ? 'environment' : 'user';
    try {
      const ns = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 } } });
      const nt = ns.getVideoTracks()[0];
      const old = stream.getVideoTracks()[0];
      pcs.forEach(pc => pc.getSenders().forEach(s => { if (s.track && s.track.kind === 'video') s.replaceTrack(nt); }));
      if (old) { stream.removeTrack(old); old.stop(); }
      stream.addTrack(nt);
      el.video.srcObject = stream; el.video.classList.toggle('mirror', facing === 'user');
    } catch (e) { facing = facing === 'user' ? 'environment' : 'user'; }
  }

  async function offerTo(viewerId) {
    const old = pcs.get(viewerId); if (old) old.close();
    const pc = newPc(viewerId);
    pcs.set(viewerId, pc);
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') { pc.close(); pcs.delete(viewerId); } };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'live_signal', groupId: cfg.groupId, to: viewerId, kind: 'offer', sdp: pc.localDescription });
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
    showOverlay(hostName || T('live', 'ライブ配信'));
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
    pcs.forEach(pc => { try { pc.close(); } catch (_) {} });
    pcs.clear();
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    el.video.srcObject = null;
    el.ov.classList.remove('on');
    role = null;
    if (!silent) send({ type: 'live_status', groupId: cfg.groupId });
  }

  function setBanner(live) {
    if (live && hostId && hostId !== cfg.myUserId && role !== 'viewer') {
      el.banner.querySelector('.lb-t').textContent = T('live_now', '{name}がライブ配信中').replace('{name}', hostName || '');
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
        setBanner(true);
        return;
      case 'live_ended':
        hostId = null; setBanner(false);
        if (role === 'viewer') { el.msg.textContent = T('live_over', '配信は終わりました'); setTimeout(() => stop(true), 1500); }
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
    el.video.addEventListener('click', () => { if (role === 'viewer' && el.video.muted) { el.video.muted = false; el.msg.textContent = ''; } });
    window.addEventListener('pagehide', () => { if (role) stop(true); });
  }
  function requestStatus() { send({ type: 'live_status', groupId: cfg.groupId }); }

  window.Live = { init, start, watch, stop, handle, requestStatus, ICON: I.live };
})();
