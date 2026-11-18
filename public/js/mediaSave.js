// mediaSave.js
// プレビュー中の画像・動画を端末に保存する。
// iPhone(Safari・ホーム画面のアプリ)は <a download> が効かないことが多いので、共有シート
// (「画像を保存」「ビデオを保存」「ファイルに保存」が出る)を先に使う。ダメなら通常のダウンロード。
(function () {
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
  const mobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function toast(msg) {
    document.querySelectorAll('[data-bro-toast]').forEach(n => n.remove());
    const d = document.createElement('div');
    d.setAttribute('role', 'status'); d.setAttribute('data-bro-toast', '1');
    d.style.cssText = 'position:fixed;left:50%;bottom:calc(90px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);max-width:80vw;padding:10px 16px;border-radius:14px;background:rgba(15,23,42,.92);color:#fff;font-size:14px;z-index:30000;text-align:center';
    if (window.BroDots) BroDots.set(d, msg); else d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2800);
  }

  // src: 画像/動画のURL(blob: も可)。isVideo: 動画か
  async function save(src, isVideo) {
    if (!src) return false;
    toast('保存の準備中...');
    let blob;
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(String(res.status));
      blob = await res.blob();
    } catch (e) {
      console.error('[mediaSave] fetch', e);
      // 読み込めない時の最後の手段: そのURLをそのまま開かせる(ブラウザ側の保存・共有に任せる)
      try {
        const a = document.createElement('a');
        a.href = src; a.download = 'brochat_' + Date.now() + (isVideo ? '.mp4' : '.jpg'); a.target = '_blank'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        toast('保存を試しています。出ない場合は画像を長押ししてください');
      } catch (e2) { toast('保存できませんでした(通信エラー)'); }
      return false;
    }
    let type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : (isVideo ? 'video/mp4' : 'image/jpeg');
    const name = 'brochat_' + Date.now() + '.' + (EXT[type] || (isVideo ? 'mp4' : 'jpg'));
    const file = new File([blob], name, { type });
    // アプリ(APK)のWebViewは <a download> も共有シートも効かない。アプリ側に用意した保存機能で
    // 端末の「写真(Pictures/BroChat)」「動画(Movies/BroChat)」に直接書き込む
    const bc = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.BroCall;
    if (window.Capacitor && bc && typeof bc.saveChunk === 'function') {
      try {
        const id = 's' + Date.now() + Math.random().toString(36).slice(2, 8);
        const CH = 3 * 170000; // 3の倍数(base64を区切っても繋がる)
        const b64 = (blobPart) => new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(',')[1] || '');
          fr.onerror = () => rej(fr.error || new Error('read'));
          fr.readAsDataURL(blobPart);
        });
        for (let off = 0; off < file.size || off === 0; off += CH) {
          const end = Math.min(off + CH, file.size);
          await bc.saveChunk({ id, name, mime: type, data: await b64(file.slice(off, end)), first: off === 0, last: end >= file.size });
          if (end >= file.size) break;
        }
        toast(isVideo ? '動画を保存しました(ギャラリー)' : '画像を保存しました(ギャラリー)');
        return true;
      } catch (e) {
        console.error('[mediaSave] native', e);
        toast('保存できませんでした: ' + (e && e.message ? e.message : e));
        return false;
      }
    }
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      toast('この機能はアプリの更新が必要です(最新のAPKを入れてください)');
      return false;
    }
    // スマホは共有シート → 写真アプリ・ファイルに保存できる
    try {
      if (mobile() && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        toast('共有シートから「保存」を選んでください');
        return true;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return false; // 共有シートを閉じただけ
      console.error('[mediaSave] share', e);
    }
    try {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast('ダウンロードしました');
      return true;
    } catch (e) {
      console.error('[mediaSave] download', e);
      toast('保存できませんでした');
      return false;
    }
  }
  window.BroMediaSave = { save };
})();
