// stampMaker.js
// スタンプを作る(LINEのスタンプメーカーと同じ流れ)。stamps.js から必要な時だけ読み込まれる。
//   写真 / 手書き / 文字 から作る → 位置と大きさ → 背景を自動で切り抜き・消しゴム・ペン・文字・白フチ → 名前を付けて保存
//   作ったスタンプはセット(パック)にまとめて、公開するとショップに並ぶ(全部無料)。
// 画像は 320x320 の透過PNGにしてから送る(端末の中で作るので、元の写真はサーバーに行かない)。
(function () {
  if (window.BroStampMaker) return;
  const S = 320; // 出来上がりの大きさ

  function open(K) {
    const { api, toast, h, btn, ICON, overlay, tr } = K;
    K.css();
    if (!document.getElementById('bstk-mk-css')) {
      const st = document.createElement('style');
      st.id = 'bstk-mk-css';
      st.textContent =
        '.bmk-src{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:6px 0 14px}' +
        '.bmk-src button,.bmk-src label{display:flex;flex-direction:column;align-items:center;gap:6px;border:0;border-radius:14px;background:var(--fld);padding:14px 6px;font-size:13px;font-weight:700;cursor:pointer;color:var(--fg)}' +
        '.bmk-stage{position:relative;margin:0 auto;width:min(86vw,340px);height:min(86vw,340px);border-radius:14px;overflow:hidden;touch-action:none;' +
        'background-color:#fff;background-image:linear-gradient(45deg,#e5e7eb 25%,transparent 25%,transparent 75%,#e5e7eb 75%),linear-gradient(45deg,#e5e7eb 25%,transparent 25%,transparent 75%,#e5e7eb 75%);background-size:20px 20px;background-position:0 0,10px 10px;box-shadow:inset 0 0 0 1px var(--line)}' +
        'html.dark-mode .bmk-stage{background-color:#475569;background-image:linear-gradient(45deg,#334155 25%,transparent 25%,transparent 75%,#334155 75%),linear-gradient(45deg,#334155 25%,transparent 25%,transparent 75%,#334155 75%)}' +
        '.bmk-stage canvas{position:absolute;inset:0;width:100%;height:100%}' +
        '.bmk-tools{display:flex;gap:6px;overflow-x:auto;padding:12px 2px 6px;scrollbar-width:none}.bmk-tools::-webkit-scrollbar{display:none}' +
        '.bmk-tools button{flex:none;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:58px;border:0;border-radius:12px;background:var(--fld);padding:8px 6px;font-size:11px;font-weight:700;cursor:pointer}' +
        '.bmk-tools button.on{background:var(--fg);color:var(--bg)}' +
        '.bmk-opt{display:flex;align-items:center;gap:10px;padding:6px 2px;font-size:13px;font-weight:700;color:var(--sub)}' +
        '.bmk-opt input[type=range]{flex:1}' +
        '.bmk-cols{display:flex;gap:6px;flex-wrap:wrap;padding:4px 2px}' +
        '.bmk-cols button{width:28px;height:28px;border-radius:50%;border:2px solid rgba(0,0,0,.15);cursor:pointer;padding:0}' +
        '.bmk-cols button.on{outline:3px solid var(--acc);outline-offset:2px}' +
        '.bmk-row2{display:flex;gap:8px;margin-top:10px}.bmk-row2 button{flex:1}' +
        '.bmk-field{display:block;width:100%;box-sizing:border-box;margin:4px 0 10px}' +
        '.bmk-lbl{font-size:12px;font-weight:800;color:var(--sub);margin:8px 2px 2px}' +
        '.bmk-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}' +
        '.bmk-cell{position:relative;aspect-ratio:1;border:0;border-radius:12px;background:var(--fld);padding:4px;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
        '.bmk-cell img{width:100%;height:100%;object-fit:contain;display:block}' +
        '.bmk-cell .n{position:absolute;left:5px;top:3px;font-size:10px;font-weight:800;color:var(--sub)}' +
        '.bmk-note{font-size:12px;color:var(--sub);line-height:1.6;margin:8px 2px}';
      document.head.appendChild(st);
    }
    const ov = overlay({ full: true, title: tr('stamp_make', 'スタンプを作る'), onClose: () => K.onSaved && K.onSaved() });
    let packs = [];

    // ---- 自分が作ったセットの一覧 ----
    function drawList(sc) {
      const top = btn('bstk-banner', ICON.plus + '<span><b>' + tr('stamp_new_set', '新しいスタンプセット') + '</b><small>' + tr('stamp_new_set_sub', '1セットに40個まで入れられます') + '</small></span>', null, newPack);
      sc.appendChild(top);
      const list = h('div'); sc.appendChild(list);
      const e = h('div', 'bstk-empty'); e.textContent = '…'; list.appendChild(e);
      api('/api/stickers/created').then(j => {
        packs = j.packs || [];
        list.innerHTML = '';
        if (!packs.length) { const e2 = h('div', 'bstk-empty'); e2.textContent = tr('stamp_make_empty', 'まだ作ったスタンプはありません'); list.appendChild(e2); return; }
        packs.forEach(p => {
          const row = h('div', 'bstk-row');
          const cv = h('div', 'cv');
          if (p.cover) { const im = document.createElement('img'); im.src = p.cover; im.alt = ''; cv.appendChild(im); }
          const tx = h('div', 'tx'); const t1 = h('div', 't1'); t1.textContent = p.title;
          const t2 = h('div', 't2'); t2.textContent = p.count + tr('stamp_count_unit', '個') + ' ・ ' + (p.isPublic ? tr('stamp_public', '公開中') + ' ・ ' + p.addCount + tr('stamp_users', '人が追加') : tr('stamp_private', '非公開'));
          tx.appendChild(t1); tx.appendChild(t2);
          row.appendChild(cv); row.appendChild(tx);
          row.addEventListener('click', () => ov.push(p.title, drawPack(p.id)));
          list.appendChild(row);
        });
      }).catch(err => { list.innerHTML = ''; toast(err.message); });
    }
    async function newPack() {
      const title = (prompt(tr('stamp_set_name', 'スタンプセットの名前'), '') || '').trim();
      if (!title) return;
      try {
        const p = await api('/api/stickers/packs', 'POST', { title, isPublic: false });
        ov.push(p.title, drawPack(p.id));
      } catch (e) { toast(e.message); }
    }

    // ---- 1セットの編集 ----
    function drawPack(id) {
      return sc => {
        const e = h('div', 'bstk-empty'); e.textContent = '…'; sc.appendChild(e);
        api('/api/stickers/packs/' + id).then(p => {
          sc.innerHTML = '';
          (p.stickers || []).forEach(K.putMeta);
          const l1 = h('div', 'bmk-lbl'); l1.textContent = tr('stamp_set_name', 'スタンプセットの名前'); sc.appendChild(l1);
          const ti = h('input', 'bstk-in bmk-field'); ti.maxLength = 40; ti.value = p.title; sc.appendChild(ti);
          const l2 = h('div', 'bmk-lbl'); l2.textContent = tr('stamp_set_desc', '説明(なくてもOK)'); sc.appendChild(l2);
          const di = h('input', 'bstk-in bmk-field'); di.maxLength = 200; di.value = p.description || ''; sc.appendChild(di);
          const save = async (body) => { try { await api('/api/stickers/packs/' + id, 'PATCH', body); } catch (er) { toast(er.message); } };
          ti.addEventListener('change', () => { if (ti.value.trim()) { save({ title: ti.value.trim() }); ov.title.textContent = ti.value.trim(); } });
          di.addEventListener('change', () => save({ description: di.value }));
          const sw = h('div', 'bstk-sw');
          const t = h('div'); t.textContent = tr('stamp_publish', 'ショップに公開する'); const sm = h('small'); sm.textContent = tr('stamp_publish_sub', 'オンにすると、誰でも無料で追加できます'); t.appendChild(sm);
          let pub = p.isPublic;
          const tg = btn('bstk-tg' + (pub ? ' on' : ''), '', tr('stamp_publish', 'ショップに公開する'), () => { pub = !pub; tg.classList.toggle('on', pub); save({ isPublic: pub }); });
          tg.setAttribute('role', 'switch');
          sw.appendChild(t); sw.appendChild(tg); sc.appendChild(sw);

          const l3 = h('div', 'bmk-lbl'); l3.textContent = tr('stamp_items', 'スタンプ') + ' (' + p.stickers.length + '/40)'; l3.style.marginTop = '16px'; sc.appendChild(l3);
          const g = h('div', 'bmk-grid');
          p.stickers.forEach((s, i) => {
            const c = btn('bmk-cell', '', s.label || String(i + 1));
            const im = document.createElement('img'); im.src = s.url; im.alt = ''; c.appendChild(im);
            const n = h('span', 'n'); n.textContent = String(i + 1); c.appendChild(n);
            c.addEventListener('click', () => ov.push(s.label || tr('stamp_items', 'スタンプ'), drawSticker(p, s, i)));
            g.appendChild(c);
          });
          if (p.stickers.length < 40) {
            const add = btn('bmk-cell', ICON.plus, tr('stamp_add_item', 'スタンプを追加'), () => ov.push(tr('stamp_add_item', 'スタンプを追加'), drawEditor(p)));
            g.appendChild(add);
          }
          sc.appendChild(g);
          const note = h('div', 'bmk-note');
          note.textContent = tr('stamp_make_note', '1番目のスタンプがショップやタブのアイコンになります。他の人の写真や、著作権のある絵は使わないでください。');
          sc.appendChild(note);
          const del = btn('bstk-link', '', null, async () => {
            if (!confirm(tr('stamp_delete_set_confirm', 'このスタンプセットを削除しますか?(送ったスタンプはトークに残ります)'))) return;
            try { await api('/api/stickers/packs/' + id, 'DELETE'); toast(tr('stamp_deleted', '削除しました')); ov.back(); ov.redraw(); } catch (er) { toast(er.message); }
          });
          del.textContent = tr('stamp_delete_set', 'このスタンプセットを削除'); del.style.color = '#ef4444';
          sc.appendChild(del);
        }).catch(er => { sc.innerHTML = ''; toast(er.message); });
      };
    }

    // ---- 1個の詳細(名前・キーワード・並び・削除) ----
    function drawSticker(p, s, i) {
      return sc => {
        const big = h('div'); big.style.cssText = 'width:200px;height:200px;margin:0 auto 10px';
        const im = document.createElement('img'); im.src = s.url; im.alt = ''; im.style.cssText = 'width:100%;height:100%;object-fit:contain';
        big.appendChild(im); sc.appendChild(big);
        const l1 = h('div', 'bmk-lbl'); l1.textContent = tr('stamp_item_label', '名前(サジェストに使う言葉)'); sc.appendChild(l1);
        const li = h('input', 'bstk-in bmk-field'); li.maxLength = 20; li.value = s.label || ''; sc.appendChild(li);
        const l2 = h('div', 'bmk-lbl'); l2.textContent = tr('stamp_item_kw', '検索キーワード(、で区切る)'); sc.appendChild(l2);
        const ki = h('input', 'bstk-in bmk-field'); ki.maxLength = 200; ki.value = (s.keywords || []).join('、'); sc.appendChild(ki);
        const row = h('div', 'bmk-row2');
        const mv = async d => {
          const ids = p.stickers.map(x => x.id); const j = i + d; if (j < 0 || j >= ids.length) return;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          try { await api('/api/stickers/packs/' + p.id, 'PATCH', { order: ids }); ov.back(); ov.redraw(); } catch (e) { toast(e.message); }
        };
        const a = btn('bstk-big done', '', null, () => mv(-1)); a.textContent = tr('stamp_move_front', '前へ'); a.style.color = 'var(--fg)'; a.disabled = i === 0;
        const b = btn('bstk-big done', '', null, () => mv(1)); b.textContent = tr('stamp_move_back', '後ろへ'); b.style.color = 'var(--fg)'; b.disabled = i === p.stickers.length - 1;
        row.appendChild(a); row.appendChild(b); sc.appendChild(row);
        const ok = btn('bstk-big', '', null, async () => {
          try { await api('/api/stickers/packs/' + p.id + '/stickers/' + s.id, 'PATCH', { label: li.value, keywords: ki.value }); toast(tr('stamp_saved', '保存しました')); ov.back(); ov.redraw(); } catch (e) { toast(e.message); }
        });
        ok.textContent = tr('save', '保存'); sc.appendChild(ok);
        const del = btn('bstk-link', '', null, async () => {
          if (!confirm(tr('stamp_delete_item_confirm', 'このスタンプを削除しますか?'))) return;
          try { await api('/api/stickers/packs/' + p.id + '/stickers/' + s.id, 'DELETE'); ov.back(); ov.redraw(); } catch (e) { toast(e.message); }
        });
        del.textContent = tr('stamp_delete_item', 'このスタンプを削除'); del.style.color = '#ef4444'; sc.appendChild(del);
      };
    }

    // ---- エディター ----
    function drawEditor(pack) {
      return sc => {
        const src = h('div', 'bmk-src');
        const fileL = h('label', '', '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' + tr('stamp_src_photo', '写真から'));
        const fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.hidden = true; fileL.appendChild(fi);
        const drawB = btn('', '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.6 7.6"/><circle cx="11" cy="11" r="2"/></svg>' + tr('stamp_src_draw', '手書き'), null, () => start(null, 'pen'));
        const textB = btn('', '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>' + tr('stamp_src_text', '文字だけ'), null, () => start(null, 'text'));
        src.appendChild(fileL); src.appendChild(drawB); src.appendChild(textB);
        sc.appendChild(src);
        const area = h('div'); sc.appendChild(area);
        const note = h('div', 'bmk-note'); note.textContent = tr('stamp_make_hint', '写真は、背景がシンプルなほど自動の切り抜きがきれいになります。GIFは動きをそのまま使えます。'); area.appendChild(note);

        fi.addEventListener('change', () => {
          const f = fi.files && fi.files[0]; fi.value = '';
          if (!f) return;
          if (f.type === 'image/gif' && f.size <= 780 * 1024) {
            // 動くGIF: 加工せずにそのまま使うか選ぶ
            if (confirm(tr('stamp_gif_keep', '動くGIFです。動きをそのまま使いますか?(「キャンセル」で1枚の絵として編集)'))) { gifFlow(f); return; }
          }
          const url = URL.createObjectURL(f);
          const im = new Image();
          im.onload = () => start(im, 'move');
          im.onerror = () => toast(tr('stamp_img_bad', 'この画像は読み込めませんでした'));
          im.src = url;
        });

        function gifFlow(f) {
          const rd = new FileReader();
          rd.onload = () => { area.innerHTML = ''; finishForm(area, rd.result); };
          rd.readAsDataURL(f);
        }

        // 編集画面本体
        function start(img, tool) {
          src.style.display = 'none';
          area.innerHTML = '';
          const stage = h('div', 'bmk-stage');
          const view = document.createElement('canvas');
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          view.width = S * dpr; view.height = S * dpr;
          stage.appendChild(view);
          area.appendChild(stage);
          const vg = view.getContext('2d');

          // レイヤー: base(写真を置いた結果) / orig(切り抜き前) / ink(ペン) / texts(文字)
          const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
          const base = mk(), orig = mk(), ink = mk();
          const bg = base.getContext('2d'), og = orig.getContext('2d'), ig = ink.getContext('2d');
          let texts = [];
          let outline = true;
          let color = '#ff4d6d';
          let penColor = '#3b2a20';
          let size = 18;
          let tol = 38;
          let cur = img ? 'move' : tool;
          // 写真の置き方(位置を決める段階)
          const T = { x: S / 2, y: S / 2, s: 1, r: 0 };
          let placing = !!img;
          if (img) { T.s = Math.min(S / img.width, S / img.height) * .92; }
          const undo = [];
          function snap() { undo.push({ b: bg.getImageData(0, 0, S, S), i: ig.getImageData(0, 0, S, S), t: JSON.parse(JSON.stringify(texts)), o: outline }); if (undo.length > 20) undo.shift(); }
          function bake() {
            bg.clearRect(0, 0, S, S); og.clearRect(0, 0, S, S);
            if (!img) return;
            [bg, og].forEach(g => { g.save(); g.translate(T.x, T.y); g.rotate(T.r); g.scale(T.s, T.s); g.drawImage(img, -img.width / 2, -img.height / 2); g.restore(); });
          }
          bake();

          // 合成(表示と書き出しで同じ処理)
          function compose(g, scale, forExport) {
            const tmp = mk(); const tg = tmp.getContext('2d');
            tg.drawImage(base, 0, 0); tg.drawImage(ink, 0, 0);
            texts.forEach(t => drawText(tg, t));
            g.save(); g.scale(scale, scale); g.clearRect(0, 0, S, S);
            if (outline && !placing) {
              const sil = mk(); const sg = sil.getContext('2d');
              sg.drawImage(tmp, 0, 0); sg.globalCompositeOperation = 'source-in'; sg.fillStyle = '#fff'; sg.fillRect(0, 0, S, S);
              const r = 6;
              for (let a = 0; a < 16; a++) { const an = a / 16 * Math.PI * 2; g.drawImage(sil, Math.cos(an) * r, Math.sin(an) * r); }
              g.drawImage(sil, 0, 0);
            }
            g.drawImage(tmp, 0, 0);
            if (!forExport && placing) { g.strokeStyle = 'rgba(6,199,85,.8)'; g.lineWidth = 2; g.setLineDash([6, 6]); g.strokeRect(10, 10, S - 20, S - 20); }
            if (!forExport && cur === 'move' && !placing && selText) { const b = textBox(selText); g.strokeStyle = 'rgba(6,199,85,.9)'; g.lineWidth = 2; g.setLineDash([5, 4]); g.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8); }
            g.restore();
          }
          function drawText(g, t) {
            g.save();
            g.font = '900 ' + t.size + 'px ' + "'M PLUS Rounded 1c','Hiragino Maru Gothic ProN','Hiragino Sans','Noto Sans JP',system-ui,sans-serif";
            g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
            g.translate(t.x, t.y); g.rotate(t.r || 0);
            const lines = String(t.text).split('\n');
            lines.forEach((ln, i) => {
              const y = (i - (lines.length - 1) / 2) * t.size * 1.15;
              // 外側に濃い縁、内側に白い縁(LINEのスタンプの文字と同じ見え方)
              g.lineWidth = Math.max(6, t.size * .34); g.strokeStyle = '#3b2a20'; g.strokeText(ln, 0, y);
              g.lineWidth = Math.max(3, t.size * .16); g.strokeStyle = t.color === '#ffffff' ? '#3b2a20' : '#ffffff'; g.strokeText(ln, 0, y);
              g.fillStyle = t.color; g.fillText(ln, 0, y);
            });
            g.restore();
          }
          function textBox(t) {
            const c = document.createElement('canvas').getContext('2d');
            c.font = '900 ' + t.size + 'px sans-serif';
            const lines = String(t.text).split('\n');
            const w = Math.max.apply(null, lines.map(l => c.measureText(l).width));
            const hh = lines.length * t.size * 1.15;
            return { x: t.x - w / 2, y: t.y - hh / 2, w, h: hh };
          }
          let selText = null;
          let raf = 0;
          function paint() { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => compose(vg, dpr, false)); }

          // ---- 操作 ----
          const pts = new Map();
          let last = null, gesture = null;
          const toLocal = e => { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * S, y: (e.clientY - r.top) / r.height * S }; };
          function brush(p, q) {
            if (cur === 'pen') {
              ig.strokeStyle = penColor; ig.lineWidth = size * .5; ig.lineCap = ig.lineJoin = 'round';
              ig.beginPath(); ig.moveTo(q.x, q.y); ig.lineTo(p.x, p.y); ig.stroke();
            } else if (cur === 'erase') {
              [bg, ig].forEach(g => { g.save(); g.globalCompositeOperation = 'destination-out'; g.lineWidth = size; g.lineCap = 'round'; g.beginPath(); g.moveTo(q.x, q.y); g.lineTo(p.x, p.y); g.stroke(); g.restore(); });
            } else if (cur === 'restore') {
              bg.save(); bg.beginPath(); bg.lineWidth = size; bg.lineCap = 'round';
              // 線に沿った円を並べてクリップし、その形だけ元の写真を戻す
              const d = Math.hypot(p.x - q.x, p.y - q.y), n = Math.max(1, Math.ceil(d / 3));
              for (let k = 0; k <= n; k++) { const x = q.x + (p.x - q.x) * k / n, y = q.y + (p.y - q.y) * k / n; bg.moveTo(x + size / 2, y); bg.arc(x, y, size / 2, 0, Math.PI * 2); }
              bg.clip(); bg.drawImage(orig, 0, 0); bg.restore();
            }
          }
          view.addEventListener('pointerdown', e => {
            view.setPointerCapture(e.pointerId);
            const p = toLocal(e);
            pts.set(e.pointerId, p);
            if (pts.size === 2 && (placing || (cur === 'move' && selText))) {
              const [a, b] = Array.from(pts.values());
              const tgt = placing ? T : selText;
              gesture = { d: Math.hypot(a.x - b.x, a.y - b.y), an: Math.atan2(b.y - a.y, b.x - a.x), s: placing ? T.s : selText.size, r: tgt.r || 0 };
              return;
            }
            last = p;
            if (placing) return;
            if (cur === 'move') {
              selText = null;
              for (let i = texts.length - 1; i >= 0; i--) { const bx = textBox(texts[i]); if (p.x >= bx.x - 10 && p.x <= bx.x + bx.w + 10 && p.y >= bx.y - 10 && p.y <= bx.y + bx.h + 10) { selText = texts[i]; break; } }
              if (selText) snap();
              paint(); syncOpts();
              return;
            }
            if (cur === 'pen' || cur === 'erase' || cur === 'restore') { snap(); brush(p, { x: p.x + .01, y: p.y }); paint(); }
          });
          view.addEventListener('pointermove', e => {
            if (!pts.has(e.pointerId)) return;
            const p = toLocal(e);
            pts.set(e.pointerId, p);
            if (gesture && pts.size >= 2) {
              const [a, b] = Array.from(pts.values());
              const k = Math.hypot(a.x - b.x, a.y - b.y) / (gesture.d || 1);
              const dr = Math.atan2(b.y - a.y, b.x - a.x) - gesture.an;
              if (placing) { T.s = Math.max(.02, gesture.s * k); T.r = gesture.r + dr; bake(); }
              else if (selText) { selText.size = Math.max(14, Math.min(160, gesture.s * k)); selText.r = gesture.r + dr; }
              paint(); return;
            }
            if (!last) return;
            if (placing) { T.x += p.x - last.x; T.y += p.y - last.y; bake(); }
            else if (cur === 'move' && selText) { selText.x += p.x - last.x; selText.y += p.y - last.y; }
            else brush(p, last);
            last = p; paint();
          });
          const up = e => { pts.delete(e.pointerId); if (pts.size < 2) gesture = null; if (!pts.size) last = null; };
          view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
          view.addEventListener('wheel', e => {
            if (!placing) return; e.preventDefault();
            T.s *= e.deltaY < 0 ? 1.06 : 1 / 1.06; bake(); paint();
          }, { passive: false });

          // ---- 背景の自動切り抜き(端から似た色をたどって透明にする) ----
          function autoCut() {
            snap();
            const id = og.getImageData(0, 0, S, S);
            const cutd = bg.getImageData(0, 0, S, S);
            const d = id.data, out = cutd.data;
            const seen = new Uint8Array(S * S);
            const q = new Int32Array(S * S);
            let qh = 0, qt = 0;
            const t2 = tol * tol * 3;
            // 4辺の点を種にする(透明な所は種にしない)
            const seeds = [];
            for (let i = 0; i < S; i += 2) seeds.push(i, (S - 1) * S + i, i * S, i * S + S - 1);
            const ref = new Int32Array(S * S * 3); // それぞれの点が、どの種の色を基準にたどったか
            // 透明な所(写真の外側)もたどる。透明な所から写真に入った最初の点は、その点の色を背景色として扱う
            const clear = new Uint8Array(S * S);
            seeds.forEach(sidx => {
              if (seen[sidx]) return;
              seen[sidx] = 1; q[qt++] = sidx;
              if (d[sidx * 4 + 3] < 20) { clear[sidx] = 1; return; }
              ref[sidx * 3] = d[sidx * 4]; ref[sidx * 3 + 1] = d[sidx * 4 + 1]; ref[sidx * 3 + 2] = d[sidx * 4 + 2];
            });
            while (qh < qt) {
              const i = q[qh++];
              out[i * 4 + 3] = 0;
              const x = i % S, y = (i / S) | 0;
              const fromClear = clear[i];
              const rr = ref[i * 3], rg = ref[i * 3 + 1], rb = ref[i * 3 + 2];
              const nb = [x > 0 ? i - 1 : -1, x < S - 1 ? i + 1 : -1, y > 0 ? i - S : -1, y < S - 1 ? i + S : -1];
              for (let k = 0; k < 4; k++) {
                const j = nb[k]; if (j < 0 || seen[j]) continue;
                if (d[j * 4 + 3] < 20) { seen[j] = 1; clear[j] = 1; q[qt++] = j; continue; }
                if (fromClear) {
                  seen[j] = 1; q[qt++] = j;
                  ref[j * 3] = d[j * 4]; ref[j * 3 + 1] = d[j * 4 + 1]; ref[j * 3 + 2] = d[j * 4 + 2];
                  continue;
                }
                const dr = d[j * 4] - rr, dg = d[j * 4 + 1] - rg, db = d[j * 4 + 2] - rb;
                if (dr * dr + dg * dg + db * db <= t2) {
                  seen[j] = 1; q[qt++] = j;
                  // 基準色を少しずつ近くの色に寄せる(グラデーションの背景も追える)
                  ref[j * 3] = (rr * 3 + d[j * 4]) >> 2; ref[j * 3 + 1] = (rg * 3 + d[j * 4 + 1]) >> 2; ref[j * 3 + 2] = (rb * 3 + d[j * 4 + 2]) >> 2;
                }
              }
            }
            // ふちのギザギザを少しなめらかに(透明に接している点を半透明に)
            for (let i = 0; i < S * S; i++) {
              if (out[i * 4 + 3] === 0) continue;
              const x = i % S, y = (i / S) | 0;
              let n = 0;
              if (x > 0 && out[(i - 1) * 4 + 3] === 0) n++;
              if (x < S - 1 && out[(i + 1) * 4 + 3] === 0) n++;
              if (y > 0 && out[(i - S) * 4 + 3] === 0) n++;
              if (y < S - 1 && out[(i + S) * 4 + 3] === 0) n++;
              if (n) out[i * 4 + 3] = Math.min(out[i * 4 + 3], 255 - n * 50);
            }
            bg.putImageData(cutd, 0, 0);
            paint();
          }

          // ---- 道具 ----
          const tools = h('div', 'bmk-tools');
          const opts = h('div');
          const TOOLS = [
            ['move', tr('stamp_tool_move', '移動'), '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg>'],
            ['cut', tr('stamp_tool_cut', '自動切り抜き'), '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/></svg>'],
            ['erase', tr('stamp_tool_erase', '消しゴム'), '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H7L3 16a2 2 0 0 1 0-3L13 3a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3L11 21"/></svg>'],
            ['restore', tr('stamp_tool_restore', '元に戻す筆'), '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>'],
            ['pen', tr('stamp_tool_pen', 'ペン'), '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>'],
            ['text', tr('stamp_tool_text', '文字'), '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>'],
            ['outline', tr('stamp_tool_outline', '白フチ'), '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>'],
            ['undo', tr('stamp_tool_undo', '取り消し'), '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>'],
          ];
          const tb = {};
          TOOLS.forEach(([k, t, ic]) => {
            const b = btn('', ic + t, t, () => onTool(k));
            tb[k] = b; tools.appendChild(b);
          });
          function onTool(k) {
            if (k === 'undo') { const u = undo.pop(); if (u) { bg.putImageData(u.b, 0, 0); ig.putImageData(u.i, 0, 0); texts = u.t; outline = u.o; selText = null; paint(); syncTools(); } return; }
            if (k === 'outline') { snap(); outline = !outline; paint(); syncTools(); return; }
            if (k === 'cut') { if (!img) { toast(tr('stamp_cut_need_photo', '写真の時だけ使えます')); return; } cur = 'cut'; syncTools(); syncOpts(); autoCut(); return; }
            if (k === 'text') {
              const v = (prompt(tr('stamp_text_ph', '入れる文字(改行は / )'), '') || '').trim();
              if (!v) return;
              snap();
              const t = { text: v.split('/').join('\n').slice(0, 40), x: S / 2, y: texts.length ? S * .2 : (img ? S * .82 : S / 2), size: img ? 46 : 64, color, r: -0.06 };
              texts.push(t); selText = t; cur = 'move'; paint(); syncTools(); syncOpts();
              return;
            }
            cur = k; syncTools(); syncOpts(); paint();
          }
          function syncTools() {
            Object.keys(tb).forEach(k => tb[k].classList.toggle('on', k === cur || (k === 'outline' && outline)));
          }
          const COLS = ['#3b2a20', '#ffffff', '#ff4d6d', '#ff9f1c', '#ffd23f', '#3cbf6b', '#3d8fff', '#8c7bff', '#000000'];
          function syncOpts() {
            opts.innerHTML = '';
            if (cur === 'cut') {
              const o = h('div', 'bmk-opt'); o.textContent = tr('stamp_cut_tol', 'どこまで消すか');
              const r = document.createElement('input'); r.type = 'range'; r.min = 8; r.max = 90; r.value = tol;
              r.addEventListener('change', () => { tol = +r.value; const u = undo.pop(); if (u) { bg.putImageData(u.b, 0, 0); } autoCut(); });
              o.appendChild(r); opts.appendChild(o);
              const n = h('div', 'bmk-note'); n.textContent = tr('stamp_cut_note', '残したい所まで消えた時は「元に戻す筆」でなぞると戻ります。'); opts.appendChild(n);
            }
            if (cur === 'erase' || cur === 'restore' || cur === 'pen') {
              const o = h('div', 'bmk-opt'); o.textContent = tr('stamp_brush', '太さ');
              const r = document.createElement('input'); r.type = 'range'; r.min = 4; r.max = 60; r.value = size;
              r.addEventListener('input', () => { size = +r.value; });
              o.appendChild(r); opts.appendChild(o);
            }
            if (cur === 'pen' || (cur === 'move' && selText)) {
              const cs = h('div', 'bmk-cols');
              COLS.forEach(c => {
                const on = cur === 'pen' ? penColor === c : selText && selText.color === c;
                const b = btn(on ? 'on' : '', '', c, () => {
                  if (cur === 'pen') penColor = c; else if (selText) { snap(); selText.color = c; color = c; paint(); }
                  syncOpts();
                });
                b.style.background = c; cs.appendChild(b);
              });
              opts.appendChild(cs);
            }
            if (cur === 'move' && selText) {
              const o = h('div', 'bmk-opt'); o.textContent = tr('stamp_text_size', '文字の大きさ');
              const r = document.createElement('input'); r.type = 'range'; r.min = 14; r.max = 160; r.value = selText.size;
              r.addEventListener('input', () => { selText.size = +r.value; paint(); });
              o.appendChild(r); opts.appendChild(o);
              const row = h('div', 'bmk-row2');
              const ed = btn('bstk-big done', '', null, () => { const v = prompt(tr('stamp_text_ph', '入れる文字(改行は / )'), selText.text.split('\n').join('/')); if (v != null && v.trim()) { snap(); selText.text = v.trim().split('/').join('\n').slice(0, 40); paint(); } });
              ed.textContent = tr('edit', '編集'); ed.style.color = 'var(--fg)';
              const rm = btn('bstk-big done', '', null, () => { snap(); texts = texts.filter(t => t !== selText); selText = null; paint(); syncOpts(); });
              rm.textContent = tr('delete', '削除'); rm.style.color = '#ef4444';
              row.appendChild(ed); row.appendChild(rm); opts.appendChild(row);
            } else if (cur === 'move' && !placing) {
              const n = h('div', 'bmk-note'); n.textContent = tr('stamp_move_note', '文字をドラッグで動かせます。2本指で大きさと向きも変えられます。'); opts.appendChild(n);
            }
          }

          // 位置決めの段階(写真の時だけ)
          const place = h('div');
          if (placing) {
            const n = h('div', 'bmk-note'); n.textContent = tr('stamp_place_note', 'ドラッグで移動、2本指(PCはホイール)で大きさと向き。緑の枠の中に収めると、きれいに仕上がります。');
            const o1 = h('div', 'bmk-opt'); o1.textContent = tr('stamp_zoom', '大きさ');
            const z = document.createElement('input'); z.type = 'range'; z.min = 5; z.max = 400; z.value = Math.round(T.s / (Math.min(S / img.width, S / img.height)) * 100);
            z.addEventListener('input', () => { T.s = Math.min(S / img.width, S / img.height) * z.value / 100; bake(); paint(); });
            o1.appendChild(z);
            const o2 = h('div', 'bmk-opt'); o2.textContent = tr('stamp_rotate', '回転');
            const rr = document.createElement('input'); rr.type = 'range'; rr.min = -180; rr.max = 180; rr.value = 0;
            rr.addEventListener('input', () => { T.r = rr.value * Math.PI / 180; bake(); paint(); });
            o2.appendChild(rr);
            const next = btn('bstk-big', '', null, () => {
              placing = false; place.remove(); area.appendChild(tools); area.appendChild(opts); area.appendChild(doneRow);
              cur = 'cut'; syncTools(); syncOpts(); autoCut();
            });
            next.textContent = tr('next', '次へ');
            place.appendChild(n); place.appendChild(o1); place.appendChild(o2); place.appendChild(next);
            area.appendChild(place);
          }
          const doneRow = h('div');
          const fin = btn('bstk-big', '', null, () => {
            selText = null;
            const out = document.createElement('canvas'); out.width = out.height = S;
            compose(out.getContext('2d'), 1, true);
            // 空っぽは保存しない
            const px = out.getContext('2d').getImageData(0, 0, S, S).data;
            let any = false; for (let i = 3; i < px.length; i += 16) if (px[i] > 10) { any = true; break; }
            if (!any) { toast(tr('stamp_empty_img', '何も描かれていません')); return; }
            let url = out.toDataURL('image/png');
            if (url.length > 1000000) url = out.toDataURL('image/webp', .92);
            area.innerHTML = '';
            finishForm(area, url, texts.map(t => t.text.replace(/\n/g, '')).join(''));
          });
          fin.textContent = tr('stamp_finish', '完成');
          doneRow.appendChild(fin);
          if (!placing) { area.appendChild(tools); area.appendChild(opts); area.appendChild(doneRow); }
          if (!img) { outline = true; }
          syncTools(); syncOpts(); paint();
          if (tool === 'text') setTimeout(() => onTool('text'), 50);
        }

        // 名前を付けて保存
        function finishForm(box, dataUrl, guess) {
          const big = h('div'); big.style.cssText = 'width:200px;height:200px;margin:0 auto 10px;border-radius:14px';
          const im = document.createElement('img'); im.src = dataUrl; im.alt = ''; im.style.cssText = 'width:100%;height:100%;object-fit:contain';
          big.appendChild(im); box.appendChild(big);
          const l1 = h('div', 'bmk-lbl'); l1.textContent = tr('stamp_item_label', '名前(サジェストに使う言葉)'); box.appendChild(l1);
          const li = h('input', 'bstk-in bmk-field'); li.maxLength = 20; li.value = (guess || '').slice(0, 20); li.placeholder = tr('stamp_item_label_ph', '例: おはよう'); box.appendChild(li);
          const l2 = h('div', 'bmk-lbl'); l2.textContent = tr('stamp_item_kw', '検索キーワード(、で区切る)'); box.appendChild(l2);
          const ki = h('input', 'bstk-in bmk-field'); ki.maxLength = 200; ki.placeholder = tr('stamp_item_kw_ph', '例: おは、朝、morning'); box.appendChild(ki);
          const save = btn('bstk-big', '', null, async () => {
            save.disabled = true; save.textContent = tr('stamp_saving', '保存中…');
            try {
              const s = await api('/api/stickers/packs/' + pack.id + '/stickers', 'POST', { dataUrl, label: li.value, keywords: ki.value });
              K.putMeta(s);
              toast(tr('stamp_saved', '保存しました'));
              ov.back(); ov.redraw();
            } catch (e) { toast(e.message); save.disabled = false; save.textContent = tr('save', '保存'); }
          });
          save.textContent = tr('save', '保存'); box.appendChild(save);
        }
      };
    }

    ov.push(tr('stamp_make', 'スタンプを作る'), drawList);
  }

  window.BroStampMaker = { open };
})();
