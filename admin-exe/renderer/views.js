'use strict';
/* 各画面と詳細ドロワー */
(function () {
  const { h, icon, fmt, tag, avatar, toast, clear } = BC;
  BC.S = { v2: false, stats: null, connected: false };
  BC.views = {};

  const errMsg = e => (e && e.message) || '失敗した';
  const nameOf = x => x ? (x.displayName || x.username || '') : '';

  function errorState(e, retry) {
    return BC.empty('alert', '読み込めなかった', errMsg(e),
      h('button', { class: 'btn sm', type: 'button', onclick: retry }, icon('refresh', 14), '再試行'));
  }
  // 一覧の先頭にあるツールバー用の小さな箱
  const tools = (...a) => h('div', { class: 'toolbar' }, a);

  /* =====================================================================
     報告カード (報告画面とドロワーで共用)
     ===================================================================== */
  BC.reportCard = (r, o) => {
    o = o || {};
    const isUser = r.kind === 'user';
    const done = r.status === 'resolved';
    const head = h('div', { class: 'rep-head' },
      tag(isUser ? '通報' : 'バグ', isUser ? 'danger' : 'warn'),
      r.category ? tag(BC.CAT[r.category] || r.category, 'mute') : null,
      done ? tag('対応済み', 'ok') : null,
      h('span', { class: 'grow' }),
      r.appVersion ? h('span', { class: 'muted' }, 'v' + r.appVersion) : null,
      h('span', { class: 'muted', title: fmt.dt(r.createdAt) }, o.compact ? fmt.rel(r.createdAt) : fmt.dt(r.createdAt)));
    const media = (Array.isArray(r.mediaUrls) ? r.mediaUrls : []).map(u => BC.mediaThumb(u)).filter(Boolean);
    const kids = [head, h('p', { class: 'rep-msg' }, r.message || '')];
    if (r.claudeNote) kids.push(h('div', { class: 'rep-note' }, h('strong', null, 'Claude'), h('span', null, r.claudeNote)));
    if (media.length) kids.push(h('div', { class: 'thumbs' }, media));

    const who = [];
    const person = (x, withLink) => {
      if (!x || !(x.displayName || x.username)) return h('span', { class: 'muted' }, '(削除済み)');
      const label = nameOf(x) + (x.username && x.displayName ? ' @' + x.username : '');
      return withLink && x.id
        ? h('button', { class: 'link', type: 'button', onclick: () => BC.openUser(x.id, x) }, label)
        : h('span', null, label);
    };
    if (!o.compact || o.who === 'reporter') who.push(h('span', { class: 'rep-who' }, h('span', { class: 'muted' }, '報告者'), person(r.reporter, false)));
    if ((!o.compact || o.who === 'target') && r.target) who.push(h('span', { class: 'rep-who' }, h('span', { class: 'muted' }, '対象'), person(r.target, !o.noLink)));
    const foot = h('div', { class: 'rep-foot' }, who, h('span', { class: 'grow' }));
    if (o.onToggle) {
      const b = h('button', { class: 'btn sm' + (done ? '' : ' primary'), type: 'button' }, icon(done ? 'undo' : 'check', 14), done ? '未対応に戻す' : '対応済みにする');
      b.addEventListener('click', async () => { b.disabled = true; try { await o.onToggle(r, done ? 'open' : 'resolved'); } finally { b.disabled = false; } });
      foot.appendChild(b);
    }
    if (who.length || o.onToggle) kids.push(foot);
    return h('article', { class: 'rep ' + (isUser ? 'user' : 'bug') + (done ? ' done' : '') + (o.compact ? ' compact' : '') }, kids);
  };

  /* =====================================================================
     ダッシュボード
     ===================================================================== */
  function dashboardView() {
    const root = h('div', { class: 'view' });
    const scroll = h('div', { class: 'scroll pad' });
    root.appendChild(scroll);
    const msNum = n => n + ' ms';
    const GROUPS = [
      ['ユーザー', [
        { k: 'users', label: 'ユーザー', go: 'users' },
        { k: 'online', label: 'オンライン', go: 'online', tone: n => n > 0 ? 'ok' : null },
        { k: 'newUsers24h', label: '新規 24時間' },
        { k: 'newUsers7d', label: '新規 7日' },
      ]],
      ['要対応', [
        { k: 'openReports', label: '未対応の報告', go: 'reports', tone: n => n > 0 ? 'warn' : null },
        { k: 'bannedUsers', label: '停止中', go: 'users', opts: { filter: 'banned' }, tone: n => n > 0 ? 'danger' : null },
      ]],
      ['メッセージ・投稿', [
        { k: 'messages', label: '個人メッセージ' },
        { k: 'groupMessages', label: 'グループメッセージ' },
        { k: 'groups', label: 'グループ' },
        { k: 'posts', label: '投稿', go: 'posts' },
      ]],
      ['サーバー', [
        { k: 'activeSessions', label: 'ログイン中の端末' },
        { k: 'wsConnections', label: 'WS接続' },
        { k: 'memoryMB', label: 'メモリ', f: n => fmt.num(n) + ' MB' },
        { k: 'uptimeSec', label: '稼働時間', f: fmt.uptime },
        { k: 'dbMs', label: 'DB応答', f: msNum, tone: n => n >= 1000 ? 'danger' : n >= 200 ? 'warn' : null },
        { k: 'version', label: 'サーバー ver', f: v => 'v' + v },
      ]],
    ];
    function skeleton() {
      clear(scroll);
      GROUPS.forEach(([title, items]) => {
        scroll.appendChild(h('section', { class: 'group' }, h('h3', { class: 'group-title' }, title),
          h('div', { class: 'cards' }, items.slice(0, 4).map(() => h('div', { class: 'card' }, h('i', { class: 'skel', style: { width: '50%', height: '11px' } }), h('i', { class: 'skel', style: { width: '36%', height: '26px', marginTop: '10px' } }))))));
      });
    }
    function render() {
      const s = BC.S.stats; if (!s) return;
      clear(scroll);
      GROUPS.forEach(([title, items]) => {
        const cards = items.filter(it => s[it.k] !== undefined).map(it => {
          const raw = s[it.k];
          const val = raw == null ? '-' : it.f ? it.f(raw) : fmt.num(raw);
          const tone = raw != null && it.tone ? it.tone(raw) : null;
          const inner = [h('span', { class: 'card-label' }, it.label), h('span', { class: 'card-val' + (tone ? ' ' + tone : '') }, val)];
          const target = it.go && BC.views[it.go] && !(BC.views[it.go].v2only && !BC.S.v2) ? it.go : null;
          return target
            ? h('button', { class: 'card link-card', type: 'button', onclick: () => BC.go(target, it.opts) }, inner, h('span', { class: 'card-go' }, icon('right', 14)))
            : h('div', { class: 'card' }, inner);
        });
        if (!cards.length) return;
        scroll.appendChild(h('section', { class: 'group' }, h('h3', { class: 'group-title' }, title), h('div', { class: 'cards' }, cards)));
      });
    }
    skeleton();
    return { id: 'dashboard', label: 'ダッシュボード', icon: 'dashboard', el: root, auto: true, activate() { if (BC.S.stats) render(); else skeleton(); }, refresh() { render(); }, invalidate() {} };
  }

  /* =====================================================================
     ユーザー
     ===================================================================== */
  function usersView() {
    const st = { q: '', filter: 'all', sort: 'created', order: 'desc', offset: 0, limit: 50 };
    let seq = 0, loaded = false;
    const root = h('div', { class: 'view' });
    const search = BC.searchBox('名前・ID・本名で検索 ( / )', v => { st.q = v; st.offset = 0; load(); });
    const filter = BC.seg([['all', 'すべて'], ['online', 'オンライン'], ['banned', '停止中'], ['locked', 'ロック中']], 'all', v => { st.filter = v; st.offset = 0; load(); }, '絞り込み');
    const sort = h('select', { class: 'inp sel', 'aria-label': '並び替え', onchange: e => { st.sort = e.target.value; st.offset = 0; load(); } },
      h('option', { value: 'created' }, '登録日'), h('option', { value: 'name' }, '名前'), h('option', { value: 'lastSeen' }, '最終ログイン'));
    const orderBtn = h('button', { class: 'btn sq', type: 'button', title: '昇順・降順を切り替え', 'aria-label': '昇順・降順を切り替え', onclick: () => { st.order = st.order === 'desc' ? 'asc' : 'desc'; paintOrder(); st.offset = 0; load(); } });
    function paintOrder() { clear(orderBtn).appendChild(icon(st.order === 'desc' ? 'down' : 'up', 15)); orderBtn.setAttribute('aria-label', st.order === 'desc' ? '降順' : '昇順'); }
    paintOrder();
    const count = h('span', { class: 'muted' });
    const body = h('div', { class: 'scroll' });
    const pager = BC.pager(st.limit, d => { st.offset = Math.max(0, st.offset + d * st.limit); load(); body.scrollTop = 0; });
    root.append(tools(search.el, filter.el, sort, orderBtn, h('span', { class: 'grow' }), count), body, pager.el);

    async function fetchPage() {
      if (BC.S.v2) {
        const p = new URLSearchParams({ q: st.q, filter: st.filter, sort: st.sort, order: st.order, limit: String(st.limit), offset: String(st.offset) });
        const d = await BC.api('GET', '/api/admin/users?' + p.toString());
        return { total: d.total != null ? d.total : (d.users || []).length, users: d.users || [] };
      }
      // 古いサーバー: 最大200件を取ってこちらで絞る
      const d = await BC.api('GET', '/api/admin/users?q=' + encodeURIComponent(st.q));
      let list = (d.users || []).slice();
      if (st.filter === 'online') list = list.filter(u => u.online);
      else if (st.filter === 'banned') list = list.filter(u => u.banned);
      else if (st.filter === 'locked') list = list.filter(u => u.locked);
      const dir = st.order === 'asc' ? 1 : -1;
      if (st.sort === 'name') list.sort((a, b) => dir * String(a.displayName || a.username).localeCompare(String(b.displayName || b.username), 'ja'));
      else list.sort((a, b) => dir * (((BC.parseDate(a.createdAt) || 0) - (BC.parseDate(b.createdAt) || 0))));
      return { total: list.length, users: list.slice(st.offset, st.offset + st.limit) };
    }
    async function load(silent) {
      const my = ++seq;
      root.classList.add('busy');
      if (!loaded) { clear(body).appendChild(BC.skelRows(10, 4)); }
      try {
        const d = await fetchPage();
        if (my !== seq) return;
        loaded = true;
        if (d.users.length === 0 && st.offset > 0 && d.total > 0) { st.offset = 0; return load(); }
        render(d);
      } catch (e) {
        if (my !== seq) return;
        if (!silent || !loaded) { clear(body).appendChild(errorState(e, () => load())); pager.el.hidden = true; count.textContent = ''; }
      } finally { if (my === seq) root.classList.remove('busy'); }
    }
    function stateTags(u) {
      const t = [];
      if (u.online) t.push(tag('オンライン', 'ok'));
      if (u.banned) t.push(tag('停止中 ' + fmt.until(u.bannedUntil), 'danger', u.banReason || ''));
      if (u.locked) t.push(tag('ロック中', 'warn'));
      if (u.googleOnly) t.push(tag('Google', 'mute', 'Googleログインのみ'));
      return t;
    }
    BC.userCell = (u) => h('div', { class: 'ucell' },
      h('span', { class: 'av-wrap' }, avatar(u.displayName || u.username), u.online ? h('i', { class: 'av-dot', title: 'オンライン' }) : null),
      h('div', { class: 'utext' },
        h('span', { class: 'uname' }, u.displayName || u.username || '(名前なし)'),
        h('span', { class: 'usub muted' }, [u.username ? '@' + u.username : null, u.userId].filter(Boolean).join(' · '))));
    BC.stateTags = stateTags;
    function render(d) {
      count.textContent = fmt.num(d.total) + ' 人';
      clear(body);
      if (!d.users.length) {
        const filtered = st.q || st.filter !== 'all';
        body.appendChild(BC.empty('users', filtered ? '該当するユーザーがいない' : 'ユーザーがいない', filtered ? '検索語か絞り込みを変える' : null));
        pager.update(0, 0, 0); return;
      }
      const showLast = BC.S.v2;
      const rows = d.users.map(u => {
        const open = () => BC.openUser(u.id, u);
        return h('tr', { class: 'row', tabindex: '0', onclick: open, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
          h('td', null, BC.userCell(u)),
          h('td', null, h('div', { class: 'tags' }, stateTags(u))),
          showLast ? h('td', { class: 'nowrap muted', title: fmt.dt(u.lastSeen) }, u.lastSeen ? fmt.rel(u.lastSeen) : '-') : null,
          h('td', { class: 'nowrap muted', title: fmt.dt(u.createdAt) }, fmt.date(u.createdAt)));
      });
      body.appendChild(h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'ユーザー'), h('th', null, '状態'), showLast ? h('th', null, '最終ログイン') : null, h('th', null, '登録日'))),
        h('tbody', null, rows)));
      pager.update(d.total, st.offset, d.users.length);
    }
    return {
      id: 'users', label: 'ユーザー', icon: 'users', el: root,
      activate(o) {
        sort.querySelector('option[value=lastSeen]').disabled = !BC.S.v2;
        if (o && o.filter && o.filter !== st.filter) { st.filter = o.filter; filter.set(o.filter); st.offset = 0; loaded = false; }
        if (!loaded) load();
      },
      refresh(silent) { return load(silent); },
      invalidate() { loaded = false; },
      focusSearch() { search.input.focus(); search.input.select(); },
    };
  }

  /* =====================================================================
     オンライン
     ===================================================================== */
  function onlineView() {
    const root = h('div', { class: 'view' });
    const count = h('span', { class: 'muted' });
    const body = h('div', { class: 'scroll' });
    root.append(tools(h('span', { class: 'live' }, h('i', { class: 'live-dot' }), '15秒ごとに更新'), h('span', { class: 'grow' }), count), body);
    let seq = 0, loaded = false;
    async function load(silent) {
      const my = ++seq;
      if (!loaded) clear(body).appendChild(BC.skelRows(6, 4));
      try {
        const d = await BC.api('GET', '/api/admin/online');
        if (my !== seq) return;
        loaded = true;
        const list = d.users || [];
        count.textContent = fmt.num(d.count != null ? d.count : list.length) + ' 人';
        clear(body);
        if (!list.length) { body.appendChild(BC.empty('online', '今オンラインの人はいない')); return; }
        body.appendChild(h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, 'ユーザー'), h('th', null, '本名'), h('th', null, '接続開始'), h('th', { class: 'r' }, '端末'))),
          h('tbody', null, list.map(u => {
            const open = () => BC.openUser(u.id, u);
            return h('tr', { class: 'row', tabindex: '0', onclick: open, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
              h('td', null, BC.userCell({ displayName: u.displayName, username: '', userId: u.userId, online: true, _noAt: true })),
              h('td', { class: 'muted' }, u.realName || '-'),
              h('td', { class: 'nowrap muted', title: fmt.dt(u.since) }, fmt.rel(u.since)),
              h('td', { class: 'r nowrap' }, fmt.num(u.devices)));
          }))));
      } catch (e) {
        if (my !== seq) return;
        if (!silent || !loaded) clear(body).appendChild(errorState(e, () => load()));
      }
    }
    return { id: 'online', label: 'オンライン', icon: 'online', el: root, v2only: true, auto: true, activate() { if (!loaded) load(); }, refresh(s) { return load(s); }, invalidate() { loaded = false; } };
  }

  /* =====================================================================
     報告
     ===================================================================== */
  function reportsView() {
    const st = { status: 'open', kind: 'all' };
    let seq = 0, loaded = false, all = [];
    const root = h('div', { class: 'view' });
    const statusSeg = BC.seg([['open', '未対応'], ['resolved', '対応済み'], ['all', 'すべて']], 'open', v => { st.status = v; load(); }, '状態');
    const kindSeg = BC.seg([['all', 'すべて'], ['bug', 'バグ'], ['user', '通報']], 'all', v => { st.kind = v; paint(); }, '種類');
    const count = h('span', { class: 'muted' });
    const body = h('div', { class: 'scroll pad' });
    root.append(tools(statusSeg.el, kindSeg.el, h('span', { class: 'grow' }), count), body);

    async function toggle(r, status) {
      try {
        await BC.api('POST', '/api/admin/reports/' + encodeURIComponent(r.id) + '/status', { status });
        toast(status === 'resolved' ? '対応済みにした' : '未対応に戻した');
        await load(true); BC.afterReportChange();
      } catch (e) { toast(errMsg(e), 'err'); }
    }
    function paint() {
      const list = all.filter(r => st.kind === 'all' || (st.kind === 'user' ? r.kind === 'user' : r.kind !== 'user'));
      count.textContent = fmt.num(list.length) + ' 件';
      clear(body);
      if (!list.length) { body.appendChild(BC.empty('flag', st.status === 'open' ? '未対応の報告はない' : '報告がない')); return; }
      body.appendChild(h('div', { class: 'replist' }, list.map(r => BC.reportCard(r, { onToggle: toggle }))));
    }
    async function load(silent) {
      const my = ++seq;
      if (!loaded) clear(body).appendChild(BC.skelRows(4, 2));
      try {
        const d = await BC.api('GET', '/api/admin/reports?status=' + encodeURIComponent(st.status));
        if (my !== seq) return;
        loaded = true; all = d.reports || []; paint();
      } catch (e) {
        if (my !== seq) return;
        if (!silent || !loaded) clear(body).appendChild(errorState(e, () => load()));
      }
    }
    return { id: 'reports', label: '報告', icon: 'flag', el: root, badge: true, activate() { if (!loaded) load(); }, refresh(s) { return load(s); }, invalidate() { loaded = false; } };
  }

  /* =====================================================================
     投稿
     ===================================================================== */
  function postsView() {
    const st = { q: '', deleted: '0', offset: 0, limit: 30 };
    let seq = 0, loaded = false;
    const root = h('div', { class: 'view' });
    const search = BC.searchBox('本文・投稿者で検索 ( / )', v => { st.q = v; st.offset = 0; load(); });
    const seg = BC.seg([['0', '公開中'], ['1', '削除済み'], ['all', 'すべて']], '0', v => { st.deleted = v; st.offset = 0; load(); }, '状態');
    const count = h('span', { class: 'muted' });
    const body = h('div', { class: 'scroll pad' });
    const pager = BC.pager(st.limit, d => { st.offset = Math.max(0, st.offset + d * st.limit); load(); body.scrollTop = 0; });
    root.append(tools(search.el, seg.el, h('span', { class: 'grow' }), count), body, pager.el);

    async function del(p) {
      const ok = await BC.confirm({ title: '投稿を削除する', message: (p.authorName || '投稿者') + ' の投稿を削除する。', detail: '論理削除。あとから復元できる。', okText: '削除する', danger: true });
      if (!ok) return;
      try { await BC.api('POST', '/api/admin/posts/' + encodeURIComponent(p.id) + '/delete'); toast('削除した'); load(true); BC.afterPostChange(); }
      catch (e) { toast(errMsg(e), 'err'); }
    }
    async function restore(p) {
      try { await BC.api('POST', '/api/admin/posts/' + encodeURIComponent(p.id) + '/restore'); toast('復元した'); load(true); BC.afterPostChange(); }
      catch (e) { toast(errMsg(e), 'err'); }
    }
    function card(p) {
      const gone = !!p.deletedAt;
      const text = h('p', { class: 'post-text clamp' }, p.text || '');
      if (!p.text) text.classList.add('muted'), text.textContent = '(本文なし)';
      else text.addEventListener('click', () => text.classList.toggle('clamp'));
      const th = p.mediaUrl ? BC.mediaThumb(p.mediaUrl, p.mediaType) : null;
      return h('article', { class: 'post' + (gone ? ' gone' : '') },
        h('div', { class: 'post-main' },
          h('div', { class: 'post-head' },
            avatar(p.authorName || p.authorUserId),
            p.authorId ? h('button', { class: 'link strong', type: 'button', onclick: () => BC.openUser(p.authorId, { id: p.authorId, displayName: p.authorName, userId: p.authorUserId }) }, p.authorName || '(名前なし)')
              : h('span', { class: 'strong' }, p.authorName || '(不明)'),
            p.authorUserId ? h('span', { class: 'muted' }, p.authorUserId) : null,
            gone ? tag('削除済み ' + fmt.dt(p.deletedAt), 'danger') : null,
            h('span', { class: 'grow' }),
            h('span', { class: 'muted nowrap', title: '閲覧数' }, icon('eyeview', 13), fmt.num(p.viewCount)),
            h('span', { class: 'muted nowrap' }, fmt.dt(p.createdAt))),
          text,
          th ? h('div', { class: 'thumbs' }, th) : (p.mediaUrl ? h('span', { class: 'muted' }, 'メディア: (非対応のURL)') : null)),
        h('div', { class: 'post-act' },
          gone
            ? h('button', { class: 'btn sm', type: 'button', onclick: () => restore(p) }, icon('undo', 14), '復元')
            : h('button', { class: 'btn sm danger-o', type: 'button', onclick: () => del(p) }, icon('trash', 14), '削除')));
    }
    async function load(silent) {
      const my = ++seq;
      root.classList.add('busy');
      if (!loaded) clear(body).appendChild(BC.skelRows(5, 2));
      try {
        const p = new URLSearchParams({ q: st.q, deleted: st.deleted, limit: String(st.limit), offset: String(st.offset) });
        const d = await BC.api('GET', '/api/admin/posts?' + p.toString());
        if (my !== seq) return;
        loaded = true;
        const list = d.posts || [];
        if (!list.length && st.offset > 0 && d.total > 0) { st.offset = 0; return load(); }
        count.textContent = fmt.num(d.total != null ? d.total : list.length) + ' 件';
        clear(body);
        if (!list.length) { body.appendChild(BC.empty('posts', st.q || st.deleted !== '0' ? '該当する投稿がない' : '投稿がない')); pager.update(0, 0, 0); return; }
        body.appendChild(h('div', { class: 'postlist' }, list.map(card)));
        pager.update(d.total, st.offset, list.length);
      } catch (e) {
        if (my !== seq) return;
        if (!silent || !loaded) { clear(body).appendChild(errorState(e, () => load())); pager.el.hidden = true; }
      } finally { if (my === seq) root.classList.remove('busy'); }
    }
    return { id: 'posts', label: '投稿', icon: 'posts', el: root, v2only: true, activate() { if (!loaded) load(); }, refresh(s) { return load(s); }, invalidate() { loaded = false; }, focusSearch() { search.input.focus(); search.input.select(); } };
  }

  /* =====================================================================
     操作ログ
     ===================================================================== */
  const ACTIONS = {
    'user.ban': ['BAN', 'danger'], 'user.unban': ['BAN解除', 'ok'], 'user.logout': ['全端末ログアウト', 'info'],
    'user.unlock': ['ロック解除', 'info'], 'user.password': ['パスワード再設定', 'warn'], 'user.session_revoke': ['セッション失効', 'info'],
    'post.delete': ['投稿削除', 'danger'], 'post.restore': ['投稿復元', 'ok'], 'report.status': ['報告の状態', 'mute'],
  };
  const TARGETS = { user: 'ユーザー', post: '投稿', report: '報告' };
  function auditView() {
    const st = { offset: 0, limit: 50 };
    let seq = 0, loaded = false;
    const root = h('div', { class: 'view' });
    const count = h('span', { class: 'muted' });
    const body = h('div', { class: 'scroll' });
    const pager = BC.pager(st.limit, d => { st.offset = Math.max(0, st.offset + d * st.limit); load(); body.scrollTop = 0; });
    root.append(tools(h('span', { class: 'muted' }, 'このツールとAPIで行った変更の記録'), h('span', { class: 'grow' }), count), body, pager.el);
    async function load(silent) {
      const my = ++seq;
      root.classList.add('busy');
      if (!loaded) clear(body).appendChild(BC.skelRows(10, 4));
      try {
        const d = await BC.api('GET', '/api/admin/audit?limit=' + st.limit + '&offset=' + st.offset);
        if (my !== seq) return;
        loaded = true;
        const list = d.entries || [];
        count.textContent = fmt.num(d.total != null ? d.total : list.length) + ' 件';
        clear(body);
        if (!list.length) { body.appendChild(BC.empty('audit', '操作ログはまだない')); pager.update(0, 0, 0); return; }
        body.appendChild(h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, '日時'), h('th', null, '操作'), h('th', null, '対象'), h('th', null, '内容'))),
          h('tbody', null, list.map(e => {
            const a = ACTIONS[e.action];
            const label = e.targetLabel || e.targetId || '';
            const target = e.targetType === 'user' && e.targetId
              ? h('button', { class: 'link', type: 'button', onclick: () => BC.openUser(e.targetId, { id: e.targetId, displayName: e.targetLabel }) }, label || e.targetId)
              : h('span', null, label);
            return h('tr', null,
              h('td', { class: 'nowrap muted' }, fmt.dt(e.at)),
              h('td', null, tag(a ? a[0] : e.action, a ? a[1] : 'mute', e.action)),
              h('td', null, e.targetType ? h('span', { class: 'muted tt' }, TARGETS[e.targetType] || e.targetType) : null, target),
              h('td', { class: 'detail' }, e.detail || ''));
          }))));
        pager.update(d.total, st.offset, list.length);
      } catch (e) {
        if (my !== seq) return;
        if (!silent || !loaded) { clear(body).appendChild(errorState(e, () => load())); pager.el.hidden = true; }
      } finally { if (my === seq) root.classList.remove('busy'); }
    }
    return { id: 'audit', label: '操作ログ', icon: 'audit', el: root, v2only: true, activate() { if (!loaded) load(); }, refresh(s) { return load(s); }, invalidate() { loaded = false; } };
  }

  [dashboardView, usersView, onlineView, reportsView, postsView, auditView].forEach(f => { const v = f(); BC.views[v.id] = v; });
  BC.viewOrder = ['dashboard', 'users', 'online', 'reports', 'posts', 'audit'];

  /* =====================================================================
     ユーザー詳細ドロワー
     ===================================================================== */
  const drawer = document.getElementById('drawer');
  const scrim = document.getElementById('scrim');
  const appEl = document.getElementById('app');
  let cur = null, dseq = 0, lastFocus = null, isOpen = false;

  function setInert(on) { try { if (on) appEl.setAttribute('inert', ''); else appEl.removeAttribute('inert'); } catch (e) {} }

  BC.drawerOpen = () => isOpen;
  BC.openUser = async (id, hint) => {
    if (!id) return;
    if (!isOpen) lastFocus = document.activeElement;
    const my = ++dseq;
    cur = { id: String(id), hint: hint || {}, detail: null, error: null, busy: false };
    isOpen = true;
    scrim.hidden = false; drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); setInert(true);
    paintDrawer(true);
    await loadDetail(my);
  };
  async function loadDetail(my) {
    if (!BC.S.v2) {
      // 古いサーバーには詳細APIがないので、一覧から自分の行を引き直す
      try {
        if (cur.hint.username) {
          const d = await BC.api('GET', '/api/admin/users?q=' + encodeURIComponent(cur.hint.username));
          const m = (d.users || []).find(x => x.id === cur.id);
          if (my === dseq && m) cur.hint = m;
        }
      } catch (e) {}
      if (my === dseq) paintDrawer();
      return;
    }
    try {
      const d = await BC.api('GET', '/api/admin/users/' + encodeURIComponent(cur.id));
      if (my !== dseq) return;
      cur.detail = d; cur.error = null;
    } catch (e) {
      if (my !== dseq) return;
      cur.error = errMsg(e);
    }
    paintDrawer();
  }
  BC.closeUser = () => {
    if (!isOpen) return;
    isOpen = false; dseq++;
    drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); scrim.hidden = true; setInert(false);
    const f = lastFocus; lastFocus = null;
    if (f && document.contains(f) && f.focus) f.focus(); else if (document.body) document.body.focus();
  };
  scrim.addEventListener('click', () => BC.closeUser());
  BC.refreshOpenUser = () => { if (isOpen && cur) loadDetail(dseq); };

  async function runOp(btn, fn, okMsg) {
    if (btn) btn.disabled = true;
    try { await fn(); if (okMsg) toast(okMsg); BC.afterUserChange(); BC.refreshOpenUser(); }
    catch (e) { toast(errMsg(e), 'err'); }
    finally { if (btn) btn.disabled = false; }
  }

  function field(label, value, extra) {
    if (value == null || value === '') return null;
    return h('div', { class: 'kv' }, h('dt', null, label), h('dd', null, value, extra || null));
  }

  function paintDrawer(first) {
    if (!cur) return;
    const u = Object.assign({}, cur.hint, cur.detail ? cur.detail.user : {});
    const id = cur.id;
    const name = u.displayName || u.username || '(読み込み中)';
    const v2 = BC.S.v2;

    const header = h('header', { class: 'dr-head' },
      avatar(u.displayName || u.username, 'lg'),
      h('div', { class: 'dr-title' },
        h('h3', null, name),
        h('span', { class: 'muted' }, (u.username ? '@' + u.username : '') + (u.userId ? ' · ' + u.userId : ''))),
      h('span', { class: 'grow' }),
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': '閉じる (Esc)', title: '閉じる (Esc)', onclick: () => BC.closeUser() }, icon('x', 18)));

    const tags = BC.stateTags(u);
    const banBox = u.banned ? h('div', { class: 'note danger' },
      h('strong', null, '利用停止中 ' + fmt.until(u.bannedUntil)),
      h('span', null, (u.banReason ? '理由: ' + u.banReason + ' / ' : '') + '解除予定 ' + (u.bannedUntil >= Date.now() + 3650 * 86400000 ? '無期限' : fmt.dt(u.bannedUntil)))) : null;

    // 操作
    const mk = (ic, text, cls, fn) => { const b = h('button', { class: 'btn ' + (cls || ''), type: 'button' }, icon(ic, 15), text); b.addEventListener('click', () => fn(b)); return b; };
    const ops = [
      mk('logout', '全端末ログアウト', '', b => BC.confirm({ title: '全端末からログアウトさせる', message: name + ' の全セッションを切る。', okText: 'ログアウトさせる', danger: true })
        .then(ok => ok && runOp(b, () => BC.api('POST', '/api/admin/users/' + encodeURIComponent(id) + '/logout'), 'ログアウトさせた'))),
      mk('unlock', 'ロック解除', u.locked ? 'primary' : '', b => runOp(b, () => BC.api('POST', '/api/admin/users/' + encodeURIComponent(id) + '/unlock'), 'ロックを解除した')),
    ];
    if (u.banned) ops.push(mk('checkcircle', 'BAN解除', 'primary', b => BC.confirm({ title: 'BANを解除する', message: name + ' の利用停止を解く。', okText: '解除する' })
      .then(ok => ok && runOp(b, () => BC.api('POST', '/api/admin/users/' + encodeURIComponent(id) + '/unban'), 'BANを解除した'))));
    else if (v2) ops.push(mk('ban', 'BAN', 'danger-o', async b => {
      const r = await BC.banDialog(u); if (!r) return;
      runOp(b, () => BC.api('POST', '/api/admin/users/' + encodeURIComponent(id) + '/ban', { hours: r.hours, reason: r.reason }), 'BANした');
    }));
    ops.push(mk('key', 'パスワード再設定', '', async () => {
      const done = await BC.passwordDialog(u, pw => BC.api('POST', '/api/admin/users/' + encodeURIComponent(id) + '/password', { password: pw }));
      if (done) { BC.afterUserChange(); BC.refreshOpenUser(); }
    }));

    const body = h('div', { class: 'dr-body' });
    BC.add(body, [
      h('div', { class: 'tags dr-tags' }, tags.length ? tags : tag('通常', 'mute')),
      banBox,
      h('section', { class: 'sec' }, h('h4', null, '操作'), h('div', { class: 'ops' }, ops))]);

    // 情報
    const dl = h('dl', { class: 'kvs' },
      field('IDコード', u.userId, u.userId ? BC.copyBtn(u.userId, 'コピー', true) : null),
      field('内部ID', u.id, u.id ? BC.copyBtn(u.id, 'コピー', true) : null),
      field('本名', u.realName),
      field('登録', u.createdAt ? fmt.dt(u.createdAt) : null),
      field('最終ログイン', u.lastSeen ? fmt.dt(u.lastSeen) + ' (' + fmt.rel(u.lastSeen) + ')' : (v2 && cur.detail ? 'なし' : null)),
      field('ログイン方法', u.googleOnly === undefined ? null : (u.googleOnly ? 'Googleのみ' : 'パスワード')),
      field('メール', u.emailVerified === undefined ? null : (u.emailVerified ? '確認済み' : '未確認')),
      field('2段階認証', u.totp === undefined ? null : (u.totp ? '有効' : '無効')),
      field('ログイン失敗', u.failedLogins ? u.failedLogins + ' 回' : null),
      field('自己紹介', u.bio));
    body.appendChild(h('section', { class: 'sec' }, h('h4', null, '情報'), dl));

    if (!v2) {
      body.appendChild(h('div', { class: 'note' }, h('span', null, 'セッション・件数・関連する報告は、サーバーを更新すると表示される。')));
    } else if (cur.error && !cur.detail) {
      body.appendChild(BC.empty('alert', '詳細を読み込めなかった', cur.error, h('button', { class: 'btn sm', type: 'button', onclick: () => { cur.error = null; paintDrawer(); loadDetail(dseq); } }, icon('refresh', 14), '再試行')));
    } else if (!cur.detail) {
      body.appendChild(h('section', { class: 'sec' }, BC.skelRows(5, 2)));
    } else {
      const d = cur.detail, c = d.counts || {};
      body.appendChild(h('section', { class: 'sec' }, h('h4', null, '件数'),
        h('div', { class: 'mini' }, [['投稿', c.posts], ['グループ', c.groups], ['フレンド', c.friends], ['送信メッセージ', c.sentMessages]].map(([l, v]) =>
          h('div', { class: 'mini-item' }, h('b', null, fmt.num(v)), h('span', null, l))))));
      const ses = d.sessions || [];
      body.appendChild(h('section', { class: 'sec' }, h('h4', null, 'セッション', h('span', { class: 'muted' }, ' ' + ses.length)),
        ses.length ? h('ul', { class: 'sessions' }, ses.map(s => h('li', { class: 'ses' + (s.revoked ? ' off' : '') },
          h('span', { class: 'ses-ic' }, icon('device', 16)),
          h('div', { class: 'ses-text' },
            h('span', { class: 'ses-dev' }, s.device || '(不明な端末)'),
            h('span', { class: 'muted' }, [s.ip, '作成 ' + fmt.dt(s.createdAt), '最終 ' + fmt.rel(s.lastSeenAt)].filter(Boolean).join(' · '))),
          s.revoked ? tag('失効済み', 'mute')
            : h('button', { class: 'btn sm danger-o', type: 'button', onclick: ev => {
              const b = ev.currentTarget;
              BC.confirm({ title: 'セッションを失効させる', message: (s.device || 'この端末') + ' をログアウトさせる。', okText: '失効させる', danger: true })
                .then(ok => ok && runOp(b, () => BC.api('POST', '/api/admin/users/' + encodeURIComponent(id) + '/sessions/' + encodeURIComponent(s.id) + '/revoke'), 'セッションを失効させた'));
            } }, '失効'))))
          : h('p', { class: 'muted' }, 'セッションなし')));
      const rep = (title, list, who) => h('section', { class: 'sec' }, h('h4', null, title, h('span', { class: 'muted' }, ' ' + list.length)),
        list.length ? h('div', { class: 'replist' }, list.map(r => BC.reportCard(r, { compact: true, who, noLink: true }))) : h('p', { class: 'muted' }, 'なし'));
      body.appendChild(rep('この人への報告', d.reportsAgainst || [], 'reporter'));
      body.appendChild(rep('この人からの報告', d.reportsBy || [], 'target'));
    }

    const prev = drawer.querySelector('.dr-body');
    const top = prev && !first ? prev.scrollTop : 0;
    clear(drawer); drawer.appendChild(header); drawer.appendChild(body);
    body.scrollTop = top;
    if (first) { const x = header.querySelector('.iconbtn'); if (x) x.focus(); }
  }
})();
