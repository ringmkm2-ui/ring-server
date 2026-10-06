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
    // fuck / fvck / fxck / f*ck / f*k / fck / phuck。
    // 「fuk」単体はローマ字(fukuoka・fuku 等)とぶつかるので含めない
    return /f[uvx*]ck|f\*k|fck|phuck|phuk/.test(latin);
  }
  
  // 引っかかった時: 送らずに3日間の停止をサーバーへ伝え、停止画面を出す。true を返したら送信を止める
  async function blockIfProfane(text, where) {
    if (!containsBannedWord(text)) return false;
    try {
      const token = localStorage.getItem('ring_token');
      const r = await fetch('/api/moderation/self-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ where: where || 'chat' }),
      });
      const j = await r.json().catch(() => ({}));
      if (window.bcShowBanned) window.bcShowBanned(j.bannedUntil || (Date.now() + 3 * 864e5));
    } catch (e) {
      if (window.bcShowBanned) window.bcShowBanned(Date.now() + 3 * 864e5);
    }
    return true;
  }
  window.BCProfanity = { containsBannedWord, blockIfProfane };
})();
