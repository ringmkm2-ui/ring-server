// js/actions.js
// HTMLに書いていた onclick="..." / onsubmit="..." の代わり。
// CSPでインラインのイベント属性(script-src-attr)を禁止したため、属性は data-* に置き換え、
// ここでまとめて受けて決まった関数だけを呼ぶ。
//   data-call="関数名" [data-arg="引数"]   クリックで window[関数名](引数) を呼ぶ
//   data-submit="関数名"                   フォーム送信で window[関数名](event) を呼ぶ
//   data-close="要素ID"                    クリックでその要素の show クラスを外す
//   data-nav="/path.html"                  クリックで同じサイト内のページへ移動
// 呼べる関数は下の一覧だけ(HTMLを差し込まれても、好きな関数を呼ばせない)。
(function () {
  var ALLOWED = {
    switchMode: 1, showForgot: 1, resendCode: 1, backToLogin: 1, resendReset: 1, googleLoginViaBrowser: 1,
    emailLogin: 1, emailSignup: 1, submitVerify: 1, submitForgot: 1, submitReset: 1, submitTwoFa: 1,
    toggleMobileChannels: 1, copyInvite: 1, openGS: 1,
    openAddFriend: 1, logout: 1, searchFriend: 1, closeAddFriend: 1,
  };
  function fn(name) {
    if (!name || !Object.prototype.hasOwnProperty.call(ALLOWED, name)) return null;
    var f = window[name];
    return typeof f === 'function' ? f : null;
  }
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-call],[data-close],[data-nav]') : null;
    if (!el) return;
    if (el.hasAttribute('data-close')) {
      var t = document.getElementById(el.getAttribute('data-close'));
      if (t) t.classList.remove('show');
      return;
    }
    if (el.hasAttribute('data-nav')) {
      var to = el.getAttribute('data-nav');
      if (/^\/[A-Za-z0-9_\-./?=&]*$/.test(to) && to.indexOf('//') !== 0) location.href = to;
      return;
    }
    var f = fn(el.getAttribute('data-call'));
    if (!f) return;
    if (el.hasAttribute('data-arg')) f(el.getAttribute('data-arg'));
    else f();
  });
  document.addEventListener('submit', function (e) {
    var form = e.target && e.target.closest ? e.target.closest('form[data-submit]') : null;
    if (!form) return;
    var f = fn(form.getAttribute('data-submit'));
    if (f) f(e);
  });
})();
