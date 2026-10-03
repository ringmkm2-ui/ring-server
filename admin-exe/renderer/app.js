(() => {
  const $ = id => document.getElementById(id);
  let cfg = { url: '', key: '' };
  let timer = null, searchTimer = null;

  const ICON = {
    logout: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2z"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
    unlock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
    key: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2"/><path d="M17 6l3 3"/></svg>'
  };

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function call(method, path, body) {
    const r = await window.admin.api({ url: cfg.url, key: cfg.key, method, path, body });
    if (r.error) throw new Error(r.error);
    if (r.status === 401) throw new Error('管理キーが違います');
    if (r.status === 404 && path === '/api/admin/stats') throw new Error('サーバー側で管理APIが有効になっていません(ADMIN_API_KEY未設定、または未デプロイ)');
    if (r.status === 429) throw new Error('試行が多すぎます。しばらく待ってください');
    if (r.status >= 400) throw new Error((r.data && r.data.error) || ('エラー ' + r.status));
    return r.data;
  }

  function fmtUptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? d + '日' + h + '時間' : h ? h + '時間' + m + '分' : m + '分';
  }

  function renderStats(s) {
    $('ver').textContent = 'サーバー v' + s.version;
    const items = [
      ['ユーザー', s.users], ['オンライン', s.online], ['個人メッセージ', s.messages],
      ['グループメッセージ', s.groupMessages], ['グループ', s.groups], ['投稿', s.posts],
      ['ログイン中の端末', s.activeSessions], ['メモリ', s.memoryMB + ' MB'], ['稼働時間', fmtUptime(s.uptimeSec)]
    ];
    const box = $('stats');
    box.textContent = '';
    items.forEach(([label, v]) => {
      const d = document.createElement('div'); d.className = 'stat';
      const b = document.createElement('b'); b.textContent = v == null ? '-' : v;
      const sp = document.createElement('span'); sp.textContent = label;
      d.append(b, sp); box.appendChild(d);
    });
  }

  function actBtn(icon, title, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.title = title; b.innerHTML = icon;
    b.onclick = fn;
    return b;
  }

  function renderUsers(list) {
    $('count').textContent = list.length + ' 件';
    const tb = $('rows');
    tb.textContent = '';
    list.forEach(u => {
      const tr = document.createElement('tr');
      const c0 = document.createElement('td'); const dot = document.createElement('span');
      dot.className = 'dot' + (u.online ? ' on' : ''); dot.title = u.online ? 'オンライン' : 'オフライン'; c0.appendChild(dot);
      const c1 = document.createElement('td'); c1.textContent = u.displayName || '';
      const c2 = document.createElement('td'); c2.textContent = u.username;
      const c3 = document.createElement('td'); c3.textContent = u.createdAt ? new Date(u.createdAt).toLocaleDateString('ja-JP') : '';
      const c4 = document.createElement('td');
      if (u.locked) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'ロック中'; c4.appendChild(t); }
      const c5 = document.createElement('td'); c5.className = 'r';
      const act = document.createElement('div'); act.className = 'act';
      act.append(
        actBtn(ICON.logout, '全端末からログアウトさせる', () => forceLogout(u)),
        actBtn(ICON.unlock, 'ログインロックを解除', () => unlock(u)),
        actBtn(ICON.key, 'パスワードを再設定', () => openPw(u))
      );
      c5.appendChild(act);
      tr.append(c0, c1, c2, c3, c4, c5);
      tb.appendChild(tr);
    });
  }

  async function loadStats() { renderStats(await call('GET', '/api/admin/stats')); }
  async function loadUsers() {
    const q = $('search').value.trim();
    const r = await call('GET', '/api/admin/users?q=' + encodeURIComponent(q));
    renderUsers(r.users || []);
  }
  const CAT = { spam: 'スパム・迷惑行為', harassment: '嫌がらせ・脅し', impersonation: 'なりすまし', inappropriate: '不適切な内容', other: 'その他' };

  function renderReports(list) {
    $('repCount').textContent = list.length + ' 件';
    const box = $('repList');
    box.textContent = '';
    list.forEach(r => {
      const card = document.createElement('div');
      card.className = 'rep' + (r.status === 'resolved' ? ' done' : '');
      const top = document.createElement('div'); top.className = 'top';
      const kind = document.createElement('span'); kind.className = 'kind' + (r.kind === 'user' ? ' user' : '');
      kind.textContent = r.kind === 'user' ? '通報' : 'バグ';
      top.appendChild(kind);
      if (r.category) { const c = document.createElement('span'); c.textContent = CAT[r.category] || r.category; top.appendChild(c); }
      const t = document.createElement('span'); t.textContent = r.createdAt ? new Date(String(r.createdAt).replace(' ', 'T') + (String(r.createdAt).includes('Z') || String(r.createdAt).includes('+') ? '' : 'Z')).toLocaleString('ja-JP') : '';
      top.appendChild(t);
      if (r.appVersion) { const v = document.createElement('span'); v.textContent = 'v' + r.appVersion; top.appendChild(v); }
      const msg = document.createElement('div'); msg.className = 'msg'; msg.textContent = r.message;
      const who = document.createElement('div'); who.className = 'who';
      const nm = x => x ? ((x.displayName || '') + ' <' + (x.username || '') + '>') : '(削除済み)';
      who.textContent = '報告者: ' + nm(r.reporter) + (r.target ? '  /  対象: ' + nm(r.target) : '');
      const foot = document.createElement('div'); foot.className = 'foot';
      const done = r.status === 'resolved';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn';
      b.textContent = done ? '未対応に戻す' : '対応済みにする';
      b.onclick = async () => {
        try { await call('POST', '/api/admin/reports/' + encodeURIComponent(r.id) + '/status', { status: done ? 'open' : 'resolved' }); await loadReports(); }
        catch (e) { toast(e.message); }
      };
      foot.appendChild(b);
      card.append(top, msg, who, foot);
      box.appendChild(card);
    });
    if (!list.length) { const e = document.createElement('div'); e.className = 'count'; e.style.padding = '12px 2px'; e.textContent = '報告はありません'; box.appendChild(e); }
  }

  async function loadReports() {
    const r = await call('GET', '/api/admin/reports?status=' + encodeURIComponent($('repFilter').value));
    renderReports(r.reports || []);
    refreshBadge().catch(() => {});
  }
  async function refreshBadge() {
    const r = await call('GET', '/api/admin/reports?status=open');
    const n = (r.reports || []).length;
    $('repBadge').textContent = n > 99 ? '99+' : n;
    $('repBadge').hidden = n === 0;
  }

  function showTab(name) {
    const reports = name === 'reports';
    $('usersPane').hidden = reports; $('reportsPane').hidden = !reports;
    $('tabUsers').classList.toggle('active', !reports); $('tabReports').classList.toggle('active', reports);
    if (reports) loadReports().catch(e => toast(e.message));
  }
  $('tabUsers').onclick = () => showTab('users');
  $('tabReports').onclick = () => showTab('reports');
  $('repFilter').onchange = () => loadReports().catch(e => toast(e.message));

  async function reload() {
    try {
      await Promise.all([loadStats(), loadUsers(), refreshBadge()]);
      if (!$('reportsPane').hidden) await loadReports();
    } catch (e) { toast(e.message); }
  }

  async function forceLogout(u) {
    if (!confirm((u.displayName || u.username) + ' を全端末からログアウトさせます。よろしいですか?')) return;
    try { await call('POST', '/api/admin/users/' + encodeURIComponent(u.id) + '/logout'); toast('ログアウトさせました'); loadStats().catch(() => {}); }
    catch (e) { toast(e.message); }
  }
  async function unlock(u) {
    try { await call('POST', '/api/admin/users/' + encodeURIComponent(u.id) + '/unlock'); toast('ロックを解除しました'); loadUsers().catch(() => {}); }
    catch (e) { toast(e.message); }
  }

  let pwUser = null;
  function openPw(u) {
    pwUser = u;
    $('pwTitle').textContent = (u.displayName || u.username) + ' のパスワード再設定';
    $('pwInput').value = ''; $('pwErr').textContent = '';
    $('pwDlg').showModal(); $('pwInput').focus();
  }
  $('pwCancel').onclick = () => $('pwDlg').close();
  $('pwForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    $('pwOk').disabled = true;
    try {
      await call('POST', '/api/admin/users/' + encodeURIComponent(pwUser.id) + '/password', { password: $('pwInput').value });
      $('pwDlg').close(); toast('パスワードを変更しました。全端末はログアウトされます');
    } catch (e) { $('pwErr').textContent = e.message; }
    $('pwOk').disabled = false;
  });

  function showMain() {
    $('login').hidden = true; $('main').hidden = false;
    reload();
    clearInterval(timer);
    timer = setInterval(() => { loadStats().catch(() => {}); refreshBadge().catch(() => {}); }, 15000);
  }
  function showLogin() {
    clearInterval(timer);
    $('main').hidden = true; $('login').hidden = false;
  }

  $('loginForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const url = $('url').value.trim().replace(/\/+$/, '');
    const key = $('key').value;
    $('loginErr').textContent = '';
    if (!url || !key) { $('loginErr').textContent = 'URLと管理キーを入れてください'; return; }
    cfg = { url, key };
    $('loginBtn').disabled = true; $('loginBtn').textContent = '接続中...';
    try {
      await loadStats();
      await window.admin.saveCfg({ url, key, remember: $('remember').checked });
      showMain();
    } catch (e) { $('loginErr').textContent = e.message; }
    $('loginBtn').disabled = false; $('loginBtn').textContent = '接続';
  });

  $('refresh').onclick = reload;
  $('logout').onclick = () => { cfg.key = ''; $('key').value = ''; showLogin(); };
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadUsers().catch(e => toast(e.message)), 250);
  });

  (async () => {
    const c = await window.admin.getCfg();
    $('url').value = c.url; $('key').value = c.key; $('remember').checked = c.remember;
    if (c.key) $('loginForm').requestSubmit();
  })();
})();
