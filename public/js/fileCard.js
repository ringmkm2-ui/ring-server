// fileCard.js
// -----------------------------------------------------------------------
// チャットで送られてきたファイル(PDF・書類・zip など)を「ファイルカード」として出す。
// 画像・動画と同じ端末内の暗号化アップロードを使う。ファイル名とサイズは暗号化された
// メタデータの中なので、まず小さいメタデータだけ開いて名前を出し、本体は
// タップされた時にだけダウンロード・復号する(100MBのファイルを見るだけで落とさない)。
//
// 使い方: BroFile.render(placeholder, { getKeys, url, encryptedMetadata, localFile })
//   getKeys: async () => [Uint8Array,...]  メタデータを開く鍵の候補(世代違いも含む)
//   localFile: 自分が今送ったファイル(手元にあればダウンロード不要)
// -----------------------------------------------------------------------
(function () {
  const ICON_FILE = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  const ICON_DL = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 11 12 16 17 11"/><path d="M5 21h14"/></svg>';
  const ICON_OK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12.5 10 17.5 19 7.5"/></svg>';

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }
  // 保存名: パス区切りや制御文字を除く(相手が好きな名前を付けられるため)
  function safeName(name) {
    let s = String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '_').trim();
    if (!s) s = 'file';
    if (s.length > 120) {
      const dot = s.lastIndexOf('.');
      const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
      s = s.slice(0, 120 - ext.length) + ext;
    }
    return s;
  }

  async function save(blob, name) {
    // 中身をブラウザで開いてしまわないよう、常に汎用型で保存する
    const file = new File([blob], name, { type: 'application/octet-stream' });
    // 共有シートが使える端末(iPhone・Androidの多く)は、そこから「ファイルに保存」できる
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 共有シートを閉じただけ
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function render(ph, opts) {
    for (let i = 0; i < 100 && !window.cloudinaryE2EUploader; i++) await new Promise(r => setTimeout(r, 100));
    const up = window.cloudinaryE2EUploader;
    let meta = null, sharedKey = null;
    try {
      if (opts.localFile) {
        meta = { fileName: opts.localFile.name, fileSize: opts.localFile.size };
      } else {
        const keys = await opts.getKeys();
        if (!keys || !keys.length) throw new Error('no key');
        for (const k of keys) {
          try { meta = up.decryptMetadata(opts.encryptedMetadata, k); sharedKey = k; if (meta) break; } catch (e) { /* 次の鍵 */ }
        }
        if (!meta) throw new Error('decrypt');
      }
    } catch (e) {
      ph.textContent = '(ファイルを開けませんでした。タップでもう一度)';
      ph.style.cursor = 'pointer';
      ph.onclick = () => { ph.onclick = null; ph.textContent = '読み込み中...'; render(ph, opts); };
      return;
    }

    const name = safeName(meta.fileName);
    const card = document.createElement('div');
    card.className = 'file-card';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:210px;max-width:260px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.75);color:#1e293b;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;';
    const ico = document.createElement('span');
    ico.style.cssText = 'display:flex;flex:0 0 auto;color:#3b82f6;';
    ico.innerHTML = ICON_FILE;
    const txt = document.createElement('span');
    txt.style.cssText = 'flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;';
    const nm = document.createElement('span');
    nm.style.cssText = 'font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nm.textContent = name;
    const sub = document.createElement('span');
    sub.style.cssText = 'font-size:11px;color:#64748b;';
    sub.textContent = fmtSize(meta.fileSize);
    txt.append(nm, sub);
    const act = document.createElement('span');
    act.style.cssText = 'display:flex;flex:0 0 auto;color:#3b82f6;';
    act.innerHTML = ICON_DL;
    card.append(ico, txt, act);

    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      sub.textContent = 'ダウンロード中...';
      try {
        const blob = opts.localFile || await Promise.race([
          up.downloadAndDecryptMedia(opts.url, opts.encryptedMetadata, sharedKey),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 120000)),
        ]);
        await save(blob, name);
        act.innerHTML = ICON_OK;
        sub.textContent = fmtSize(meta.fileSize);
        setTimeout(() => { act.innerHTML = ICON_DL; }, 2500);
      } catch (e) {
        console.error('[fileCard]', e);
        sub.textContent = e && e.message === 'timeout' ? '時間切れ(タップでもう一度)' : '失敗しました(タップでもう一度)';
      } finally { busy = false; }
    };
    card.addEventListener('click', (ev) => { ev.stopPropagation(); run(); });
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); run(); } });
    ph.replaceWith(card);
  }

  window.BroFile = { render, fmtSize, safeName };
})();
