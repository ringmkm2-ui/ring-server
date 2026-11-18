// /js/linkify.js — メッセージ内のURLを自動リンク化するユーティリティ
// XSS防止: テキストをエスケープしてからURLだけ<a>タグに置換
(function() {
  'use strict';

  const URL_REGEX = /(?:https?:\/\/|www\.)[\w\-._~:/?#\[\]@!$&'()*+,;=%]+[\w\-_~/#=]/gi;

  // リンクの色は class で当てる。自分の吹き出し(青地)やダークモードで青文字が沈まないように、背景ごとに色を変える
  (function injectCss() {
    if (document.getElementById('bro-link-css')) return;
    const st = document.createElement('style');
    st.id = 'bro-link-css';
    st.textContent =
      'a.bro-link{color:#2563eb;text-decoration:underline;text-underline-offset:2px;word-break:break-all}' +
      'html.dark-mode a.bro-link{color:#7db3ff}' +
      '.outgoing a.bro-link,.msg.out a.bro-link{color:#1d4ed8}' +
      'html.dark-mode .outgoing a.bro-link,html.dark-mode .msg.out a.bro-link{color:#fff;text-decoration-thickness:1.5px}' +
      'a.bro-link:focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:3px}';
    (document.head || document.documentElement).appendChild(st);
  })();

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * テキストをリンク化したHTML文字列を返す
   * @param {string} text
   * @returns {string} HTML
   */
  window.linkifyText = function(text) {
    if (!text) return '';
    const escaped = escapeHTML(text);
    return escaped.replace(URL_REGEX, function(url) {
      let href = url;
      if (href.startsWith('www.')) href = 'https://' + href;
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer" class="bro-link">' + url + '</a>';
    });
  };

  /**
   * 要素にリンク化テキストを設定（textContentの代わりに使う）
   * @param {HTMLElement} el
   * @param {string} text
   */
  window.setLinkedText = function(el, text) {
    if (!text) { el.textContent = ''; return; }
    el.innerHTML = linkifyText(text);
  };
})();
