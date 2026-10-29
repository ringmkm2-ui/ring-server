// reportAttach.js
// バグ報告・通報に画像/動画を付ける部品。選んだファイルは送信ボタンを押した時にまとめてアップロードし、
// 出来たURLを /api/reports の mediaUrls に入れる(最大3つ)。
// 注意: 報告の添付は暗号化しない。運営が中身を確認するため(トーク本文のE2E暗号化とは別)。
(function () {
  const MAX_FILES = 3, MAX_IMG = 10 * 1024 * 1024, MAX_VID = 50 * 1024 * 1024;
  const T = (k, fb) => (window.i18n && i18n.t ? i18n.t(k, fb) : fb);
  const NS = 'http://www.w3.org/2000/svg';

  function icon(paths) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = paths;
    return s;
  }

  function upload(file, onProgress) {
    const type = file.type.startsWith('video/') ? 'video' : 'image';
    return (async () => {
      const fd = new FormData();
      fd.append('file', file, file.name || 'upload');
      if (window.bcCloudinarySign) await window.bcCloudinarySign.apply(fd, 'brochat/reports');
      else fd.append('upload_preset', 'brochat_upload');
      fd.append('folder', 'brochat/reports');
      return fd;
    })().then(fd => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', ev => { if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total); });
      xhr.addEventListener('load', () => {
        let j = null; try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && j && j.secure_url) resolve(j.secure_url);
        else reject(new Error(T('report_attach_failed', '添付のアップロードに失敗しました')));
      });
      xhr.addEventListener('error', () => reject(new Error(T('report_attach_failed', '添付のアップロードに失敗しました'))));
      xhr.open('POST', 'https://api.cloudinary.com/v1_1/a6rxinoz/' + type + '/upload');
      xhr.send(fd);
    }));
  }

  // container: 部品を入れる要素。戻り値 { validate(), uploadAll(onStatus), reset() }
  function mount(container) {
    let files = [];
    container.textContent = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px';
    const add = document.createElement('button');
    add.type = 'button';
    add.style.cssText = 'display:flex;align-items:center;gap:8px;align-self:flex-start;padding:9px 14px;border-radius:12px;border:1px dashed #94a3b8;background:transparent;color:inherit;font-size:14px;cursor:pointer;font-family:inherit';
    add.append(icon('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>'));
    const addTxt = document.createElement('span');
    addTxt.textContent = T('report_attach', '画像・動画を添付(最大3つ)');
    add.append(addTxt);
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*,video/*'; input.multiple = true; input.hidden = true;
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px;color:#94a3b8';
    note.textContent = T('report_attach_note', '添付は暗号化されず、運営が確認します。個人情報が映らないようにしてください。');
    const err = document.createElement('div');
    err.style.cssText = 'font-size:13px;color:#ef4444;min-height:0';
    wrap.append(add, list, note, err);
    container.append(wrap, input);

    function paint() {
      list.textContent = '';
      files.forEach((f, i) => {
        const chip = document.createElement('div');
        chip.style.cssText = 'position:relative;width:64px;height:64px;border-radius:10px;overflow:hidden;background:#334155;display:flex;align-items:center;justify-content:center;color:#fff';
        if (f.type.startsWith('image/')) {
          const im = document.createElement('img');
          im.style.cssText = 'width:100%;height:100%;object-fit:cover';
          const u = URL.createObjectURL(f); im.src = u; im.onload = () => URL.revokeObjectURL(u);
          chip.append(im);
        } else {
          chip.append(icon('<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3"/>'));
        }
        const x = document.createElement('button');
        x.type = 'button'; x.setAttribute('aria-label', T('remove', '外す'));
        x.style.cssText = 'position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;border:0;background:rgba(0,0,0,.65);color:#fff;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer';
        x.append(icon('<path d="M6 6l12 12M18 6L6 18"/>'));
        x.firstChild.setAttribute('width', '12'); x.firstChild.setAttribute('height', '12');
        x.addEventListener('click', () => { files.splice(i, 1); paint(); });
        chip.append(x);
        list.append(chip);
      });
      add.style.display = files.length >= MAX_FILES ? 'none' : '';
    }
    add.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      err.textContent = '';
      for (const f of Array.from(input.files || [])) {
        const isVid = f.type.startsWith('video/'), isImg = f.type.startsWith('image/');
        if (!isVid && !isImg) { err.textContent = T('report_attach_type', '画像か動画だけ添付できます'); continue; }
        if (files.length >= MAX_FILES) { err.textContent = T('report_attach_max', '添付は3つまでです'); break; }
        if (f.size > (isVid ? MAX_VID : MAX_IMG)) { err.textContent = isVid ? T('report_attach_vid_big', '動画は50MBまでです') : T('report_attach_img_big', '画像は10MBまでです'); continue; }
        files.push(f);
      }
      input.value = '';
      paint();
    });
    paint();

    return {
      count: () => files.length,
      async uploadAll(onStatus) {
        const urls = [];
        for (let i = 0; i < files.length; i++) {
          if (onStatus) onStatus(i + 1, files.length, 0);
          urls.push(await upload(files[i], p => onStatus && onStatus(i + 1, files.length, p)));
        }
        return urls;
      },
      reset() { files = []; err.textContent = ''; paint(); },
    };
  }
  window.BroReportAttach = { mount };
})();
