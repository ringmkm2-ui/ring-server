// public/js/chatPeek.js
// トーク一覧の行を長押しすると、LINEと同じく「未読のまま」中身を覗けるメニューを出す。
//  - 覗く時は既読にしない(history は markRead=0、グループは /messages だけを読む)
//  - メニュー: スクロールプレビュー / 非表示 / 通知オン・オフ / ピン留め / 既読にする / 削除
// 復号は talklist.html が持っている鍵と関数を使うので、init() で渡してもらう。
// ユーザー由来の文字は必ず textContent で入れる(innerHTML には固定のSVGだけ)。
(function () {
  if (window.ChatPeek) return;

  const LONG_MS = 420;
  const PAGE_DM = 30;
  const HINT_KEY = 'cp_hint_seen';
  const HINT_MAX = 3;

  let O = null;          // init() で受け取る部品
  let cur = null;        // 開いている間の状態
  let toastEl = null, toastTimer = 0;

  const t = (k, fb) => (O && O.t ? O.t(k, fb) : fb);
  const lang = () => (window.i18n && i18n.getLang && i18n.getLang()) || 'ja';
  const reduceMotion = () => document.documentElement.classList.contains('reduce-motion')
    || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---- SVG(固定の文字列だけ。ユーザー入力は入れない) ----
  const ICON = {
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.94 17.94A10.1 10.1 0 0 1 12 19c-6.4 0-10-7-10-7a18.6 18.6 0 0 1 5.06-5.94M9.9 4.24A9.1 9.1 0 0 1 12 5c6.4 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>',
    bellOff: '<path d="M13.73 21a2 2 0 0 1-3.46 0M18.63 13A17.89 17.89 0 0 1 18 8M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M1 1l22 22"/>',
    pin: '<path d="M12 17v5M9 3h6l-1 7 3 3v2H7v-2l3-3-1-7z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    collapse: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.6"/><path d="M21 15l-5-5L5 21"/>',
    video: '<rect x="2" y="5" width="14" height="14" rx="3"/><path d="M16 10l6-3v10l-6-3"/>',
    audio: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    call: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  };
  function svg(name, size, sw) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 20));
    s.setAttribute('height', String(size || 20));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', String(sw || 2));
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICON[name] || '';
    return s;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- 通信 ----
  async function call(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: { Authorization: 'Bearer ' + O.token(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) { const err = new Error((data && data.error) || ('http ' + r.status)); err.code = data && data.code; err.status = r.status; throw err; }
    return data;
  }

  // ---- 日付・時刻 ----
  const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const day0 = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function dayLabel(d) {
    const diff = Math.round((day0(new Date()) - day0(d)) / 86400000);
    if (diff <= 0) return t('cp_today', '今日');
    if (diff === 1) return t('yesterday', '昨日');
    try { return d.toLocaleDateString(lang(), { year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }); }
    catch (e) { return (d.getMonth() + 1) + '/' + d.getDate(); }
  }

  // ---- メッセージ1通を、描画できる形にそろえる ----
  // 戻り値: { id, mine, at: Date, name, kind, text }
  //   kind: text | image | video | audio | file | call | notice | unsent | locked
  async function normalize(raw) {
    const c = cur;
    let r;
    try { r = c.kind === 'dm' ? await O.decryptDm(raw, c.id) : await O.decryptGroup(raw, c.group); }
    catch (e) { r = { kind: 'locked' }; }
    if (!r) r = { kind: 'locked' };
    const sender = c.kind === 'dm' ? raw.senderId : raw.sender_id;
    return {
      id: raw.id,
      mine: String(sender) === String(O.myUserId()),
      at: new Date(c.kind === 'dm' ? raw.createdAt : raw.created_at),
      name: c.kind === 'group' ? (raw.display_name || '') : '',
      kind: r.kind,
      text: r.text || '',
    };
  }

  // ---- 描画 ----
  function bubble(m) {
    const row = el('div', 'cp-row ' + (m.mine ? 'cp-out' : 'cp-in'));
    if (m.kind === 'notice') {
      row.className = 'cp-row cp-center';
      row.appendChild(el('div', 'cp-notice', m.text));
      return row;
    }
    const col = el('div', 'cp-col');
    if (!m.mine && m.name) col.appendChild(el('div', 'cp-who', m.name));
    const line = el('div', 'cp-line');
    const b = el('div', 'cp-bub');
    const icon = { image: 'image', video: 'video', audio: 'audio', file: 'file', call: 'call', locked: 'lock' }[m.kind];
    if (m.kind === 'unsent') {
      b.classList.add('cp-dim');
      b.textContent = t('unsent_preview', '（送信取り消し済み）');
    } else if (m.kind === 'locked') {
      b.classList.add('cp-dim');
      b.appendChild(svg('lock', 15));
      b.appendChild(el('span', null, t('cp_locked', 'この端末では読めません')));
    } else if (icon) {
      b.classList.add('cp-media');
      b.appendChild(svg(icon, 18));
      const label = m.kind === 'call' ? m.text
        : m.kind === 'image' ? t('cp_image', '画像')
        : m.kind === 'video' ? t('cp_video', '動画')
        : m.kind === 'audio' ? t('cp_audio', '音声')
        : t('cp_file', 'ファイル');
      b.appendChild(el('span', null, label));
      if (m.kind !== 'call' && m.text) b.appendChild(el('span', 'cp-cap', m.text));
    } else {
      b.textContent = m.text;
    }
    const tm = el('span', 'cp-time', hhmm(m.at));
    if (m.mine) { line.appendChild(tm); line.appendChild(b); } else { line.appendChild(b); line.appendChild(tm); }
    col.appendChild(line);
    row.appendChild(col);
    return row;
  }

  // 並んだメッセージ(古い順)を日付の区切りつきで入れ物に作る
  function buildFrag(msgs, prevLast, unreadFromId) {
    const frag = document.createDocumentFragment();
    let lastDay = prevLast ? day0(prevLast.at) : null;
    for (const m of msgs) {
      const d = day0(m.at);
      if (d !== lastDay) { const chip = el('div', 'cp-day'); chip.appendChild(el('span', null, dayLabel(m.at))); chip.dataset.day = String(d); frag.appendChild(chip); lastDay = d; }
      if (unreadFromId && m.id === unreadFromId) {
        const u = el('div', 'cp-unread');
        u.appendChild(el('span', null, t('cp_unread_divider', 'ここから未読')));
        u.dataset.unread = '1';
        frag.appendChild(u);
      }
      frag.appendChild(bubble(m));
    }
    return frag;
  }

  // 未読の先頭メッセージ: 相手の発言を後ろから数えて unread 通目
  function unreadStartId(msgs, unread) {
    if (!(unread > 0)) return null;
    let n = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].mine || msgs[i].kind === 'notice') continue;
      if (++n === unread) return msgs[i].id;
    }
    return n > 0 ? (msgs.find(m => !m.mine && m.kind !== 'notice') || {}).id || null : null;
  }

  async function fetchPage(before) {
    const c = cur;
    if (c.kind === 'dm') {
      let url = '/api/messages/history/' + encodeURIComponent(c.id) + '?markRead=0&limit=' + PAGE_DM;
      if (before) url += '&before=' + encodeURIComponent(before);
      const rows = await call('GET', url);
      return { rows: Array.isArray(rows) ? rows : [], more: Array.isArray(rows) && rows.length >= PAGE_DM };
    }
    let url = '/api/groups/' + encodeURIComponent(c.id) + '/messages';
    if (before) url += '?before=' + encodeURIComponent(before);
    const rows = await call('GET', url);
    // サーバーは1回に最大100通。100通返ってきたら、まだ前がある
    return { rows: Array.isArray(rows) ? rows : [], more: Array.isArray(rows) && rows.length >= 100 };
  }
  const createdOf = raw => (cur.kind === 'dm' ? raw.createdAt : raw.created_at);

  async function loadFirst() {
    const c = cur;
    try {
      const { rows, more } = await fetchPage(null);
      if (cur !== c) return;
      const msgs = [];
      for (const raw of rows) { const m = await normalize(raw); if (cur !== c) return; msgs.push(m); }
      c.msgs = msgs; c.more = more;
      c.oldest = rows.length ? createdOf(rows[0]) : null;
      c.scroll.textContent = '';
      if (!msgs.length) {
        c.scroll.appendChild(el('div', 'cp-empty', t('no_messages_yet', 'まだメッセージがありません')));
        return;
      }
      const uid = unreadStartId(msgs, c.unread);
      c.scroll.appendChild(buildFrag(msgs, null, uid));
      const mark = c.scroll.querySelector('[data-unread]');
      if (mark) c.scroll.scrollTop = Math.max(0, mark.offsetTop - 56); else c.scroll.scrollTop = c.scroll.scrollHeight;
    } catch (e) {
      if (cur !== c) return;
      c.scroll.textContent = '';
      c.scroll.appendChild(el('div', 'cp-empty', t('err_generic', 'うまくいきませんでした')));
    }
  }

  async function loadOlder() {
    const c = cur;
    if (!c || c.busy || !c.more || !c.oldest) return;
    c.busy = true;
    try {
      const { rows, more } = await fetchPage(c.oldest);
      if (cur !== c) return;
      c.more = more;
      if (!rows.length) { c.more = false; return; }
      const msgs = [];
      for (const raw of rows) { const m = await normalize(raw); if (cur !== c) return; msgs.push(m); }
      c.oldest = createdOf(rows[0]);
      // いま一番上にある日付の区切りは、新しく足す分の最後の日と同じなら重ねない
      const firstChip = c.scroll.querySelector('.cp-day');
      const before = c.scroll.scrollHeight;
      const frag = buildFrag(msgs, null, null);
      if (firstChip && msgs.length && String(day0(msgs[msgs.length - 1].at)) === firstChip.dataset.day) firstChip.remove();
      c.scroll.insertBefore(frag, c.scroll.firstChild);
      c.scroll.scrollTop += c.scroll.scrollHeight - before;
      c.msgs = msgs.concat(c.msgs);
    } catch (e) { /* 次にスクロールした時にまた試す */ }
    finally { if (cur === c) c.busy = false; }
  }

  // ---- 小さな通知 ----
  function toast(text) {
    if (!toastEl) { toastEl = el('div', 'cp-toast'); toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('on'), 2600);
  }

  // ---- アクション ----
  async function putPref(body) {
    const c = cur;
    try {
      await call('PUT', '/api/chat-prefs', Object.assign({ kind: c.kind, peerId: c.id }, body));
      return true;
    } catch (e) {
      toast(e.code === 'pin_limit' ? t('cp_pin_limit', 'ピン留めは10件までです') : t('err_generic', 'うまくいきませんでした'));
      return false;
    }
  }
  async function act(name) {
    const c = cur;
    if (!c) return;
    if (name === 'scroll') { setExpanded(!c.expanded); return; }
    if (name === 'delete') { showDeleteConfirm(); return; }
    let ok = false, msg = '';
    if (name === 'hide') { ok = await putPref({ hidden: true }); msg = t('cp_hidden_toast', '非表示にしました。新しいメッセージが届くと表示されます。'); }
    else if (name === 'mute') { ok = await putPref({ muted: !c.muted }); }
    else if (name === 'pin') { ok = await putPref({ pinned: !c.pinned }); }
    else if (name === 'read') {
      try {
        await call('POST', c.kind === 'dm' ? '/api/messages/read/' + encodeURIComponent(c.id) : '/api/groups/' + encodeURIComponent(c.id) + '/read-all');
        ok = true;
      } catch (e) { toast(t('err_generic', 'うまくいきませんでした')); }
    }
    if (!ok) return;
    close();
    if (msg) toast(msg);
    if (O.refresh) O.refresh();
  }
  function showDeleteConfirm() {
    const c = cur;
    c.menu.textContent = '';
    const box = el('div', 'cp-confirm');
    box.appendChild(el('div', 'cp-ct', t('cp_delete_title', 'このトークを削除しますか？')));
    box.appendChild(el('div', 'cp-cb', t('cp_delete_body', 'あなたのトーク履歴が消えます。相手の画面には影響しません。')));
    const row = el('div', 'cp-crow');
    const no = el('button', 'cp-cbtn', t('cp_cancel', 'キャンセル')); no.type = 'button';
    const yes = el('button', 'cp-cbtn cp-danger', t('cp_delete', '削除')); yes.type = 'button';
    no.addEventListener('click', () => { if (cur === c) renderMenu(); });
    yes.addEventListener('click', async () => {
      yes.disabled = no.disabled = true;
      try {
        await call('POST', '/api/chat-prefs/clear', { kind: c.kind, peerId: c.id });
        close();
        if (O.refresh) O.refresh();
      } catch (e) { toast(t('err_generic', 'うまくいきませんでした')); yes.disabled = no.disabled = false; }
    });
    row.appendChild(no); row.appendChild(yes);
    box.appendChild(row);
    c.menu.appendChild(box);
  }

  // ---- メニュー ----
  function renderMenu() {
    const c = cur;
    c.menu.textContent = '';
    const items = [
      { k: 'scroll', icon: 'eye', label: t('cp_scroll_preview', 'スクロールプレビュー') },
      { k: 'hide', icon: 'eyeOff', label: t('cp_hide', '非表示') },
      { k: 'mute', icon: c.muted ? 'bell' : 'bellOff', label: c.muted ? t('cp_mute_on', '通知オン') : t('cp_mute_off', '通知オフ') },
      { k: 'pin', icon: 'pin', label: c.pinned ? t('cp_unpin', 'ピン留めを外す') : t('cp_pin', 'ピン留め') },
    ];
    if (c.unread > 0) items.push({ k: 'read', icon: 'check', label: t('cp_mark_read', '既読にする') });
    items.push({ k: 'delete', icon: 'trash', label: t('cp_delete', '削除'), danger: true });
    for (const it of items) {
      const b = el('button', 'cp-item' + (it.danger ? ' cp-danger' : ''));
      b.type = 'button';
      b.appendChild(el('span', null, it.label));
      b.appendChild(svg(it.icon, 20));
      b.addEventListener('click', () => act(it.k));
      c.menu.appendChild(b);
    }
  }

  function setExpanded(on) {
    const c = cur;
    c.expanded = !!on;
    c.ov.classList.toggle('cp-expanded', c.expanded);
    c.toggle.textContent = '';
    c.toggle.appendChild(svg(c.expanded ? 'collapse' : 'expand', 20));
    c.toggle.setAttribute('aria-label', c.expanded ? t('cp_collapse', '小さくする') : t('cp_scroll_preview', 'スクロールプレビュー'));
  }

  // ---- 開く/閉じる ----
  function open(ctx) {
    if (cur || !O) return;
    const c = cur = Object.assign({ msgs: [], more: true, oldest: null, busy: false, expanded: false, openedAt: Date.now() }, ctx);

    const ov = el('div', 'cp-ov'); c.ov = ov;
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    const dim = el('div', 'cp-dim'); ov.appendChild(dim);
    const stack = el('div', 'cp-stack'); ov.appendChild(stack);

    const card = el('div', 'cp-card');
    const head = el('div', 'cp-head');
    const av = el('div', 'cp-av');
    if (O.setAvatar) O.setAvatar(av, c.pic, (c.name || '?').charAt(0)); else av.textContent = (c.name || '?').charAt(0);
    head.appendChild(av);
    head.appendChild(el('div', 'cp-name', c.name || ''));
    const toggle = el('button', 'cp-icobtn'); toggle.type = 'button'; c.toggle = toggle;
    toggle.addEventListener('click', () => setExpanded(!c.expanded));
    head.appendChild(toggle);
    const closeBtn = el('button', 'cp-icobtn cp-closebtn'); closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', t('cp_close', '閉じる'));
    closeBtn.appendChild(svg('x', 20));
    closeBtn.addEventListener('click', () => history.back());
    head.appendChild(closeBtn);
    card.appendChild(head);

    const scroll = el('div', 'cp-scroll'); c.scroll = scroll;
    for (let i = 0; i < 4; i++) { const s = el('div', 'cp-skel ' + (i % 2 ? 'cp-out' : 'cp-in')); s.appendChild(el('i')); scroll.appendChild(s); }
    scroll.addEventListener('scroll', () => { if (scroll.scrollTop < 90) loadOlder(); }, { passive: true });
    card.appendChild(scroll);
    stack.appendChild(card);

    // 初めの数回だけ出す説明(×で消すとそれ以降出さない)
    let seen = 0;
    try { seen = Number(localStorage.getItem(HINT_KEY)) || 0; } catch (e) {}
    if (seen < HINT_MAX) {
      const hint = el('div', 'cp-hint');
      hint.appendChild(el('span', 'cp-tag', 'CHECK'));
      hint.appendChild(el('span', 'cp-ht', t('cp_hint', '未読のまま過去のトークを確認可能')));
      const x = el('button', 'cp-hx'); x.type = 'button'; x.setAttribute('aria-label', t('cp_close', '閉じる'));
      x.appendChild(svg('x', 16));
      x.addEventListener('click', () => { try { localStorage.setItem(HINT_KEY, String(HINT_MAX)); } catch (e) {} hint.remove(); });
      hint.appendChild(x);
      stack.appendChild(hint);
      try { localStorage.setItem(HINT_KEY, String(seen + 1)); } catch (e) {}
    }

    const menu = el('div', 'cp-menu'); c.menu = menu;
    stack.appendChild(menu);

    dim.addEventListener('click', () => { if (Date.now() - c.openedAt > 350) history.back(); });
    ov.addEventListener('contextmenu', e => e.preventDefault());

    document.body.appendChild(ov);
    setExpanded(false);
    renderMenu();
    try { history.pushState({ cp: 1 }, ''); } catch (e) {}
    requestAnimationFrame(() => ov.classList.add('on'));
    loadFirst();
  }

  function close() {
    const c = cur;
    if (!c) return;
    cur = null;
    const ov = c.ov;
    ov.classList.remove('on');
    const done = () => { if (ov.parentNode) ov.remove(); };
    if (reduceMotion()) done(); else setTimeout(done, 180);
    // 自分で閉じた時は、積んだ履歴を1つ戻す(戻るボタンで閉じた時は、もう戻っている)
    try { if (history.state && history.state.cp) history.back(); } catch (e) {}
  }
  window.addEventListener('popstate', () => { if (cur) close(); });

  // ---- 長押し ----
  function bind(item, getCtx) {
    let timer = 0, sx = 0, sy = 0, fired = false, firedAt = 0;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    const fire = () => {
      fired = true; firedAt = Date.now();
      try { if (navigator.vibrate && localStorage.getItem('haptics') !== '0') navigator.vibrate(12); } catch (e) {}
      open(getCtx());
      // 指を離した時の click が来なかった時のために戻しておく
      setTimeout(() => { fired = false; }, 700);
    };
    item.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') return;   // PCは右クリック(contextmenu)で開く
      cancel(); fired = false; sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => { timer = 0; fire(); }, LONG_MS);
    }, { passive: true });
    item.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 9) cancel(); }, { passive: true });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(n => item.addEventListener(n, cancel, { passive: true }));
    item.addEventListener('contextmenu', e => { e.preventDefault(); cancel(); if (!fired && !cur) fire(); });
    // 長押しで開いた後の「指を離した時のクリック」で、トークを開いてしまわないようにする
    item.addEventListener('click', e => {
      if (fired && Date.now() - firedAt < 900) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; }
    });
  }

  window.ChatPeek = {
    // O: { token(), myUserId(), t(k, fb), decryptDm(raw, peerId), decryptGroup(raw, group), setAvatar(el, pic, initial), refresh() }
    init(opts) { O = opts; },
    bind,
    icon: svg,
    isOpen: () => !!cur,
    close() { if (cur) history.back(); },
    toast,
  };
})();
