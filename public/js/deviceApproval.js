// public/js/deviceApproval.js
// 新しい端末の承認(routes/devices.js)の画面。
// - 承認待ちの端末: 上に案内を出す。許可されたら読み込み直して鍵を使い始める
// - 有効な端末: 新しい端末の要求が来たら、確認コードを見比べて許可か拒否を選ぶ画面を出す
(function () {
  if (window.BcDevices) return;
  const uid = () => localStorage.getItem('ring_userId') || '';
  const T = (k, d) => (window.i18n && i18n.t ? i18n.t(k, d) : d);
  const SHIELD = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>';
  let shownFor = '', banner = null;
  const dismissed = new Set();

  function myKeys() {
    try {
      const k = JSON.parse(localStorage.getItem('e2e_keypair_' + uid()) || 'null');
      if (!k || !k.publicKey || !k.secretKey || !window.nacl) return null;
      const pk = Uint8Array.from(k.publicKey), sk = Uint8Array.from(k.secretKey);
      return { b64: nacl.util.encodeBase64(pk), secretKey: sk };
    } catch (e) { return null; }
  }
  const dark = () => document.documentElement.classList.contains('dark-mode');
  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(text, primary, onClick) {
    const b = el('button', 'flex:1;min-height:46px;border:0;border-radius:14px;font-size:15px;font-weight:700;cursor:pointer;'
      + (primary === 'danger' ? 'background:#dc2626;color:#fff' : primary ? 'background:#2563eb;color:#fff' : (dark() ? 'background:#334155;color:#f1f5f9' : 'background:#f1f5f9;color:#0f172a')), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // 自分の秘密鍵で開けることを見せてから、許可か拒否を送る
  async function decide(kind, target) {
    const me = myKeys();
    if (!me) throw new Error('no key');
    const c = await api('/api/devices/challenge', { method: 'POST', body: JSON.stringify({ publicKey: me.b64 }) });
    if (!c || !c.id) throw new Error((c && c.error) || 'error');
    const u = nacl.util;
    const answer = nacl.box.open(u.decodeBase64(c.box), u.decodeBase64(c.nonce), u.decodeBase64(c.serverPublicKey), me.secretKey);
    if (!answer) throw new Error('error');
    const r = await api('/api/devices/' + kind, { method: 'POST', body: JSON.stringify({ publicKey: target, challengeId: c.id, answer: u.encodeBase64(answer) }) });
    if (!r || !r.ok) throw new Error((r && r.error) || 'error');
  }

  function showRequest(item) {
    if (document.getElementById('bcDevReq')) return;
    shownFor = item.publicKey;
    const fg = dark() ? '#f1f5f9' : '#0f172a', sub = dark() ? '#94a3b8' : '#475569';
    const ov = el('div', 'position:fixed;inset:0;z-index:30000;background:rgba(15,23,42,.5);display:flex;align-items:flex-end;justify-content:center');
    ov.id = 'bcDevReq';
    const sh = el('div', 'width:100%;max-width:480px;box-sizing:border-box;padding:24px 20px calc(20px + env(safe-area-inset-bottom,0px));border-radius:26px 26px 0 0;color:' + fg + ';background:' + (dark() ? '#1e293b' : '#fff'));
    sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true');
    const ic = el('div', 'color:#2563eb;margin-bottom:8px'); ic.innerHTML = SHIELD;
    sh.appendChild(ic);
    sh.appendChild(el('div', 'font-size:18px;font-weight:800;margin-bottom:8px', T('dev_new_title', '新しい端末の追加を要求されています')));
    sh.appendChild(el('div', 'font-size:14px;line-height:1.6;color:' + sub, T('dev_new_desc', '新しい端末に同じ番号が出ている時だけ許可してください。許可すると、その端末でこれからのメッセージが読めるようになります。')));
    sh.appendChild(el('div', 'font:700 30px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-align:center;padding:18px 0', item.code));
    const err = el('div', 'font-size:13px;color:#dc2626;min-height:18px;margin-bottom:6px');
    sh.appendChild(err);
    const row = el('div', 'display:flex;gap:10px');
    const close = () => ov.remove();
    const act = kind => async ev => {
      const bs = row.querySelectorAll('button');
      bs.forEach(b => { b.disabled = true; });
      err.textContent = '';
      try {
        await decide(kind, item.publicKey);
        close();
        if (kind === 'reject' && window.alert) alert(T('dev_rejected_note', '拒否しました。心当たりが無い場合は、すぐにパスワードを変更してください。'));
        check();
      } catch (e) {
        err.textContent = (e && e.message && e.message !== 'error') ? e.message : T('dev_error', 'うまくいきませんでした。もう一度試してください');
        bs.forEach(b => { b.disabled = false; });
      }
    };
    row.appendChild(btn(T('dev_deny', '拒否'), 'danger', act('reject')));
    row.appendChild(btn(T('dev_allow', '許可'), true, act('approve')));
    sh.appendChild(row);
    const later = el('button', 'display:block;width:100%;min-height:44px;margin-top:8px;border:0;background:none;font-size:14px;cursor:pointer;color:' + sub, T('dev_later', 'あとで'));
    later.type = 'button';
    later.addEventListener('click', () => { dismissed.add(item.publicKey); close(); });
    sh.appendChild(later);
    ov.appendChild(sh);
    document.body.appendChild(ov);
  }

  function showPending(st) {
    if (banner) banner.remove();
    const when = st.approveAfter ? new Date(st.approveAfter).toLocaleString() : '';
    banner = el('div', 'position:fixed;left:12px;right:12px;top:calc(10px + env(safe-area-inset-top,0px));z-index:29000;padding:14px 16px;border-radius:18px;box-shadow:0 8px 28px rgba(15,23,42,.25);color:' + (dark() ? '#f1f5f9' : '#0f172a') + ';background:' + (dark() ? '#1e293b' : '#fff'));
    banner.id = 'bcDevPending';
    banner.setAttribute('role', 'status');
    banner.appendChild(el('div', 'font-size:15px;font-weight:800;margin-bottom:4px', T('dev_pending_title', 'この端末は承認待ちです')));
    banner.appendChild(el('div', 'font:700 22px ui-monospace,Menlo,monospace;letter-spacing:.08em;margin:4px 0', st.code));
    banner.appendChild(el('div', 'font-size:13px;line-height:1.55;opacity:.8', T('dev_pending_desc', 'ログイン済みの別の端末でこの番号を確かめて許可してください。別の端末が無ければ、鍵のバックアップから復元するか、{date} に自動で有効になるのを待ってください。許可されるまで、この端末では送受信できません。').replace('{date}', when)));
    document.body.appendChild(banner);
  }

  let busy = false;
  async function check() {
    if (busy || !uid() || typeof api !== 'function') return;
    busy = true;
    try {
      const me = myKeys();
      if (!me) return;
      const st = await api('/api/devices/status?publicKey=' + encodeURIComponent(me.b64));
      if (!st || st.enabled === false) return;
      if (st.status === 'pending') { showPending(st); return; }
      if (banner) { banner.remove(); banner = null; }
      if (st.status !== 'active') return;
      const r = await api('/api/devices/pending');
      const item = r && Array.isArray(r.pending) ? r.pending.find(p => !dismissed.has(p.publicKey)) : null;
      if (item) showRequest(item);
    } catch (e) { /* 次に開いた時にまた確かめる */ } finally { busy = false; }
  }

  function onWs(d) {
    const me = myKeys();
    if (d.type === 'device_pending') { check(); return; }
    if (d.publicKey && me && d.publicKey === me.b64) {
      if (d.type === 'device_approved') { location.reload(); return; }
      if (banner) banner.querySelector('div').textContent = T('dev_rejected_self', 'この端末は拒否されました');
      return;
    }
    const open = document.getElementById('bcDevReq');
    if (open && d.publicKey === shownFor) open.remove();   // 別の端末で先に決めた時は閉じる
  }

  window.BcDevices = { check, onWs };
  // 鍵の登録(起動の約2秒後)が終わってから確かめる
  setTimeout(check, 3500);
})();
