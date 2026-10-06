// public/js/profanity.js
// 禁止語(Fワード)の判定。サーバーの utils/moderation.js と同じ中身。
// 個人チャット・グループはE2E暗号化でサーバーが中身を見られないので、送る前にここで調べ、
// 引っかかったら送らずにサーバーへ自分の停止を伝える(自分のアカウントだけ止まる)。
(function () {
  if (window.BCProfanity) return;
  const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '$': 's', '!': 'i', '|': 'i', '©': 'c', '(': 'c', '¢': 'c', '@': '*', '#': '*', '%': '*' };
  function containsBannedWord(text) {
    if (typeof text !== 'string' || !text) return false;
    const base = text.normalize('NFKC').toLowerCase();
    // カタカナ・ひらがな
    // (「ファクト」「ファックス」は普通の言葉なので除く)
    if (/ファ[ー・\s]*ッ+[ー・\s]*ク(?!ス)|ふぁ[ー・\s]*っ+[ー・\s]*く(?!す)/.test(base)) return true;
    // 英字: 記号置き換え(f@ck, fu(k 等)を戻し、空白や記号の区切り(f u c k / f.u.c.k)を詰め、
    // 同じ文字の連続(fuuuuck)を1文字にしてから見る。* は伏せ字としてそのまま残す
    const latin = base
      .split('').map(c => LEET[c] || c).join('')
      .replace(/[^a-z*]/g, '')
      .replace(/(.)\1+/g, '$1');
    // fuck / fack / fvck / fxck / f*ck / f*k / fck / phuck。
    // 「fuk」単体はローマ字(fukuoka・fuku 等)とぶつかるので含めない
    return /f[uvxa*]ck|f\*k|fck|ph[ua]ck|phuk/.test(latin);
  }
  
  const LATIN_RE = /f[uvxa*]ck|f\*k|fck|ph[ua]ck|phuk/g;
  const KANA_RE = /ファ[ー・\s]*ッ+[ー・\s]*ク(?!ス)|ふぁ[ー・\s]*っ+[ー・\s]*く(?!す)/g;
  function censor(text) {
    if (typeof text !== 'string' || !text || !containsBannedWord(text)) return text;
    // 1文字ずつ正規化し、英字(と伏せ字の*)だけを位置付きで拾う
    const stream = []; // { c, start, end }  元の文字列での [start, end)
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i), len = cp > 0xffff ? 2 : 1;
      const n = String.fromCodePoint(cp).normalize('NFKC').toLowerCase();
      for (const ch of n) {
        const m = LEET[ch] || ch;
        if (/[a-z*]/.test(m)) stream.push({ c: m, start: i, end: i + len });
      }
      i += len;
    }
    // 同じ文字の連続をまとめる(範囲は伸ばす)
    const col = [];
    for (const t of stream) {
      const last = col[col.length - 1];
      if (last && last.c === t.c) last.end = t.end; else col.push({ ...t });
    }
    const str = col.map(t => t.c).join('');
    const ranges = [];
    let m;
    LATIN_RE.lastIndex = 0;
    while ((m = LATIN_RE.exec(str))) ranges.push([col[m.index].start, col[m.index + m[0].length - 1].end]);
    const nfk = text; // カナは元の文字列のまま探す
    KANA_RE.lastIndex = 0;
    while ((m = KANA_RE.exec(nfk))) ranges.push([m.index, m.index + m[0].length]);
    ranges.sort((x, y) => x[0] - y[0]);
    let out = '', pos = 0;
    for (const [st, en] of ranges) {
      if (st < pos) continue;
      out += text.slice(pos, st) + 'f***';
      pos = en;
    }
    return out + text.slice(pos);
  }
  
  // 送った後に呼ぶ: 自分の3日間停止をサーバーへ伝え(相手/グループに「Banしました」が出る)、停止画面を出す
  async function reportAfterSend(target) {
    try {
      const token = localStorage.getItem('ring_token');
      const r = await fetch('/api/moderation/self-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(target || { where: 'chat' }),
      });
      const j = await r.json().catch(() => ({}));
      if (window.bcShowBanned) window.bcShowBanned(j.bannedUntil || (Date.now() + 3 * 864e5));
    } catch (e) {
      if (window.bcShowBanned) window.bcShowBanned(Date.now() + 3 * 864e5);
    }
  }
  window.BCProfanity = { containsBannedWord, censor, reportAfterSend };
})();
