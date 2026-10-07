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
    el.className = 'cbg';
    el.innerHTML = '';
    el.style.background = '';
    document.body.classList.remove('chat-bg-on', 'chat-bg-dark');
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
    // 動く層(それぞれ transform のループだけ)
    const n = cfg.type === 'bubbles' ? 9 : cfg.type === 'cosmos' ? 3 : 3;
    for (let i = 0; i < n; i++) {
      const d = document.createElement('i');
      d.className = 'cbg-l cbg-l' + i;
      if (cfg.type === 'bubbles') {
        const size = 40 + Math.round(Math.random() * 140);
        d.style.cssText = `width:${size}px;height:${size}px;left:${Math.round(Math.random() * 90)}%;animation-duration:${14 + Math.random() * 16}s;animation-delay:-${Math.random() * 20}s`;
      }
      el.appendChild(d);
    }
    runForAWhile();
  }

  // 動く背景はずっと動かすとGPUが休めず電池と発熱に響く。開いてから12秒だけ動かして止める。
  // 画面が裏に回ったら即停止。バッテリーセーバー設定がオンなら最初から止める。
  let pauseTimer = null;
  function runForAWhile() {
    if (!layer) return;
    layer.classList.remove('cbg-paused');
    clearTimeout(pauseTimer);
    if (localStorage.getItem('batterySaverAnimations') === '1') { layer.classList.add('cbg-paused'); return; }
    pauseTimer = setTimeout(() => layer && layer.classList.add('cbg-paused'), 12000);
  }
  document.addEventListener('visibilitychange', () => {
    if (!layer) return;
    if (document.hidden) layer.classList.add('cbg-paused'); else runForAWhile();
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
    color.oninput = () => { current = { type: 'color', color: color.value }; render(current); };
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
