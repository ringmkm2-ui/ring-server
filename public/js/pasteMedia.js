// public/js/pasteMedia.js
// 入力欄に画像・GIF・動画を貼り付けたら、そのまま送る。
// Gboard/iOSキーボードのクリップボード(スクショの「貼り付け」)、GIF検索の結果、
// PCのCtrl+V、ドラッグ&ドロップをまとめて拾う。
//   bcAttachPasteMedia(入力欄の要素, (file, 'image' | 'video') => 送る処理)
(function () {
  if (window.bcAttachPasteMedia) return;

  function kindOf(file) {
    var t = (file && file.type) || '';
    if (t.indexOf('image/') === 0) return 'image';
    if (t.indexOf('video/') === 0) return 'video';
    return null;
  }

  // DataTransfer(貼り付け/ドロップ)から送れるファイルを1つ取り出す
  function pickFile(dt) {
    if (!dt) return null;
    var f, i;
    if (dt.files && dt.files.length) {
      for (i = 0; i < dt.files.length; i++) if (kindOf(dt.files[i])) return dt.files[i];
    }
    // 端末によっては files が空で items にだけ入っている
    if (dt.items && dt.items.length) {
      for (i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind === 'file' && (it.type.indexOf('image/') === 0 || it.type.indexOf('video/') === 0)) {
          f = it.getAsFile();
          if (f && kindOf(f)) return f;
        }
      }
    }
    return null;
  }

  // 名前が空/汎用のファイルは、種類から名前を付ける(Cloudinary側やプレビューで拡張子を見るため)
  function named(file) {
    var ext = ((file.type || '').split('/')[1] || 'bin').split('+')[0].replace('jpeg', 'jpg');
    if (file.name && /\.[a-z0-9]{2,5}$/i.test(file.name) && file.name !== 'image.png') return file;
    try { return new File([file], 'paste_' + Date.now() + '.' + ext, { type: file.type, lastModified: Date.now() }); }
    catch (e) { return file; }
  }

  window.bcAttachPasteMedia = function (el, onFile) {
    if (!el || typeof onFile !== 'function') return;
    function take(e, dt) {
      var f = pickFile(dt);
      if (!f) return false; // 文字だけの貼り付けは、いつも通り入力欄に入れる
      e.preventDefault();
      f = named(f);
      onFile(f, kindOf(f));
      return true;
    }
    el.addEventListener('paste', function (e) { take(e, e.clipboardData); });
    // Safariなどは paste より先に beforeinput(dataTransfer付き)で画像を渡してくることがある
    el.addEventListener('beforeinput', function (e) {
      if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop' || e.inputType === 'insertFromYank') {
        take(e, e.dataTransfer);
      }
    });
    el.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function (t) { return t === 'Files'; })) e.preventDefault();
    });
    el.addEventListener('drop', function (e) { take(e, e.dataTransfer); });
  };
})();
