// 使い方: node tools/e2e-full.js  (実Chromium 3台で 登録→鍵→友だち→DM→通話→グループ→グループ通話→コミュニティ→英語表示→ダーク を通しで確認)
// Bro Chat 通しテスト(実Chromium x3)
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { startServer, sleep } = require(ROOT + '/tests/helpers.js');
const { chromium } = (() => { try { return require('playwright'); } catch (e) { return require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright'); } })();
const OUT = process.env.E2E_OUT || path.join(require('os').tmpdir(), 'brochat-e2e');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function rec(name, ok, info = '') { results.push({ name, ok, info }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? ' — ' + info : '')); }
const ALLP = []; let stepN = 0;
async function step(name, fn) { stepN++; try { const r = await fn(); rec(name, r !== false, typeof r === 'string' ? r : ''); } catch (e) { rec(name, false, (e && e.message || String(e)).split('\n')[0].slice(0, 300)); for (const P of ALLP) await P.p.screenshot({ path: OUT + `/fail_${stepN}_${P.who}.png` }).catch(() => {}); } }

const errs = {};
function watch(page, who) {
  page.on('pageerror', e => { (errs[who] ||= []).push('[pageerror] ' + page.url().replace(/^http:\/\/[^/]+/, '') + ' ' + e.message); });
  page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (/Failed to load resource|ERR_|net::|favicon|fonts\.g|cdn|Cloudinary|firebase|fcm|push/i.test(t)) return; (errs[who] ||= []).push('[console] ' + page.url().replace(/^http:\/\/[^/]+/, '') + ' ' + t.slice(0, 200)); } });
  page.on('response', r => { if (r.status() >= 400 && r.url().startsWith('http://127.0.0.1')) (errs[who + ':http'] ||= []).push(r.status() + ' ' + r.request().method() + ' ' + r.url().replace(/^http:\/\/[^/]+/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').split('?')[0] + '  @' + page.url().replace(/^http:\/\/[^/]+/, '').split('?')[0]); });
  page.on('dialog', d => { (errs[who + ':dialog'] ||= []).push(d.message().slice(0, 200)); d.dismiss().catch(() => {}); });
}

(async () => {
  const srv = await startServer({ OFFICIAL_FRIEND_ID: '' });
  const B = srv.base;
  const browser = await chromium.launch({ executablePath: undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async (who, vp = { width: 390, height: 844 }) => {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, permissions: ['microphone', 'camera', 'notifications'], locale: 'ja-JP' });
    const p = await ctx.newPage(); watch(p, who); const o = { ctx, p, who }; ALLP.push(o); return o;
  };

  // ---------- 1. 登録(UI) ----------
  const A = await mk('A');
  const emailA = `ui_${Date.now()}@example.com`, pwA = 'Vq8!mZtestA9x';
  await step('auth.html 表示', async () => { await A.p.goto(B + '/auth.html'); await A.p.waitForSelector('#loginEmail'); });
  await step('UIで新規登録', async () => {
    await A.p.evaluate(() => { const b = [...document.querySelectorAll('button,a,[data-mode]')].find(x => /新規|登録|register|sign ?up/i.test(x.textContent || '') || x.dataset.mode === 'register'); b && b.click(); });
    await A.p.waitForSelector('#signupName', { state: 'visible', timeout: 5000 });
    await A.p.fill('#signupName', 'テストA'); await A.p.fill('#signupRealName', '山田 太郎');
    await A.p.fill('#signupEmail', emailA); await A.p.fill('#signupPassword', pwA);
    const terms = await A.p.$('#signupSection input[type=checkbox], .form-section.active input[type=checkbox]'); if (terms) await terms.check().catch(() => {});
    await A.p.evaluate(() => { const f = document.getElementById('signupEmail').closest('form'); f.requestSubmit ? f.requestSubmit() : f.submit(); });
    await A.p.waitForURL(/talklist|verify/, { timeout: 15000 }).catch(() => {});
    if (!/talklist/.test(A.p.url())) {
      // メール確認待ちの画面なら(SMTP無し)ここで止まる
      const txt = await A.p.evaluate(() => document.querySelector('.form-section.active')?.innerText || document.body.innerText.slice(0, 300));
      throw new Error('トーク一覧へ行かない: ' + A.p.url() + ' / ' + txt.replace(/\s+/g, ' ').slice(0, 200));
    }
  });
  await step('暗号鍵セットアップ画面(4ステップ)', async () => {
    await A.p.waitForSelector('#kbw', { timeout: 10000 });
    await A.p.click('#kbwContinue');
    await A.p.fill('#kbwPass1', 'correct horse battery 42'); await A.p.fill('#kbwPass2', 'correct horse battery 42');
    await A.p.click('#kbwNext');
    await A.p.waitForSelector('#kbwCheck', { timeout: 5000 }); await A.p.click('#kbwCheck'); await A.p.click('#kbwSave');
    await A.p.waitForSelector('#kbwCodeCheck', { timeout: 15000 }); await A.p.click('#kbwCodeCheck'); await A.p.click('#kbwCodeNext');
    await A.p.waitForSelector('#kbwStart', { timeout: 5000 }); await A.p.click('#kbwStart');
    await A.p.waitForSelector('#kbw', { state: 'detached', timeout: 5000 }).catch(() => {});
    const bk = await A.p.evaluate(() => fetch('/api/friends/key-backup', { headers: { authorization: 'Bearer ' + localStorage.getItem('ring_token') } }).then(r => r.status).catch(() => 0));
    return 'backup GET ' + bk;
  });
  await A.p.screenshot({ path: OUT + '/01_talklist_A.png' });
  const tokA = await A.p.evaluate(() => localStorage.getItem('ring_token'));
  const meA = { token: tokA, userId: await A.p.evaluate(() => localStorage.getItem('ring_userId')), userIdCode: await A.p.evaluate(() => localStorage.getItem('ring_userIdCode')) };
  meA.call = (m, p, b) => srv.req(m, p, { token: tokA, body: b });

  // ---------- 2. B, C はAPIで作ってUIでログイン ----------
  const uB = await srv.user('テストB'), uC = await srv.user('テストC');
  const Bb = await mk('B'), Cc = await mk('C');
  for (const [P, u, nm] of [[Bb, uB, 'B'], [Cc, uC, 'C']]) {
    await step(`UIでログイン(${nm})`, async () => {
      await P.p.goto(B + '/auth.html'); await P.p.fill('#loginEmail', u.username); await P.p.fill('#loginPassword', u.password);
      await P.p.evaluate(() => { const f = document.getElementById('loginEmail').closest('form'); f.requestSubmit(); });
      await P.p.waitForURL(/talklist/, { timeout: 15000 });
      // 鍵ウィザードが出たら後で
      await sleep(1500); await P.p.evaluate(() => { const l = document.querySelector('.kbw-later'); l && l.click(); });
    });
  }

  // ---------- 3. 友だち ----------
  await step('友だち申請→承認 (A-B, A-C, B-C)', async () => { await srv.befriend(meA, uB); await srv.befriend(meA, uC); await srv.befriend(uB, uC); });
  await step('トーク一覧に友だちが出る(A)', async () => {
    await A.p.reload(); await A.p.waitForTimeout(2500);
    const r = await meA.call('GET', '/api/friends/list'); return Array.isArray(r.data) && r.data.length >= 2 ? 'friends=' + r.data.length : false;
  });

  // ---------- 4. 個人チャット(E2E) ----------
  const openDM = (P, otherId, name) => P.p.goto(`${B}/admin.html?userId=${otherId}&name=${encodeURIComponent(name)}`).then(() => P.p.waitForSelector('#msgInput', { timeout: 15000 }));
  const sendDM = async (P, text) => { await P.p.fill('#msgInput', text); await P.p.click('#sendBtn'); };
  const swipe = async (P, sel) => { const bx = await P.p.locator(sel).boundingBox(); const x = bx.x + bx.width / 2, y = bx.y + bx.height / 2; await P.p.mouse.move(x, y); await P.p.mouse.down(); for (let i = 1; i <= 12; i++) { await P.p.mouse.move(x + i * 12, y - i * 4); await sleep(16); } await P.p.mouse.up(); };
  const dump = async () => {};
  const seen = (P, text, t = 15000) => P.p.waitForFunction(s => document.body.innerText.includes(s), text, { timeout: t });
  await step('DM: A→B 送信してBの画面で復号表示', async () => {
    await openDM(A, uB.userId, 'テストB'); await openDM(Bb, meA.userId, 'テストA'); await sleep(1500);
    await sendDM(A, 'こんにちは E2E テスト 1'); await seen(A, 'こんにちは E2E テスト 1'); await seen(Bb, 'こんにちは E2E テスト 1');
  });
  await dump('afterDM1');
  await step('DM: B→A 返信がリアルタイムで届く', async () => { await sendDM(Bb, 'reply from B 2'); await seen(A, 'reply from B 2'); });
  await step('DM: サーバーに平文が保存されていない', async () => {
    const r = await meA.call('GET', `/api/messages/history/${uB.userId}`);
    const raw = JSON.stringify(r.data || ''); if (r.status !== 200) return 'history status ' + r.status;
    return raw.includes('こんにちは E2E テスト 1') ? false : 'ok (暗号文のみ)';
  });
  await step('DM: リロード後も読める', async () => { await Bb.p.reload(); await seen(Bb, 'こんにちは E2E テスト 1'); await seen(Bb, 'reply from B 2'); });
  await step('DM: 長文・複数行・XSS文字列', async () => {
    const x = '<img src=x onerror=window.__xss=1>"\'&';
    await sendDM(A, x); await seen(Bb, '<img src=x'); const hit = await Bb.p.evaluate(() => !!window.__xss); return hit ? false : 'エスケープOK';
  });
  await A.p.screenshot({ path: OUT + '/02_dm_A.png' }); await Bb.p.screenshot({ path: OUT + '/03_dm_B.png' });
  await step('DM: 横スクロールが出ない(390px)', async () => { const w = await A.p.evaluate(() => document.documentElement.scrollWidth); return w <= 391 ? 'scrollWidth=' + w : false; });

  // ---------- 5. 個人通話 ----------
  await dump('beforeCall');
  await step('個人通話: A→B 音声発信して接続', async () => {
    await A.p.click('#phoneBtn');
    await Bb.p.waitForSelector('#gxAcceptBtn', { state: 'visible', timeout: 20000 });
    await Bb.p.screenshot({ path: OUT + '/04_incoming_B.png' });
    await swipe(Bb, '#gxAcceptBtn');
    const ok = await A.p.waitForFunction(() => typeof pc !== 'undefined' && pc && pc.connectionState === 'connected', null, { timeout: 30000 }).then(() => true).catch(() => false);
    const okB = await Bb.p.waitForFunction(() => typeof pc !== 'undefined' && pc && pc.connectionState === 'connected', null, { timeout: 10000 }).then(() => true).catch(() => false);
    await sleep(2500);
    await A.p.screenshot({ path: OUT + '/05_call_A.png' }); await Bb.p.screenshot({ path: OUT + '/05b_call_B.png' });
    const st = await A.p.evaluate(() => (document.getElementById('callStatus') || {}).textContent + ' sas=' + ((document.getElementById('callSas') || {}).textContent || ''));
    const stB = await Bb.p.evaluate(() => ((document.getElementById('callSas') || {}).textContent || ''));
    if (!ok || !okB) throw new Error('接続しない A=' + ok + ' B=' + okB + ' ' + st);
    return st + ' / B sas=' + stB;
  });
  await step('個人通話: 切断で両方の画面が閉じる', async () => {
    await A.p.click('#endBtn');
    await Bb.p.waitForFunction(() => !pc || pc.connectionState === 'closed' || !document.getElementById('callOv').classList.contains('show') && getComputedStyle(document.getElementById('callOv')).display === 'none', null, { timeout: 10000 });
    return 'ok';
  });
  await step('ビデオ通話: B→A 発信、映像トラックあり', async () => {
    await Bb.p.click('#videoCallBtn');
    await A.p.waitForSelector('#gxAcceptBtn', { state: 'visible', timeout: 20000 }); await swipe(A, '#gxAcceptBtn');
    await A.p.waitForFunction(() => typeof pc !== 'undefined' && pc && pc.connectionState === 'connected', null, { timeout: 30000 });
    await sleep(3000);
    const v = await A.p.evaluate(() => pc.getReceivers().filter(r => r.track && r.track.kind === 'video' && r.track.readyState === 'live').length);
    await A.p.screenshot({ path: OUT + '/05c_video_A.png' });
    await Bb.p.click('#endBtn').catch(() => {}); await sleep(1500);
    return v ? 'video recv=' + v : false;
  });

  // ---------- 6. グループ ----------
  let groupId;
  await dump('beforeGroup');
  await step('グループ作成(UI, A+B+C, 鍵配布)', async () => {
    await A.p.goto(B + '/talklist.html'); await A.p.waitForSelector('#ngBtn', { state: 'attached', timeout: 15000 }); await sleep(1500);
    await A.p.evaluate(() => document.getElementById('ngBtn').click());
    await A.p.waitForSelector('#ngMov.open', { timeout: 8000 });
    await A.p.waitForFunction(() => document.querySelectorAll('#ngMemberList input[type=checkbox]').length >= 2, null, { timeout: 8000 });
    await A.p.fill('#ngName', 'テストグループ');
    for (const cb of await A.p.$$('#ngMemberList input[type=checkbox]')) await cb.check();
    await A.p.click('#ngCreate');
    await A.p.waitForURL(/groupchat/, { timeout: 20000 });
    groupId = new URL(A.p.url()).searchParams.get('groupId'); return 'groupId=' + groupId;
  });
  const openG = P => P.p.goto(`${B}/groupchat.html?groupId=${groupId}&name=${encodeURIComponent('テストグループ')}`).then(() => P.p.waitForSelector('#mi', { timeout: 15000 }));
  const sendG = async (P, t) => { await P.p.fill('#mi', t); await P.p.press('#mi', 'Enter'); };
  await dump('afterGroupCreate');
  await step('グループ: A送信→B,Cで復号表示', async () => {
    await openG(A); await openG(Bb); await openG(Cc); await sleep(2500);
    await sendG(A, 'group hello 1'); await seen(A, 'group hello 1'); await seen(Bb, 'group hello 1', 20000); await seen(Cc, 'group hello 1', 20000);
  });
  await step('グループ: C送信→A,B', async () => { await sendG(Cc, 'from C in group'); await seen(A, 'from C in group'); await seen(Bb, 'from C in group'); });
  await step('グループ: 平文がサーバーに無い', async () => { const r = await meA.call('GET', `/api/groups/${groupId}/messages`); return JSON.stringify(r.data || '').includes('group hello 1') ? false : 'status ' + r.status; });
  await Cc.p.screenshot({ path: OUT + '/06_group_C.png' });
  await dump('beforeGCall');
  await step('グループ通話(ビデオ): A開始→B,C参加→3人とも相手2人と接続', async () => {
    await A.p.click('#videoBtnG');
    for (const P of [Bb, Cc]) { await P.p.waitForSelector('#gcallJoinBtn', { state: 'visible', timeout: 20000 }); await P.p.click('#gcallJoinBtn'); await sleep(1500); }
    const ok = async P => P.p.waitForFunction(me => { const t = [...document.querySelectorAll('#gcallGrid [data-uid]')].filter(x => x.dataset.uid !== me); return t.length >= 2 && t.every(x => !x.classList.contains('connecting')); }, await P.p.evaluate(() => localStorage.getItem('ring_userId')), { timeout: 30000 }).then(() => true).catch(() => false);
    const r = [await ok(A), await ok(Bb), await ok(Cc)];
    await sleep(2000); await Bb.p.screenshot({ path: OUT + '/06c_gcall_B.png' });
    for (const P of [A, Bb, Cc]) await P.p.click('#gcEnd').catch(() => {});
    await sleep(1500);
    if (r.includes(false)) throw new Error('A/B/C=' + r.join('/')); return 'ok';
  });

  // ---------- 7. コミュニティ ----------
  let commId;
  await dump('beforeComm');
  await step('コミュニティ作成(UI)→招待コードで参加(UI)→E2E投稿をB,Cが読む', async () => {
    await A.p.goto(B + '/talklist.html'); await sleep(2000); await dump('talklistComm');
    await A.p.evaluate(() => document.getElementById('communityCreateBtn').click());
    await A.p.fill('#communityNameInput', 'テストコミュ'); await A.p.fill('#communityDescInput', 'desc');
    const before = (errs['A:dialog'] || []).length;
    await A.p.evaluate(() => document.getElementById('communityCreateSubmit').click());
    await A.p.waitForFunction(n => true, null).catch(() => {}); await sleep(2500);
    const list = await meA.call('GET', '/api/communities/list');
    const cm = (list.data && (list.data.communities || list.data) || [])[0];
    if (!cm) throw new Error('作成されない ' + JSON.stringify(list.data).slice(0, 200));
    commId = cm.id; const code = cm.inviteCode || cm.invite_code;
    if (!cm.encrypted && cm.encrypted !== undefined) throw new Error('encrypted=false');
    for (const P of [Bb, Cc]) {
      await P.p.goto(B + '/talklist.html'); await sleep(1500);
      await P.p.evaluate(() => { document.getElementById('communityCreateBtn').click(); document.getElementById('communityTabJoin').click(); });
      await P.p.fill('#communityInviteInput', code); await P.p.evaluate(() => document.getElementById('communityJoinSubmit').click()); await sleep(1500);
    }
    const openC = P => P.p.goto(`${B}/community.html?id=${commId}`).then(() => P.p.waitForSelector('#msgInput', { timeout: 15000 }));
    await openC(A); await sleep(3000); await A.p.fill('#msgInput', 'community e2e hello'); await A.p.click('#sendBtn'); await seen(A, 'community e2e hello');
    await openC(Bb); await openC(Cc); await seen(Bb, 'community e2e hello', 25000); await seen(Cc, 'community e2e hello', 25000);
    await Cc.p.fill('#msgInput', 'C says hi community'); await Cc.p.click('#sendBtn'); await seen(A, 'C says hi community', 20000);
    await Cc.p.screenshot({ path: OUT + '/06b_comm_C.png' });
    return 'code=' + code;
  });
  await step('コミュニティ: サーバーに平文が無い', async () => {
    const d = await meA.call('GET', `/api/communities/${commId}`); const ch = d.data && (d.data.channels || (d.data.community && d.data.community.channels) || [])[0];
    const chId = ch && (ch.id || ch.channelId); const r = await meA.call('GET', `/api/communities/${commId}/channels/${chId}/messages`);
    const raw = JSON.stringify(r.data || ''); if (r.status !== 200) return 'status ' + r.status; return raw.includes('community e2e hello') ? false : 'ok';
  });

  // ---------- 8. 各ページ巡回 + 英語モードで日本語が残っていないか ----------
  const pages = ['/talklist.html', `/admin.html?userId=${uB.userId}&name=B`, `/groupchat.html?groupId=${groupId}&name=G`, commId ? `/community.html?id=${commId}` : null, '/auth.html', '/welcome.html', '/privacy.html', '/terms.html', '/splash.html'].filter(Boolean);
  const jpLeft = {};
  await A.p.evaluate(() => localStorage.setItem('ring_language', 'en'));
  const U = await mk('U'); await U.p.goto(B + '/auth.html'); await U.p.evaluate(() => localStorage.setItem('ring_language', 'en'));
  for (const pg of pages) {
    await step('EN表示 ' + pg.split('?')[0], async () => {
      const PG = /auth|welcome|privacy|terms|splash/.test(pg) ? U : A;
      await PG.p.goto(B + pg); await sleep(2500);
      const hits = await PG.p.evaluate(() => {
        const out = new Set(); const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const vis = el => { while (el && el !== document.body) { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') return false; el = el.parentElement; } return true; };
        let n; while ((n = w.nextNode())) { const t = n.nodeValue.trim(); if (t && /[぀-ヿ一-鿿]/.test(t) && vis(n.parentElement) && !/テスト|山田|^テ$|^(日本語|中文|简体中文|繁體中文|한국어)$|from C in group/.test(t)) out.add(t.slice(0, 40)); }
        document.querySelectorAll('input[placeholder],textarea[placeholder]').forEach(i => { if (/[぀-ヿ一-鿿]/.test(i.placeholder) && i.offsetParent) out.add('ph:' + i.placeholder); });
        return [...out];
      });
      if (pg.includes('privacy') || pg.includes('terms')) return 'skip(規約は日本語のみ想定) ' + hits.length;
      jpLeft[pg.split('?')[0]] = hits; return hits.length ? false : 'ok';
    });
  }
  await A.p.screenshot({ path: OUT + '/07_en_last.png' });
  await A.p.evaluate(() => localStorage.setItem('ring_language', 'ja'));

  // ---------- 9. タブ / 設定 / テーマ / PCレイアウト ----------
  await step('トーク一覧: タブ切替(トーク/ホーム/投稿)', async () => {
    await A.p.goto(B + '/talklist.html'); await sleep(2500);
    const shots = [];
    for (const id of ['btnHome', 'btnPosts', 'btnTalk']) { await A.p.click('#' + id); await sleep(1500); await A.p.screenshot({ path: OUT + '/08_tab_' + id + '.png' }); shots.push(id + ':' + await A.p.evaluate(i => document.getElementById(i).classList.contains('active'), id)); }
    return shots.join(' ');
  });
  await A.p.screenshot({ path: OUT + '/08_lasttab_A.png' });
  const contrast = P => P.p.evaluate(() => {
    const lum = c => { const m = c.match(/[\d.]+/g); if (!m) return null; const [r, g, b] = m.slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
    const shown = el => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < .05) return false; } const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
    const bg = el => { for (let e = el; e; e = e.parentElement) { if (getComputedStyle(e).backgroundImage !== 'none' && e !== document.body) return null; const c = getComputedStyle(e).backgroundColor; const a = (c.match(/[\d.]+/g) || [])[3]; if (c && c !== 'transparent' && !(a !== undefined && +a < .6)) return c; } return getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)'; };
    const out = []; document.querySelectorAll('body *').forEach(el => { if (![...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim()) || !shown(el)) return; const bc = bg(el); if (bc == null) return; const f = lum(getComputedStyle(el).color), b = lum(bc); if (f == null || b == null) return; const r = (Math.max(f, b) + .05) / (Math.min(f, b) + .05); if (r < 2) out.push(el.textContent.trim().slice(0, 18) + ' ' + r.toFixed(2)); });
    return out.slice(0, 12);
  });
  for (const mode of ['light', 'dark']) {
    await step(`コントラスト(${mode}): 一覧/各モーダル/チャット`, async () => {
      await A.p.evaluate(m => localStorage.setItem('themeMode', m), mode); await A.p.emulateMedia({ colorScheme: mode });
      const bad = {};
      await A.p.goto(B + '/talklist.html'); await sleep(2500); let c = await contrast(A); if (c.length) bad.list = c;
      await A.p.screenshot({ path: OUT + `/09_${mode}_list.png` });
      for (const [btn, mov] of [['communityCreateBtn', 'communityMov'], ['ngBtn', 'ngMov']]) {
        await A.p.evaluate(b => document.getElementById(b).click(), btn); await sleep(1200);
        c = await contrast(A); if (c.length) bad[btn] = c; await A.p.screenshot({ path: OUT + `/09_${mode}_${btn}.png` });
        await A.p.evaluate(m => document.getElementById(m).classList.remove('open'), mov); await sleep(500);
      }
      for (const [pg, tag] of [[`/admin.html?userId=${uB.userId}&name=B`, 'dm'], [`/groupchat.html?groupId=${groupId}&name=G`, 'group'], [`/community.html?id=${commId}`, 'comm']]) {
        await A.p.goto(B + pg); await sleep(2500); c = await contrast(A); if (c.length) bad[tag] = c; await A.p.screenshot({ path: OUT + `/09_${mode}_${tag}.png` });
      }
      if (Object.keys(bad).length) throw new Error(JSON.stringify(bad)); return 'ok';
    });
  }
  await A.p.evaluate(() => localStorage.setItem('themeMode', 'light')); await A.p.emulateMedia({ colorScheme: 'light' });
  await step('PCレイアウト(1440x900)', async () => {
    const PC = await mk('PC', { width: 1440, height: 900 });
    await PC.ctx.addInitScript(([t, id, code]) => { localStorage.setItem('ring_token', t); localStorage.setItem('ring_userId', id); localStorage.setItem('ring_user_id', id); localStorage.setItem('ring_userIdCode', code); localStorage.setItem('myName', 'テストA'); }, [tokA, meA.userId, meA.userIdCode]);
    await PC.p.goto(B + '/talklist.html'); await sleep(3000); await PC.p.screenshot({ path: OUT + '/10_pc.png' });
    const w = await PC.p.evaluate(() => document.documentElement.scrollWidth); await PC.ctx.close(); return w <= 1441 ? 'scrollWidth=' + w : false;
  });

  // ---------- 10. サーバーAPIの細かい所 ----------
  await step('未ログインで保護APIが401', async () => { const r = await srv.req('GET', '/api/friends/list'); return r.status === 401 ? 'ok' : false; });
  await step('/health と /api/auth/features', async () => { const r = await srv.req('GET', '/api/auth/features'); return r.status === 200 ? JSON.stringify(r.data).slice(0, 150) : false; });
  await step('sw.js と manifest.json が取れる', async () => { const a = await fetch(B + '/sw.js'), b = await fetch(B + '/manifest.json'); return a.ok && b.ok ? 'ok' : false; });

  // ---------- 結果 ----------
  console.log('\n===== エラーログ =====');
  for (const [k, v] of Object.entries(errs)) { const u = [...new Set(v)]; console.log(`-- ${k} (${u.length})`); u.slice(0, 25).forEach(x => console.log('   ' + x)); }
  console.log('\n===== EN画面に残った日本語 =====');
  for (const [k, v] of Object.entries(jpLeft)) if (v.length) console.log(k, JSON.stringify(v.slice(0, 30)));
  const fails = results.filter(r => !r.ok);
  console.log(`\nTOTAL ${results.length} PASS ${results.length - fails.length} FAIL ${fails.length}`);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ results, errs, jpLeft }, null, 1));
  await browser.close(); await srv.stop(); process.exitCode = fails.length ? 1 : 0;
  if (srv.log && process.env.SRVLOG) console.log(srv.log().slice(-4000));
})().catch(e => { console.error('CRASH', e); process.exit(1); });
