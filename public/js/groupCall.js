// groupCall.js
// グループ通話(メッシュ型WebRTC)。入った人が、既に入っている全員へofferを送る。
// サーバー(ws/wsServer.js)は名簿とSDP/ICEの中継だけ。映像・音声は端末同士で直接流れる。
(function () {
  const ICE_FALLBACK = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

  const SVG = {
    mic: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
    cam: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
    camOff: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
    end: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(135deg)"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  };

  let cfg = null;
  let inCall = false, isVideo = false, joining = false;
  let localStream = null, iceServers = ICE_FALLBACK;
  let micOn = true, camOn = true;
  let timerId = null, seconds = 0;
  let active = false, activeVideo = false;
  const peers = new Map(); // userId -> { pc, stream, pendingIce: [], hasRemote: false }
  const els = {};

  function css() {
    if (document.getElementById('gcallCss')) return;
    const st = document.createElement('style');
    st.id = 'gcallCss';
    st.textContent = `
#gcallBanner{position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 64px);z-index:60;display:none;align-items:center;gap:10px;padding:10px 14px;border-radius:16px;background:rgba(16,185,129,.92);color:#fff;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
#gcallBanner.show{display:flex}
#gcallBanner .t{flex:1;font-weight:600}
#gcallBanner button{border:0;border-radius:999px;padding:7px 14px;background:#fff;color:#0f766e;font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px}
#gcallOv{position:fixed;inset:0;z-index:200;display:none;flex-direction:column;background:#0b1220;color:#fff}
#gcallOv.show{display:flex}
#gcallTop{padding:calc(env(safe-area-inset-top,0px) + 14px) 16px 8px;text-align:center}
#gcallTop .n{font-size:17px;font-weight:700}
#gcallTop .s{font-size:13px;opacity:.7;margin-top:2px}
#gcallGrid{flex:1;min-height:0;display:grid;gap:8px;padding:8px;grid-auto-rows:1fr}
#gcallGrid.n1{grid-template-columns:1fr}
#gcallGrid.n2{grid-template-columns:1fr;grid-template-rows:1fr 1fr}
#gcallGrid.n3,#gcallGrid.n4{grid-template-columns:1fr 1fr}
#gcallGrid.n5,#gcallGrid.n6{grid-template-columns:1fr 1fr}
.gct{position:relative;border-radius:18px;overflow:hidden;background:#1a2333;display:flex;align-items:center;justify-content:center;min-height:0}
.gct video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}
.gct.novid video{display:none}
.gct .av{width:72px;height:72px;border-radius:50%;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:700;color:#fff}
.gct .nm{position:absolute;left:10px;bottom:8px;font-size:12px;padding:3px 9px;border-radius:999px;background:rgba(0,0,0,.5)}
.gct .st{position:absolute;right:10px;top:8px;font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.5);display:none}
.gct.connecting .st{display:block}
#gcallCtl{display:flex;justify-content:center;gap:18px;padding:12px 16px calc(env(safe-area-inset-bottom,0px) + 20px)}
#gcallCtl button{width:58px;height:58px;border-radius:50%;border:0;background:rgba(255,255,255,.16);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}
#gcallCtl button.off{background:#fff;color:#111}
#gcallCtl button.end{background:#ef4444}
`;
    document.head.appendChild(st);
  }

  function build() {
    if (els.ov) return;
    css();
    const b = document.createElement('div');
    b.id = 'gcallBanner';
    b.innerHTML = '<span class="t" id="gcallBannerT">グループ通話中</span><button type="button" id="gcallJoinBtn">' + SVG.phone + '参加</button>';
    document.body.appendChild(b);
    const ov = document.createElement('div');
    ov.id = 'gcallOv';
    ov.innerHTML = '<div id="gcallTop"><div class="n" id="gcallName"></div><div class="s" id="gcallSt">接続中</div></div>' +
      '<div id="gcallGrid" class="n1"></div>' +
      '<div id="gcallCtl"><button type="button" id="gcMic" aria-label="マイク">' + SVG.mic + '</button>' +
      '<button type="button" id="gcCam" aria-label="カメラ">' + SVG.cam + '</button>' +
      '<button type="button" class="end" id="gcEnd" aria-label="退出">' + SVG.end + '</button></div>';
    document.body.appendChild(ov);
    els.banner = b; els.bannerT = b.querySelector('#gcallBannerT'); els.ov = ov;
    els.grid = ov.querySelector('#gcallGrid'); els.st = ov.querySelector('#gcallSt'); els.name = ov.querySelector('#gcallName');
    els.mic = ov.querySelector('#gcMic'); els.cam = ov.querySelector('#gcCam');
    b.querySelector('#gcallJoinBtn').onclick = () => join(activeVideo);
    ov.querySelector('#gcEnd').onclick = () => leave();
    els.mic.onclick = () => {
      micOn = !micOn;
      if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = micOn; });
      els.mic.innerHTML = micOn ? SVG.mic : SVG.micOff;
      els.mic.classList.toggle('off', !micOn);
    };
    els.cam.onclick = () => {
      camOn = !camOn;
      if (localStream) localStream.getVideoTracks().forEach(t => { t.enabled = camOn; });
      els.cam.innerHTML = camOn ? SVG.cam : SVG.camOff;
      els.cam.classList.toggle('off', !camOn);
      const t = els.grid.querySelector('[data-uid="' + cfg.myUserId + '"]');
      if (t) t.classList.toggle('novid', !camOn || !isVideo);
    };
  }

  function send(obj) {
    const ws = cfg && cfg.getWs && cfg.getWs();
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  function memberOf(uid) {
    return (cfg.getMembers() || []).find(m => m.id === uid) || { name: 'メンバー', color: '#64748b', initials: '?', avatarImg: '' };
  }

  function tileFor(uid) {
    let t = els.grid.querySelector('[data-uid="' + uid + '"]');
    if (t) return t;
    const m = uid === cfg.myUserId ? { name: cfg.myName || '自分', color: '#64748b', initials: (cfg.myName || '自').charAt(0), avatarImg: cfg.myAvatar || '' } : memberOf(uid);
    t = document.createElement('div');
    t.className = 'gct novid' + (uid === cfg.myUserId ? '' : ' connecting');
    t.dataset.uid = uid;
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.setAttribute('playsinline', '');
    if (uid === cfg.myUserId) v.muted = true;
    const av = document.createElement('div');
    av.className = 'av';
    if (m.avatarImg) av.style.backgroundImage = 'url("' + String(m.avatarImg).replace(/"/g, '%22') + '")';
    else { av.style.background = m.color; av.textContent = m.initials; }
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = uid === cfg.myUserId ? '自分' : m.name;
    const st = document.createElement('div'); st.className = 'st'; st.textContent = '接続中';
    t.append(v, av, nm, st);
    els.grid.appendChild(t);
    layout();
    return t;
  }

  function layout() {
    const n = Math.min(Math.max(els.grid.children.length, 1), 6);
    els.grid.className = 'n' + n;
  }

  function removeTile(uid) {
    const t = els.grid.querySelector('[data-uid="' + uid + '"]');
    if (t) t.remove();
    layout();
  }

  async function loadIce() {
    try {
      const res = await fetch('/api/ice', { headers: { Authorization: 'Bearer ' + cfg.token } });
      if (res.ok) {
        const d = await res.json();
        if (Array.isArray(d.iceServers) && d.iceServers.length) iceServers = d.iceServers;
      }
    } catch (e) { console.warn('[gcall] ICE取得失敗、STUNのみで続行', e); }
  }

  function makePeer(uid) {
    if (peers.has(uid)) return peers.get(uid);
    const pc = new RTCPeerConnection({ iceServers });
    const p = { pc, pendingIce: [], hasRemote: false };
    peers.set(uid, p);
    localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));
    pc.onicecandidate = e => {
      if (e.candidate) send({ type: 'gcall_signal', groupId: cfg.groupId, to: uid, kind: 'ice', candidate: e.candidate });
    };
    pc.ontrack = e => {
      const t = tileFor(uid);
      const v = t.querySelector('video');
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (v.srcObject !== stream) v.srcObject = stream;
      v.play().catch(() => {});
      const hasVideo = stream.getVideoTracks().length > 0;
      t.classList.toggle('novid', !hasVideo);
      t.classList.remove('connecting');
    };
    pc.onconnectionstatechange = () => {
      const t = els.grid && els.grid.querySelector('[data-uid="' + uid + '"]');
      if (pc.connectionState === 'connected' && t) t.classList.remove('connecting');
      if (pc.connectionState === 'failed') {
        try { pc.restartIce && pc.restartIce(); } catch (e) {}
      }
    };
    tileFor(uid);
    return p;
  }

  function dropPeer(uid) {
    const p = peers.get(uid);
    if (p) { try { p.pc.close(); } catch (e) {} peers.delete(uid); }
    if (els.grid) removeTile(uid);
    updateStatus();
  }

  function updateStatus() {
    if (!els.st) return;
    const n = peers.size + 1;
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    els.st.textContent = n + '人  ' + m + ':' + s;
  }

  async function callPeer(uid) {
    const p = makePeer(uid);
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    send({ type: 'gcall_signal', groupId: cfg.groupId, to: uid, kind: 'offer', sdp: p.pc.localDescription });
  }

  async function flushIce(p) {
    p.hasRemote = true;
    while (p.pendingIce.length) {
      try { await p.pc.addIceCandidate(p.pendingIce.shift()); } catch (e) {}
    }
  }

  async function onSignal(d) {
    if (!inCall) return;
    const uid = d.from;
    try {
      if (d.kind === 'offer') {
        const p = makePeer(uid);
        await p.pc.setRemoteDescription(d.sdp);
        await flushIce(p);
        const ans = await p.pc.createAnswer();
        await p.pc.setLocalDescription(ans);
        send({ type: 'gcall_signal', groupId: cfg.groupId, to: uid, kind: 'answer', sdp: p.pc.localDescription });
      } else if (d.kind === 'answer') {
        const p = peers.get(uid);
        if (!p) return;
        await p.pc.setRemoteDescription(d.sdp);
        await flushIce(p);
      } else if (d.kind === 'ice') {
        const p = peers.get(uid) || makePeer(uid);
        if (p.hasRemote) await p.pc.addIceCandidate(d.candidate).catch(() => {});
        else p.pendingIce.push(d.candidate);
      }
    } catch (e) {
      console.error('[gcall] signal error', d.kind, e);
    }
  }

  async function join(video) {
    if (inCall || joining) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert('この端末では通話を使えません'); return; }
    joining = true;
    build();
    isVideo = !!video;
    try {
      await loadIce();
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: isVideo ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } : false,
        });
      } catch (e) {
        alert('マイク' + (isVideo ? 'かカメラ' : '') + 'を使えませんでした。権限を確認してください');
        joining = false;
        return;
      }
      micOn = true; camOn = true;
      els.mic.innerHTML = SVG.mic; els.mic.classList.remove('off');
      els.cam.innerHTML = SVG.cam; els.cam.classList.remove('off');
      els.cam.style.display = isVideo ? 'flex' : 'none';
      els.grid.innerHTML = '';
      els.name.textContent = cfg.getGroupName();
      inCall = true;
      els.ov.classList.add('show');
      const me = tileFor(cfg.myUserId);
      const mv = me.querySelector('video');
      mv.srcObject = localStream;
      me.classList.toggle('novid', !isVideo);
      seconds = 0;
      clearInterval(timerId);
      timerId = setInterval(() => { seconds++; updateStatus(); }, 1000);
      updateStatus();
      if (!send({ type: 'gcall_join', groupId: cfg.groupId, video: isVideo })) {
        cleanup();
        alert('サーバーに繋がっていません。少し待ってからもう一度');
      }
    } finally {
      joining = false;
    }
  }

  function cleanup() {
    clearInterval(timerId); timerId = null;
    peers.forEach(p => { try { p.pc.close(); } catch (e) {} });
    peers.clear();
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    inCall = false;
    if (els.ov) els.ov.classList.remove('show');
    if (els.grid) els.grid.innerHTML = '';
    renderBanner();
  }

  function leave() {
    if (inCall) send({ type: 'gcall_leave', groupId: cfg.groupId });
    cleanup();
  }

  function renderBanner() {
    if (!els.banner) return;
    els.banner.classList.toggle('show', active && !inCall);
  }

  function handle(d) {
    if (!cfg || d.groupId !== cfg.groupId) return false;
    build();
    switch (d.type) {
      case 'gcall_state':
        if (d.self) {
          // 入室完了。既存の全員へこちらからofferを送る
          d.participants.forEach(uid => callPeer(uid).catch(e => console.error('[gcall] offer failed', e)));
        } else {
          active = !!d.active; activeVideo = !!d.video;
          if (els.bannerT) els.bannerT.textContent = 'グループ通話中 (' + (d.participants || []).length + '人)';
          renderBanner();
        }
        return true;
      case 'gcall_started':
        active = true; activeVideo = !!d.video;
        els.bannerT.textContent = d.byName + ' がグループ通話を始めました';
        renderBanner();
        return true;
      case 'gcall_ended':
        active = false;
        renderBanner();
        return true;
      case 'gcall_joined':
        if (inCall) tileFor(d.userId); // 相手からofferが来るまで枠だけ出す
        return true;
      case 'gcall_left':
        if (inCall) dropPeer(d.userId);
        return true;
      case 'gcall_signal':
        onSignal(d);
        return true;
      case 'gcall_full':
        cleanup();
        alert('この通話は満員です(最大' + d.max + '人)');
        return true;
      case 'gcall_kicked':
        cleanup();
        return true;
    }
    return false;
  }

  window.GroupCall = {
    init(c) { cfg = c; build(); },
    handle,
    join,
    leave,
    isInCall: () => inCall,
    // WS再接続時: サーバー側では切断で退室扱いになっているので、こちらも畳む
    onSocketClosed() { if (inCall) cleanup(); },
    requestStatus() { send({ type: 'gcall_status', groupId: cfg.groupId }); },
  };
})();
