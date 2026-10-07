// 1対1トーク: 相手の名前/アイコンを押すと出るメニュー(ブロック・通報)と「ブロック中」バー。
// ブロックすると相手からのトーク・着信・入力中・オンライン表示が全部届かなくなる(サーバー側で止める)。
// 相手には何も知らされない。
(function () {
  if (typeof otherId === 'undefined' || !otherId) return;
  const $ = id => document.getElementById(id);
  const T = (k, fb) => (window.i18n && i18n.t ? i18n.t(k, fb) : fb);
  const NS = 'http://www.w3.org/2000/svg';
  let blocked = false;

  async function call(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || T('err_generic', 'うまくいきませんでした'));
    return data;
  }
  const peerName = () => (($('partnerName') && $('partnerName').textContent) || '').trim() || (typeof partnerName !== 'undefined' ? partnerName : '');

  function svg(paths, color) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', '20'); s.setAttribute('height', '20'); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', color || 'currentColor');
    s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = paths;
    return s;
  }
  const ICON_BLOCK = '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>';
  const ICON_UNBLOCK = '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.6L16 9.5"/>';
  const ICON_FLAG = '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>';
  const ICON_BG = '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>';

  function applyBlocked(v) {
    blocked = !!v;
    document.body.classList.toggle('peer-blocked', blocked);
    const lb = $('blockedLabel');
    if (lb) lb.textContent = T('blocked_label', '{name}をブロック中').replace('{name}', peerName());
  }
  window.BroBlock = { applyBlocked, isBlocked: () => blocked };

  // ---- メニュー ----
  const bg = document.createElement('div'); bg.className = 'peer-sheet-bg';
  const sheet = document.createElement('div'); sheet.className = 'peer-sheet'; sheet.setAttribute('role', 'dialog');
  document.body.append(bg, sheet);
  function close() { bg.classList.remove('open'); sheet.classList.remove('open'); }
  bg.addEventListener('click', close);

  function head(card) {
    const h = document.createElement('div'); h.className = 'peer-head';
    const av = document.createElement('div');
    av.style.cssText = 'width:36px;height:36px;border-radius:50%;flex-shrink:0;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700';
    const src = $('partnerAv');
    if (window._partnerAvatar) av.style.backgroundImage = 'url(' + JSON.stringify(window._partnerAvatar) + ')';
    else { av.style.background = (src && src.style.background) || '#94a3b8'; av.textContent = peerName().charAt(0); }
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = peerName();
    h.append(av, nm); card.appendChild(h);
  }
  function row(card, icon, label, cls, fn) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'peer-row' + (cls ? ' ' + cls : '');
    b.append(svg(icon), document.createTextNode(label));
    b.addEventListener('click', fn); card.appendChild(b); return b;
  }
  function frame(build) {
    sheet.textContent = '';
    const card = document.createElement('div'); card.className = 'peer-card';
    head(card); build(card);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'peer-cancel';
    cancel.textContent = T('cancel', 'キャンセル'); cancel.addEventListener('click', close);
    sheet.append(card, cancel);
    requestAnimationFrame(() => { bg.classList.add('open'); sheet.classList.add('open'); });
  }

  function openMenu() {
    frame(card => {
      if (window.ChatBackground) row(card, ICON_BG, T('chat_background', 'トーク背景を変更'), '', () => { close(); setTimeout(() => window.ChatBackground.open(), 180); });
      if (blocked) {
        row(card, ICON_UNBLOCK, T('unblock', 'ブロックを解除'), '', () => doUnblock().then(close));
      } else {
        row(card, ICON_BLOCK, T('block', 'ブロック'), 'danger', openBlockConfirm);
      }
      row(card, ICON_FLAG, T('report_user_short', '通報する'), 'danger', openReport);
    });
  }

  function openBlockConfirm() {
    frame(card => {
      const p = document.createElement('div'); p.className = 'peer-sub'; p.style.paddingTop = '12px';
      p.textContent = T('block_desc', 'ブロックすると、この人からのメッセージ・通話が届かなくなります。相手には知らされません。あとから解除できます。');
      card.appendChild(p);
      row(card, ICON_BLOCK, T('block_confirm', 'ブロックする'), 'danger', async () => {
        try { await call('/api/friends/block', { userId: otherId }); applyBlocked(true); close(); }
        catch (e) { alert(e.message); }
      });
    });
  }

  async function doUnblock() {
    try { await call('/api/friends/unblock', { userId: otherId }); applyBlocked(false); }
    catch (e) { alert(e.message); }
  }

  function openReport() {
    frame(card => {
      const f = document.createElement('div'); f.className = 'peer-form';
      const sel = document.createElement('select');
      [['harassment', '嫌がらせ・脅し'], ['spam', 'スパム・迷惑行為'], ['impersonation', 'なりすまし'], ['inappropriate', '不適切な内容'], ['other', 'その他']]
        .forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = T('report_' + v, l); sel.appendChild(o); });
      const ta = document.createElement('textarea'); ta.maxLength = 2000;
      ta.placeholder = T('report_user_desc', '状況を教えてください');
      const lab = document.createElement('label'); lab.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px';
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !blocked;
      lab.append(chk, document.createTextNode(T('report_and_block', 'ブロックもする')));
      if (blocked) lab.style.display = 'none';
      const err = document.createElement('div'); err.className = 'err';
      const send = document.createElement('button'); send.type = 'button'; send.className = 'send'; send.textContent = T('report_send', '通報を送る');
      send.addEventListener('click', async () => {
        err.textContent = '';
        const message = ta.value.trim();
        if (message.length < 5) { err.textContent = T('report_need_msg', '内容を5文字以上で書いてください'); return; }
        send.disabled = true;
        try {
          const ver = (document.querySelector('.version-badge') || {}).textContent || '';
          await call('/api/reports', { kind: 'user', targetUserId: otherId, category: sel.value, message, appVersion: ver.replace(/^Bro Chat\s*/, '').trim() });
          if (chk.checked && !blocked) { await call('/api/friends/block', { userId: otherId }); applyBlocked(true); }
          close();
          alert(T('report_thanks_user', '通報を送りました。確認します'));
        } catch (e) { err.textContent = e.message; send.disabled = false; }
      });
      f.append(sel, ta, lab, err, send);
      card.appendChild(f);
      setTimeout(() => ta.focus(), 300);
    });
  }

  ['partnerAv', 'partnerName'].forEach(id => { const el = $(id); if (el) { el.dataset.peerMenu = '1'; el.addEventListener('click', openMenu); } });
  const ub = $('unblockBtn'); if (ub) ub.addEventListener('click', doUnblock);

  // 開いた時点のブロック状態
  call('/api/friends/block-status/' + encodeURIComponent(otherId)).then(d => applyBlocked(d.blocked)).catch(() => {});
})();
