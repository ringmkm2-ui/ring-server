// /js/linkify.js — メッセージ内のURLを自動リンク化するユーティリティ
// XSS防止: テキストをエスケープしてからURLだけ<a>タグに置換
(function() {
  'use strict';

  const URL_REGEX = /(?:https?:\/\/|www\.)[\w\-._~:/?#\[\]@!$&'()*+,;=%]+[\w\-_~/#=]/gi;

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
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer" style="color:#3b82f6;text-decoration:underline;word-break:break-all;">' + url + '</a>';
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
