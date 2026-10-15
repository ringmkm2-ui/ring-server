// chatBg.js — iOS 26 メッセージAppの「背景」を再現。トークごとに背景を選べる。
//   なし / 写真 / カラー(好きな色のグラデーション) / 動く背景(オーロラ・宇宙・泡・水面・夕焼け)
//   動く背景は transform だけのアニメーション(再描画を起こさない)なので軽い。
//   設定はこの端末だけに保存(トーク単位)。
(function () {
  const me = localStorage.getItem('ring_userId') || '';
  const params = new URLSearchParams(location.search);
  const other = params.get('userId') || params.get('id') || params.get('callerId') || '';
  if (!other) return;
  const KEY = `chat_bg_${me}_${other}`;

  const PRESETS = [
    { id: 'none', label: 'なし' },
    { id: 'photo', label: '写真' },
    { id: 'color', label: 'カラー' },
    { id: 'aurora', label: 'オーロラ', dark: true },
    { id: 'cosmos', label: '宇宙', dark: true },
    { id: 'bubbles', label: 'バブル', dark: true },
    { id: 'water', label: '水面' },
    { id: 'sunset', label: '夕焼け' },
  ];

  // ---------- 描画 ----------
  let layer = null;
  function ensureLayer() {
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'chatBg';
    layer.className = 'cbg';
    const pc = document.querySelector('.phone-container');
    (pc || document.body).insertBefore(layer, (pc || document.body).firstChild);
    return layer;
  }

  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  }

  function render(cfg) {
    const el = ensureLayer();
    anim = null; moving = false; if (raf) { cancelAnimationFrame(raf); raf = 0; }
    el.className = 'cbg';
    el.innerHTML = '';
    el.style.background = '';
    document.body.classList.remove('chat-bg-on', 'chat-bg-dark', 'cbg-moving');
    clearTimeout(pauseTimer);
    if (!cfg || cfg.type === 'none') return;
    document.body.classList.add('chat-bg-on');
    const preset = PRESETS.find(p => p.id === cfg.type);
    if (preset && preset.dark) document.body.classList.add('chat-bg-dark');

    if (cfg.type === 'photo' && cfg.data) {
      el.style.background = `center/cover no-repeat url(${cfg.data})`;
      if (cfg.mono) el.style.filter = 'grayscale(1)'; else el.style.filter = '';
      return;
    }
    el.style.filter = '';
    if (cfg.type === 'color') {
      const [h, s, l] = hexToHsl(cfg.color || '#5b8cff');
      el.style.background = `radial-gradient(120% 80% at 20% 10%, hsl(${(h + 330) % 360} ${s}% ${Math.min(l + 18, 88)}%) 0%, transparent 60%),
        radial-gradient(120% 90% at 90% 90%, hsl(${(h + 30) % 360} ${s}% ${Math.max(l - 12, 18)}%) 0%, transparent 65%),
        hsl(${h} ${s}% ${l}%)`;
      if (l < 45) document.body.classList.add('chat-bg-dark');
      return;
    }
    el.classList.add('cbg-' + cfg.type);
    // 動く部分は小さいキャンバス1枚に描いて引き伸ばす(ぼやけた光なので低い解像度でも見た目は同じ)。
    // 以前は画面の何倍もあるCSSの層を3〜9枚重ねて動かしていて、上のすりガラスと合わせて
    // 背景を選ぶとカクカクになった
    if (cfg.type === 'cosmos') { const st = document.createElement('i'); st.className = 'cbg-stars'; el.appendChild(st); }
    const cv = document.createElement('canvas');
    cv.className = 'cbg-cv';
    el.appendChild(cv);
    anim = { type: cfg.type, cv, ctx: cv.getContext('2d'), t0: performance.now(), seeds: Array.from({ length: 9 }, () => [Math.random(), Math.random(), Math.random()]) };
    sizeCanvas();
    drawFrame(performance.now());
    runForAWhile();
  }

  // ---------- 動く背景(キャンバス) ----------
  const SCALE = 0.25;      // 画面の1/4の解像度で描く
  const FPS = 30;
  let anim = null, raf = 0, lastDraw = 0;
  function sizeCanvas() {
    if (!anim || !layer) return;
    const w = Math.max(1, Math.round((layer.clientWidth || innerWidth) * SCALE));
    const h = Math.max(1, Math.round((layer.clientHeight || innerHeight) * SCALE));
    if (anim.cv.width !== w || anim.cv.height !== h) { anim.cv.width = w; anim.cv.height = h; }
  }
  addEventListener('resize', () => { if (anim) { sizeCanvas(); drawFrame(performance.now()); } });
  const osc = (t, period, phase) => Math.sin((t / period + (phase || 0)) * Math.PI * 2);
  function blob(c, x, y, rx, ry, color, rot) {
    c.save();
    c.translate(x, y); if (rot) c.rotate(rot); c.scale(1, ry / rx);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, color); g.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, rx, 0, Math.PI * 2); c.fill();
    c.restore();
  }
  function drawFrame(now) {
    if (!anim) return;
    const c = anim.ctx, W = anim.cv.width, H = anim.cv.height, t = (now - anim.t0) / 1000;
    c.clearRect(0, 0, W, H);
    const m = Math.max(W, H);
    switch (anim.type) {
      case 'aurora':
        blob(c, W * (.5 + .08 * osc(t, 22)), H * .35, W * .9, H * .25, 'rgba(63,240,200,.6)', .1 * osc(t, 22));
        blob(c, W * (.45 - .08 * osc(t, 30, .3)), H * .55, W * .9, H * .22, 'rgba(56,189,248,.5)', -.1 * osc(t, 30, .3));
        blob(c, W * (.55 + .08 * osc(t, 38, .6)), H * .72, W * .85, H * .2, 'rgba(168,85,247,.35)', .1 * osc(t, 38, .6));
        break;
      case 'cosmos': {
        const a1 = t / 60 * Math.PI * 2, a2 = -t / 90 * Math.PI * 2;
        blob(c, W / 2 + Math.cos(a1) * m * .25, H / 2 + Math.sin(a1) * m * .25, m * .45, m * .45, 'rgba(139,92,246,.5)');
        blob(c, W / 2 + Math.cos(a2 + 2) * m * .22, H / 2 + Math.sin(a2 + 2) * m * .22, m * .4, m * .4, 'rgba(236,72,153,.35)');
        break;
      }
      case 'bubbles':
        anim.seeds.forEach(([a, b, d]) => {
          const r = (10 + 35 * a) * (W / 100);
          const dur = 14 + 16 * b, p = ((t / dur) + d) % 1;
          const x = W * (.05 + .9 * d) + Math.sin(p * Math.PI * 2) * W * .04;
          const y = H + r - p * (H + r * 2);
          const g = c.createRadialGradient(x - r * .35, y - r * .4, 0, x, y, r);
          g.addColorStop(0, 'rgba(255,255,255,.5)'); g.addColorStop(.45, 'rgba(125,211,252,.18)'); g.addColorStop(1, 'rgba(125,211,252,.06)');
          c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
          c.strokeStyle = 'rgba(255,255,255,.25)'; c.lineWidth = Math.max(.5, W / 300); c.stroke();
        });
        break;
      case 'water':
        [[.30, 9, 'rgba(255,255,255,.18)'], [.48, 13, 'rgba(255,255,255,.12)'], [.66, 17, 'rgba(2,132,199,.25)']].forEach(([y0, per, col], i) => {
          c.save();
          c.translate(W / 2 + W * .06 * osc(t, per * 2, i * .3), H * (y0 + .2) - H * .02 * osc(t, per * 2, i * .3));
          c.rotate(.05 * osc(t, per * 2, i * .3));
          c.fillStyle = col; c.beginPath(); c.ellipse(0, 0, W, H * .2, 0, 0, Math.PI * 2); c.fill();
          c.restore();
        });
        break;
      case 'sunset':
        blob(c, W * (.5 + .08 * osc(t, 32)), H * .1, W * .7, H * .3, 'rgba(255,255,255,.45)');
        blob(c, W * (.5 - .08 * osc(t, 42, .3)), H * .75, W * .7, H * .3, 'rgba(236,72,153,.35)');
        break;
    }
  }
  function loop(now) {
    raf = 0;
    if (!anim || !moving) return;
    if (now - lastDraw >= 1000 / FPS - 2) { lastDraw = now; drawFrame(now); }
    raf = requestAnimationFrame(loop);
  }

  // 動く背景はずっと動かすとGPUが休めず電池と発熱に響く。開いてから12秒だけ動かして止める。
  // 画面が裏に回ったら即停止。バッテリーセーバー設定がオンなら最初から止める。
  let pauseTimer = null, moving = false;
  function pause() {
    clearTimeout(pauseTimer);
    moving = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    document.body.classList.remove('cbg-moving');
  }
  function runForAWhile() {
    if (!layer) return;
    clearTimeout(pauseTimer);
    if (!anim || localStorage.getItem('batterySaverAnimations') === '1' ||
        (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) { pause(); return; }
    moving = true;
    document.body.classList.add('cbg-moving');
    if (!raf) raf = requestAnimationFrame(loop);
    pauseTimer = setTimeout(pause, 12000);
  }
  document.addEventListener('visibilitychange', () => {
    if (!layer) return;
    if (document.hidden) pause(); else runForAWhile();
  });

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save(cfg) {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); }
    catch (e) { alert('背景画像が大きすぎて保存できませんでした'); }
  }

  // ---------- 選択シート ----------
  let sheet = null, current = load() || { type: 'none' }, before = null;
  function thumbStyle(id) {
    const m = {
      none: 'background:rgba(255,255,255,.5)',
      photo: 'background:linear-gradient(135deg,#94a3b8,#cbd5e1)',
      color: 'background:conic-gradient(from 0deg,#ff5f6d,#ffc371,#47e891,#3fa9f5,#b36bff,#ff5f6d)',
      aurora: 'background:linear-gradient(160deg,#021b2e,#0b6b6b 55%,#3ff0c8)',
      cosmos: 'background:radial-gradient(circle at 30% 30%,#6d28d9,#0b0620 70%)',
      bubbles: 'background:radial-gradient(circle at 70% 30%,#38bdf8,#0c1a3a 70%)',
      water: 'background:linear-gradient(180deg,#a5f3fc,#0ea5e9)',
      sunset: 'background:linear-gradient(180deg,#fb7185,#f59e0b)',
    };
    return m[id];
  }
  const ICON = {
    none: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/></svg>',
    photo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>',
  };

  function openSheet() {
    before = JSON.parse(JSON.stringify(current));
    if (!sheet) buildSheet();
    sheet.querySelectorAll('.cbs-item').forEach(b => b.classList.toggle('sel', b.dataset.id === current.type));
    sheet.querySelector('.cbs-color').value = current.color || '#5b8cff';
    sheet.querySelector('.cbs-mono').checked = !!current.mono;
    sheet.querySelector('.cbs-photo-opts').style.display = current.type === 'photo' ? 'flex' : 'none';
    sheet.classList.add('show');
    document.getElementById('cbsScrim').classList.add('show');
  }
  function closeSheet(commit) {
    if (!sheet) return;
    if (commit) save(current); else { current = before; render(current); }
    sheet.classList.remove('show');
    document.getElementById('cbsScrim').classList.remove('show');
  }

  function downscale(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const max = 1280, k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.8));
        URL.revokeObjectURL(img.src);
      };
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }

  function buildSheet() {
    const scrim = document.createElement('div');
    scrim.id = 'cbsScrim'; scrim.className = 'cbs-scrim';
    scrim.onclick = () => closeSheet(false);
    sheet = document.createElement('div');
    sheet.className = 'cbs';
    sheet.innerHTML = `
      <div class="cbs-grab"></div>
      <div class="cbs-head"><button class="cbs-cancel" type="button">キャンセル</button><div class="cbs-title">背景</div><button class="cbs-done" type="button">完了</button></div>
      <div class="cbs-grid">${PRESETS.map(p => `
        <button class="cbs-item" type="button" data-id="${p.id}">
          <span class="cbs-thumb" style="${thumbStyle(p.id)}">${ICON[p.id] || ''}</span>
          <span class="cbs-label">${p.label}</span>
        </button>`).join('')}
      </div>
      <div class="cbs-photo-opts"><label><input type="checkbox" class="cbs-mono"> モノクロ</label><button type="button" class="cbs-rephoto">写真を選び直す</button></div>
      <input type="color" class="cbs-color" hidden>
      <input type="file" class="cbs-file" accept="image/*" hidden>`;
    document.body.append(scrim, sheet);

    const file = sheet.querySelector('.cbs-file');
    const color = sheet.querySelector('.cbs-color');
    sheet.querySelector('.cbs-cancel').onclick = () => closeSheet(false);
    sheet.querySelector('.cbs-done').onclick = () => closeSheet(true);
    sheet.querySelector('.cbs-rephoto').onclick = () => file.click();
    sheet.querySelector('.cbs-mono').onchange = e => { current.mono = e.target.checked; render(current); };
    file.onchange = async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      try {
        current = { type: 'photo', data: await downscale(f), mono: false };
        render(current); select('photo');
      } catch (e) { alert('画像を読み込めませんでした'); }
    };
    // 色を選んでいる間は1コマに1回だけ描き直す(ドラッグ中に毎イベント全画面を描き直してカクついていた)
    let colorRaf = 0;
    color.oninput = () => {
      if (colorRaf) return;
      colorRaf = requestAnimationFrame(() => { colorRaf = 0; current = { type: 'color', color: color.value }; render(current); });
    };
    function select(id) {
      sheet.querySelectorAll('.cbs-item').forEach(b => b.classList.toggle('sel', b.dataset.id === id));
      sheet.querySelector('.cbs-photo-opts').style.display = id === 'photo' ? 'flex' : 'none';
    }
    sheet.querySelectorAll('.cbs-item').forEach(b => b.onclick = () => {
      const id = b.dataset.id;
      if (id === 'photo') { if (current.type === 'photo' && current.data) select('photo'); else file.click(); return; }
      if (id === 'color') { current = { type: 'color', color: color.value || '#5b8cff' }; render(current); select(id); color.click(); return; }
      current = { type: id }; render(current); select(id);
    });
  }

  window.ChatBackground = { open: openSheet };

  function init() {
    render(current);
    // iOS 26 と同じく、上の相手の名前/アイコンをタップすると背景を選べる
    // (相手メニュー chatBlock.js がある画面では、そのメニューの「背景を変更」から開く)
    ['partnerName', 'partnerAv'].forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.dataset.peerMenu) { el.style.cursor = 'pointer'; el.addEventListener('click', openSheet); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
