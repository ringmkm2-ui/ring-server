// shareTarget.js — Androidの「共有」→ Bro Chat から来た内容を、選んだトークに渡す。
//   talklist.html?share=1 : 送り先を選ぶシートを出す
//   admin.html?share=1    : 文字は入力欄に入れる / 画像は写真送信の流れに乗せる
(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('share') !== '1') return;
  const plugin = () => window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.BroCall;
  const page = location.pathname;

  function whenReady(fn, tries = 40) {
    if (plugin()) return fn(plugin());
    if (tries <= 0) return;
    setTimeout(() => whenReady(fn, tries - 1), 100);
  }

  if (page.endsWith('/talklist.html')) {
    whenReady(async bc => {
      const s = await bc.peekShare();
      if (!s || (!s.text && !s.hasImage)) return;
      let talks = [];
      try { talks = (JSON.parse(localStorage.getItem('talk_cache_' + (localStorage.getItem('ring_userId') || '')) || '{}').merged) || []; } catch (e) {}
      const sheet = document.createElement('div');
      sheet.className = 'cbs show';
      sheet.style.maxHeight = '70dvh';
      sheet.style.overflowY = 'auto';
      const esc = t => String(t || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      sheet.innerHTML = `<div class="cbs-grab"></div>
        <div class="cbs-head"><button class="cbs-cancel" type="button">キャンセル</button><div class="cbs-title">送信先</div><span style="width:72px"></span></div>
        <div style="font-size:13px;color:#64748b;margin:-4px 0 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.hasImage ? '画像' + (s.text ? ' + ' : '') : ''}${esc(s.text || '')}</div>
        <div class="share-list">${talks.filter(t => t.userId).map(t => `
          <button type="button" class="share-row" data-id="${esc(t.userId)}" data-name="${esc(t.displayName || t.name || '')}">
            <span class="share-av">${esc((t.displayName || t.name || '?').slice(0, 1))}</span><span>${esc(t.displayName || t.name || '')}</span>
          </button>`).join('') || '<div style="padding:16px;color:#94a3b8">トークがまだありません</div>'}</div>`;
      const scrim = document.createElement('div');
      scrim.className = 'cbs-scrim show';
      document.body.append(scrim, sheet);
      const close = () => { sheet.remove(); scrim.remove(); history.replaceState(null, '', '/talklist.html'); };
      scrim.onclick = close;
      sheet.querySelector('.cbs-cancel').onclick = () => { bc.takeShare(); close(); };
      sheet.querySelectorAll('.share-row').forEach(b => b.onclick = () => {
        location.href = `/admin.html?userId=${encodeURIComponent(b.dataset.id)}&name=${encodeURIComponent(b.dataset.name)}&share=1`;
      });
    });
  }

  if (page.endsWith('/admin.html')) {
    whenReady(async bc => {
      const s = await bc.takeShare();
      history.replaceState(null, '', location.pathname + location.search.replace(/[?&]share=1/, '').replace(/^&/, '?'));
      if (!s) return;
      if (s.text) {
        const ta = document.getElementById('msgInput');
        ta.value = s.text;
        if (window.fitMsgInput) fitMsgInput();
        ta.focus();
      }
      if (s.image) {
        // fetch(data:)はCSPで弾かれることがあるので自前でBlobにする
        const b64 = s.image.split(',')[1] || '';
        const bin = atob(b64), buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const blob = new Blob([buf], { type: 'image/jpeg' });
        const file = new File([blob], 'shared.jpg', { type: 'image/jpeg' });
        const input = document.getElementById('imgInput');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }
})();
