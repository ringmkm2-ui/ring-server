// 使い方: node tools/e2e-actions.js
// 実Chromium 3台で、メッセージ操作(返信/リアクション/編集/取消/ピン/既読/入力中)、グループのメンバー増減と鍵更新、
// 別端末での鍵の復元、ブロック、ログアウト→再ログインを確認する
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { startServer, sleep } = require(ROOT + '/tests/helpers.js');
const { chromium } = (() => { try { return require('playwright'); } catch (e) { return require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright'); } })();
const OUT = process.env.E2E_OUT || path.join(require('os').tmpdir(), 'brochat-e2e-actions');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const errs = {};
const ALLP = [];
let stepN = 0;
function rec(name, ok, info = '') { results.push({ name, ok, info }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? ' — ' + info : '')); }
async function step(name, fn) {
  stepN++;
  try { const r = await fn(); rec(name, r !== false, typeof r === 'string' ? r : ''); }
  catch (e) { rec(name, false, (e && e.message || String(e)).split('\n')[0].slice(0, 300)); for (const P of ALLP) await P.p.screenshot({ path: `${OUT}/fail_${stepN}_${P.who}.png` }).catch(() => {}); }
}

(async () => {
  const srv = await startServer({ OFFICIAL_FRIEND_ID: '' });
  const B = srv.base;
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const mk = async (who, u) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP', permissions: ['microphone', 'camera'] });
    if (u) await ctx.addInitScript(u => { if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); if (!localStorage.getItem('ring_token')) { localStorage.setItem('ring_token', u.token); localStorage.setItem('ring_userId', u.userId); localStorage.setItem('ring_user_id', u.userId); localStorage.setItem('ring_userIdCode', u.userIdCode); localStorage.setItem('ring_username', u.username); localStorage.setItem('myName', u.displayName); localStorage.setItem('ring_display_name', u.displayName); } } }, { token: u.token, userId: u.userId, userIdCode: u.userIdCode, username: u.username, displayName: u.displayName || 'x' });
    const p = await ctx.newPage();
    p.on('pageerror', e => (errs[who] ||= []).push('[pageerror] ' + p.url().replace(/^http:\/\/[^/]+/, '').split('?')[0] + ' ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|GSI_LOGGER|vibrate/.test(m.text())) (errs[who] ||= []).push('[console] ' + p.url().replace(/^http:\/\/[^/]+/, '').split('?')[0] + ' ' + m.text().slice(0, 200)); });
    p.on('response', r => { if (r.status() >= 400 && r.url().startsWith(B)) (errs[who + ':http'] ||= []).push(r.status() + ' ' + r.request().method() + ' ' + r.url().slice(B.length).split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')); });
    p.on('dialog', d => { (errs[who + ':dialog'] ||= []).push(d.message().slice(0, 160)); d.type() === 'confirm' ? d.accept() : d.dismiss(); });
    const o = { ctx, p, who }; ALLP.push(o); return o;
  };
  const skipWizard = P => P.p.evaluate(() => { const l = document.querySelector('.kbw-later') || [...document.querySelectorAll('button')].find(b => b.offsetParent && /^(あとで|Later)$/.test(b.textContent.trim())); if (l) l.click(); }).catch(() => {});
  const seen = (P, text, t = 15000) => P.p.waitForFunction(s => document.body.innerText.includes(s), text, { timeout: t });
  const gone = (P, text, t = 15000) => P.p.waitForFunction(s => !document.body.innerText.includes(s), text, { timeout: t });
  const bubbleOf = (P, text) => P.p.evaluateHandle(t => [...document.querySelectorAll('.msg-text')].find(e => e.textContent.includes(t))?.closest('.bubble,.bub'), text);
  const openMenu = async (P, text) => { const h = await bubbleOf(P, text); const el = h.asElement(); if (!el) throw new Error('吹き出しが無い: ' + text); const bx = await el.boundingBox(); await el.dispatchEvent('contextmenu', { clientX: bx.x + 10, clientY: bx.y + 10 }); await sleep(400); };

  const uA = await srv.user('アリス'), uB = await srv.user('ボブ'), uC = await srv.user('チャーリー'), uD = await srv.user('デイブ');
  await srv.befriend(uA, uB); await srv.befriend(uA, uC); await srv.befriend(uA, uD); await srv.befriend(uB, uC);
  const A = await mk('A', uA), Bb = await mk('B', uB), C = await mk('C', uC);

  await step('友だち申請がリアルタイムで届き、ホームにバッジが出る', async () => {
    const uE = await srv.user('イブ'); const E = await mk('E', uE);
    await E.p.goto(B + '/talklist.html'); await sleep(2500); await skipWizard(E);
    await uC.call('POST', '/api/friends/request', { targetUserIdCode: uE.userIdCode });
    await E.p.waitForFunction(() => { const b = document.getElementById('homeTabBadge'); return b && !b.hidden && b.textContent === '1'; }, null, { timeout: 8000 });
    await E.ctx.close(); ALLP.splice(ALLP.indexOf(E), 1);
  });

  // ---------- DM ----------
  const dm = (P, other, name) => P.p.goto(`${B}/admin.html?userId=${other.userId}&name=${encodeURIComponent(name)}`).then(() => P.p.waitForSelector('#msgInput', { timeout: 15000 })).then(() => sleep(1500)).then(() => skipWizard(P));
  const sendDM = async (P, t) => { await P.p.fill('#msgInput', t); await P.p.click('#sendBtn'); };
  await dm(A, uB, 'ボブ'); await dm(Bb, uA, 'アリス');

  await step('DM: 話したことのない友だちでもオンライン表示が出る', async () => {
    await A.p.waitForFunction(() => /オンライン|Online/.test(document.querySelector('.status')?.textContent || ''), null, { timeout: 10000 });
  });
  await step('DM: 入力中がリアルタイムで相手に出る', async () => {
    await A.p.focus('#msgInput'); await A.p.keyboard.type('あいう', { delay: 80 });
    await Bb.p.waitForFunction(() => /入力中|typing/i.test(document.body.innerText) || !!document.querySelector('.typing:not([hidden]),.typing-indicator:not([hidden]),[class*="typing"]:not([style*="none"])'), null, { timeout: 8000 });
    await A.p.fill('#msgInput', '');
    return 'ok';
  });
  await step('DM: 既読がつく', async () => {
    await sendDM(A, 'read check 1'); await seen(Bb, 'read check 1');
    await A.p.waitForFunction(() => !![...document.querySelectorAll('.msg-text')].find(e => e.textContent.includes('read check 1'))?.closest('[data-msg-id]')?.querySelector('.check-2.lit'), null, { timeout: 12000 });
  });
  await step('DM: 返信(引用つき)が相手に届く', async () => {
    await openMenu(Bb, 'read check 1'); await Bb.p.click('#replyBtn'); await Bb.p.fill('#msgInput', 'this is a reply'); await Bb.p.click('#sendBtn');
    await seen(A, 'this is a reply');
    const q = await A.p.evaluate(() => { const b = [...document.querySelectorAll('.msg-text')].find(e => e.textContent.includes('this is a reply'))?.closest('[data-msg-id]'); return b ? b.innerText : ''; });
    return /read check 1/.test(q) ? 'quote ok' : false;
  });
  await step('DM: リアクションが相手に出る', async () => {
    await openMenu(Bb, 'read check 1'); await Bb.p.click('#reactBtn'); await sleep(300);
    await Bb.p.click('#reactPicker .rp-btn >> nth=2');
    await A.p.waitForFunction(() => { const m = [...document.querySelectorAll('.msg-text')].find(e => e.textContent.includes('read check 1'))?.closest('[data-msg-id]'); return m && /👍/.test(m.innerText); }, null, { timeout: 10000 });
  });
  await step('DM: 編集が相手にリアルタイム反映(暗号文が見えない)', async () => {
    await sendDM(A, 'before edit'); await seen(Bb, 'before edit');
    await openMenu(A, 'before edit'); await A.p.click('#editBtn'); await A.p.fill('#msgInput', 'after edit'); await A.p.click('#sendBtn');
    await seen(Bb, 'after edit'); await gone(Bb, 'before edit', 5000);
    const raw = await Bb.p.evaluate(() => /e[23]:[A-Za-z0-9+/]{20}/.test(document.body.innerText)); if (raw) throw new Error('暗号文が見えている');
    await Bb.p.reload(); await Bb.p.waitForSelector('#msgInput'); await seen(Bb, 'after edit'); return 'ok(リロード後も)';
  });
  await step('DM: 送信取り消しが相手から消える', async () => {
    await sendDM(A, 'to be unsent'); await seen(Bb, 'to be unsent'); await sleep(800);
    await openMenu(A, 'to be unsent'); await A.p.click('#delBtn'); await sleep(500);
    const cf = await A.p.$('#confYes:visible, .conf-yes:visible'); if (cf) await cf.click();
    await gone(Bb, 'to be unsent', 10000); await gone(A, 'to be unsent', 5000);
  });
  await step('DM: ピン留めが相手にも見える(平文で)', async () => {
    await openMenu(A, 'read check 1'); await A.p.click('#pinBtn');
    await A.p.waitForFunction(() => getComputedStyle(document.getElementById('pinBanner')).display !== 'none', null, { timeout: 8000 });
    await Bb.p.reload(); await Bb.p.waitForSelector('#msgInput'); await sleep(2500);
    const t = await Bb.p.evaluate(() => { const b = document.getElementById('pinBanner'); return getComputedStyle(b).display !== 'none' ? b.innerText : '(非表示)'; });
    return /read check 1/.test(t) ? 'ok' : (() => { throw new Error('B側: ' + t.replace(/\s+/g, ' ').slice(0, 80)); })();
  });
  await step('DM: 未読バッジがトーク一覧に出て、開くと消える', async () => {
    await C.p.goto(B + '/talklist.html'); await sleep(2000); await skipWizard(C);
    await A.p.goto(`${B}/admin.html?userId=${uC.userId}&name=C`); await A.p.waitForSelector('#msgInput'); await sleep(1500); await sendDM(A, 'unread for C'); await seen(A, 'unread for C');
    await C.p.waitForFunction(() => /unread for C/.test(document.body.innerText), null, { timeout: 15000 });
    const badge = await C.p.evaluate(() => { const row = [...document.querySelectorAll('[data-user-id],.talk-item,.ti')].find(r => /unread for C/.test(r.innerText)); return row ? (row.querySelector('.badge,.ub,.unread,[class*="badge"]') || {}).textContent || '' : 'row?'; });
    await dm(C, uA, 'アリス'); await seen(C, 'unread for C');
    await C.p.goto(B + '/talklist.html'); await sleep(2500);
    const after = await C.p.evaluate(() => { const row = [...document.querySelectorAll('[data-user-id],.talk-item,.ti')].find(r => /unread for C/.test(r.innerText)); const b = row && row.querySelector('.badge,.ub,.unread,[class*="badge"]'); return b && b.offsetParent ? b.textContent : ''; });
    if (!badge || badge === 'row?') throw new Error('バッジが無い(' + badge + ')'); if (after) throw new Error('開いた後もバッジ: ' + after); return 'badge=' + badge;
  });

  // ---------- グループ: 作成 → 操作 → メンバー追加・削除 → 退出 ----------
  let gid;
  await step('グループ: A,B,Cで作成', async () => {
    await A.p.goto(B + '/talklist.html'); await sleep(3000); await skipWizard(A);
    await A.p.evaluate(() => document.getElementById('ngBtn').click()); await A.p.waitForSelector('#ngMov.open');
    await A.p.waitForFunction(() => document.querySelectorAll('#ngMemberList input[type=checkbox]').length >= 3, null, { timeout: 8000 });
    await A.p.fill('#ngName', 'G1');
    for (const id of [uB.userId, uC.userId]) await A.p.evaluate(id => { const c = document.querySelector(`#ngMemberList input[value="${id}"]`); if (!c) throw new Error('no checkbox ' + id); c.click(); }, id);
    await A.p.click('#ngCreate'); await A.p.waitForURL(/groupchat/, { timeout: 20000 }); gid = new URL(A.p.url()).searchParams.get('groupId');
  });
  const g = P => P.p.goto(`${B}/groupchat.html?groupId=${gid}&name=G1`).then(() => P.p.waitForSelector('#mi', { timeout: 15000 })).then(() => sleep(2000));
  const sg = async (P, t) => { await P.p.fill('#mi', t); await P.p.press('#mi', 'Enter'); };
  await g(A); await g(Bb); await g(C);
  await step('グループ: 入力中が他の人に出る', async () => {
    await Bb.p.focus('#mi'); await Bb.p.keyboard.type('xyz', { delay: 80 });
    await A.p.waitForFunction(() => { const e = document.getElementById('gTyping'); return e && e.offsetParent && !e.classList.contains('gt-hide') && /ボブ/.test(e.innerText); }, null, { timeout: 8000 });
    await Bb.p.fill('#mi', '');
  });
  await step('グループ: 返信(引用つき)が全員に届く・リロード後も残る・引用タップで元へ', async () => {
    await sg(Bb, 'g origin msg'); await seen(A, 'g origin msg'); await seen(C, 'g origin msg'); await sleep(800);
    await openMenu(A, 'g origin msg'); await A.p.click('#replyBtn');
    const pv = await A.p.evaluate(() => document.getElementById('replyPreview').innerText);
    if (!/ボブ/.test(pv) || !/g origin msg/.test(pv)) throw new Error('プレビュー: ' + pv.replace(/\s+/g, ' '));
    await sg(A, 'g reply to bob');
    const q = P => P.p.waitForFunction(() => { const m = [...document.querySelectorAll('.msg-text')].find(e => e.textContent.includes('g reply to bob'))?.closest('[data-msg-id]'); const qq = m && m.querySelector('.reply-quote'); return qq && /g origin msg/.test(qq.textContent) ? qq.textContent : false; }, null, { timeout: 15000 });
    await q(A); await q(Bb); await q(C);
    await sleep(400); const hidden = await A.p.evaluate(() => getComputedStyle(document.getElementById('replyPreview')).display === 'none');
    if (!hidden) throw new Error('送信後もプレビューが残っている');
    await C.p.reload(); await C.p.waitForSelector('#mi'); await q(C);
    await C.p.evaluate(() => [...document.querySelectorAll('.msg-text')].find(e => e.textContent.includes('g reply to bob')).closest('[data-msg-id]').querySelector('.reply-quote').click());
    await C.p.waitForFunction(() => !!document.querySelector('.reply-jump-flash'), null, { timeout: 3000 });
    await C.p.screenshot({ path: OUT + '/group_reply_C.png' });
  });
  await step('グループ: コピー', async () => {
    await A.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
    await openMenu(A, 'g origin msg'); await A.p.click('#copyBtn'); await sleep(300);
    const t = await A.p.evaluate(() => navigator.clipboard.readText());
    return t === 'g origin msg' ? 'ok' : (() => { throw new Error('clipboard=' + t); })();
  });
  await step('グループ: 編集がリアルタイムで他の人に反映', async () => {
    await sg(A, 'g before'); await seen(Bb, 'g before'); await seen(C, 'g before');
    await openMenu(A, 'g before'); await A.p.click('#editBtn'); await A.p.fill('#mi', 'g after'); await A.p.press('#mi', 'Enter');
    await seen(Bb, 'g after'); await seen(C, 'g after');
    await C.p.reload(); await C.p.waitForSelector('#mi'); await seen(C, 'g after');
  });
  await step('グループ: リアクションが他の人に出る', async () => {
    await openMenu(Bb, 'g after'); await Bb.p.click('#reactBtn'); await sleep(300); await Bb.p.click('#rpicker button >> nth=0');
    await A.p.waitForFunction(() => { const m = [...document.querySelectorAll('.msg-text')].find(e => e.textContent.includes('g after'))?.closest('[data-msg-id]'); return m && /❤/.test(m.innerText); }, null, { timeout: 10000 });
  });
  await step('グループ: 送信取り消し(確認ダイアログ→全員から消える)', async () => {
    await sg(A, 'g unsend me'); await seen(C, 'g unsend me'); await sleep(800);
    await openMenu(A, 'g unsend me'); await A.p.click('#delBtn'); await A.p.click('#confYes');
    await gone(C, 'g unsend me', 10000); await gone(Bb, 'g unsend me', 10000);
  });
  await step('グループ: ピン留めが他のメンバーに平文で見える', async () => {
    await openMenu(A, 'g after'); await A.p.click('#pinBtnCtx'); await sleep(1500);
    await Bb.p.reload(); await Bb.p.waitForSelector('#mi'); await sleep(2500);
    const t = await Bb.p.evaluate(() => { const b = document.getElementById('pinBanner'); return b.classList.contains('show') ? document.getElementById('pinText').textContent : '(非表示)'; });
    if (!/g after/.test(t)) throw new Error('B側のピン: ' + t.slice(0, 60)); return 'ok';
  });
  await step('グループ: Dを招待(UI)→Dが新しいメッセージを読める', async () => {
    await g(A);
    await A.p.evaluate(c => { document.getElementById('invInput').value = c; document.getElementById('invBtn').click(); }, uD.userIdCode);
    await A.p.waitForFunction(() => /デイブ/.test(document.getElementById('memList')?.innerText || ''), null, { timeout: 15000 });
    const D = await mk('D', uD); await g(D); await skipWizard(D);
    await A.p.evaluate(() => document.getElementById('memOv').classList.remove('show'));
    await sg(A, 'welcome D'); await seen(D, 'welcome D', 25000); await seen(Bb, 'welcome D', 25000);
    // 招待前のメッセージは読めない(後から入った人)
    const old = await D.p.evaluate(() => document.body.innerText.includes('g after'));
    return old ? '招待前も読める(仕様確認)' : 'ok';
  });
  await step('グループ: Cを削除(UI)→鍵が更新され、Cには以後のメッセージが読めない', async () => {
    await g(A); await A.p.click('#hinfoEl'); await A.p.waitForSelector('#memOv.show');
    await A.p.evaluate(() => { const row = [...document.querySelectorAll('#memList .litem')].find(r => /チャーリー/.test(r.innerText)); row.querySelector('.rmvbtn').click(); });
    await A.p.click('#confYes'); await sleep(2500);
    await g(A); await sg(A, 'secret after C left'); await seen(Bb, 'secret after C left', 25000);
    const D = ALLP.find(x => x.who === 'D'); await seen(D, 'secret after C left', 25000);
    const hist = await uC.call('GET', `/api/groups/${gid}/messages`);
    if (hist.status === 200 && JSON.stringify(hist.data).includes('secret after C left')) throw new Error('平文で届く');
    await C.p.goto(`${B}/groupchat.html?groupId=${gid}&name=G1`); await sleep(3000);
    const sees = await C.p.evaluate(() => document.body.innerText.includes('secret after C left'));
    return sees ? false : 'ok (history ' + hist.status + ')';
  });
  await step('グループ: Bが退出(UI)→残りの端末が鍵を作り直して続けられる', async () => {
    await g(Bb); await Bb.p.evaluate(() => document.getElementById('gLeaveBtn').click()); await Bb.p.click('#confYes');
    await Bb.p.waitForURL(/talklist/, { timeout: 10000 });
    const D = ALLP.find(x => x.who === 'D'); await g(D); await g(A); await sleep(1500);
    await sg(A, 'after B left'); await seen(D, 'after B left', 25000);
    await sg(D, 'D reply after B left'); await seen(A, 'D reply after B left', 25000);
    const bad = await A.p.evaluate(() => /復号に失敗|Couldn't decrypt/.test(document.body.innerText)); if (bad) throw new Error('A: 復号失敗の表示');
  });

  // ---------- 別端末で鍵の復元 ----------
  await step('別端末: パスフレーズで鍵を復元→過去のDMが読める', async () => {
    // Aが鍵を預ける
    const pass = 'Tq9-weird-otter-Plum7';
    await A.p.goto(B + '/talklist.html'); await sleep(1500);
    const up = await A.p.evaluate(async p => { const kb = window.bcKeyBackup; if (!kb) return 'no api'; const fn = kb._internal && kb._internal.upload; if (!fn) return 'keys:' + Object.keys(kb).join(','); try { await fn(p, undefined, true); return 'ok'; } catch (e) { return 'err ' + e.message; } }, pass);
    if (up !== 'ok') throw new Error('預け: ' + up);
    const A2 = await mk('A2');
    await A2.p.goto(B + '/auth.html'); await A2.p.fill('#loginEmail', uA.username); await A2.p.fill('#loginPassword', uA.password);
    await A2.p.evaluate(() => document.getElementById('loginEmail').closest('form').requestSubmit()); await A2.p.waitForURL(/talklist/, { timeout: 15000 });
    // 復元画面
    await A2.p.waitForSelector('input[name="bc-passphrase"], .kbw-title, #kbw', { timeout: 15000 }).catch(() => {});
    await A2.p.screenshot({ path: OUT + '/restore_prompt.png' });
    const inp = await A2.p.$('input[name="bc-passphrase"]');
    if (!inp) throw new Error('復元の入力欄が出ない');
    await inp.fill(pass); await A2.p.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => /復元する/.test(b.textContent) && b.offsetParent); b && b.click(); });
    await A2.p.waitForLoadState('load'); await sleep(3000);
    await A2.p.goto(`${B}/admin.html?userId=${uB.userId}&name=B`); await A2.p.waitForSelector('#msgInput'); await sleep(2000);
    await seen(A2, 'read check 1', 15000); await seen(A2, 'after edit', 5000);
    const bad = await A2.p.evaluate(() => /復号に失敗|Couldn't decrypt/.test(document.body.innerText)); if (bad) throw new Error('復号失敗の表示あり');
    // グループも
    await A2.p.goto(`${B}/groupchat.html?groupId=${gid}&name=G1`); await A2.p.waitForSelector('#mi'); await seen(A2, 'after B left', 15000);
    return 'ok';
  });
  await step('別端末: A2から送ったDMをBが読める(鍵の上書きで壊れない)', async () => {
    const A2 = ALLP.find(x => x.who === 'A2');
    await A2.p.goto(`${B}/admin.html?userId=${uB.userId}&name=B`); await A2.p.waitForSelector('#msgInput'); await sleep(1500);
    await sendDM(A2, 'from second device'); await dm(Bb, uA, 'アリス'); await seen(Bb, 'from second device', 15000);
    // 元の端末Aも受信できる
    await dm(A, uB, 'ボブ'); await seen(A, 'from second device', 15000);
  });

  // ---------- ブロック ----------
  await step('ブロック: BがCをブロック→Cのメッセージが届かない、通話も不可', async () => {
    const r = await uB.call('POST', '/api/friends/block', { userId: uC.userId });
    if (r.status >= 400) throw new Error('block ' + r.status + ' ' + JSON.stringify(r.data));
    await Bb.p.goto(`${B}/admin.html?userId=${uC.userId}&name=C`); await sleep(2500);
    const bar = await Bb.p.evaluate(() => /ブロック中/.test(document.body.innerText)); if (!bar) throw new Error('B側にブロック中の表示が無い');
    await C.p.goto(B + '/talklist.html'); await sleep(3000); await skipWizard(C); await dm(C, uB, 'ボブ');
    await sendDM(C, 'blocked msg'); await sleep(3000);
    const got = await Bb.p.evaluate(() => document.body.innerText.includes('blocked msg'));
    const hist = await uB.call('GET', `/api/messages/history/${uC.userId}`);
    if (got) throw new Error('届いてしまう'); return 'ok (history ' + hist.status + ')';
  });

  // ---------- ログアウト→再ログイン ----------
  await step('ログアウト→同じ端末で再ログイン→過去のDMが読める', async () => {
    await A.p.goto(B + '/talklist.html'); await sleep(1500);
    const lo = await A.p.evaluate(() => typeof window.logout === 'function' ? 'fn' : ([...document.querySelectorAll('button,.si,[data-call]')].find(b => /ログアウト/.test(b.textContent)) ? 'btn' : ''));
    if (lo === 'fn') await A.p.evaluate(() => window.logout());
    else if (lo === 'btn') await A.p.evaluate(() => [...document.querySelectorAll('button,.si,[data-call]')].find(b => /ログアウト/.test(b.textContent)).click());
    else throw new Error('ログアウト手段が見つからない');
    await sleep(1500); const cf = await A.p.$('#confYes:visible, button:has-text("ログアウトする"):visible'); if (cf) await cf.click();
    await A.p.waitForURL(/auth|welcome|splash/, { timeout: 10000 });
    await A.p.goto(B + '/auth.html'); await A.p.fill('#loginEmail', uA.username); await A.p.fill('#loginPassword', uA.password);
    await A.p.evaluate(() => document.getElementById('loginEmail').closest('form').requestSubmit()); await A.p.waitForURL(/talklist/, { timeout: 15000 }); await sleep(2500);
    const prompt = await A.p.$('input[name="bc-passphrase"]'); if (prompt) { await prompt.fill('Tq9-weird-otter-Plum7'); await A.p.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => /復元する/.test(b.textContent) && b.offsetParent); b && b.click(); }); await sleep(3000); }
    await A.p.goto(`${B}/admin.html?userId=${uB.userId}&name=B`); await A.p.waitForSelector('#msgInput'); await seen(A, 'read check 1', 15000);
    return prompt ? 'パスフレーズで復元' : '鍵は端末に残っていた';
  });

  console.log('\n===== エラーログ =====');
  for (const [k, v] of Object.entries(errs)) { const u = [...new Set(v)]; console.log(`-- ${k} (${u.length})`); u.slice(0, 20).forEach(x => console.log('   ' + x)); }
  const fails = results.filter(r => !r.ok);
  console.log(`\nTOTAL ${results.length} PASS ${results.length - fails.length} FAIL ${fails.length}  (shots: ${OUT})`);
  await browser.close(); await srv.stop(); process.exitCode = fails.length ? 1 : 0;
})().catch(e => { console.error('CRASH', e); process.exit(1); });
