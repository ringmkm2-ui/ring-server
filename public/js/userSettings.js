// userSettings.js
// サーバーに置いた設定(プライバシー・通話・セキュリティ)を読み書きする。
// 端末を変えても同じ設定になるのが目的。通話中など即座に値が要る場所のために、
// 最後に取れた値を localStorage に写しておき、読み出しは同期で返す。
(function () {
  var KEY = 'ring_user_settings';
  var DEFAULTS = {
    sendReadReceipts: true,
    sendTypingIndicator: true,
    showOnlineStatus: true,
    allowCallsFrom: 'friends',
    hideIpInCalls: false,
    showCallCode: true,
    loginAlertEmail: true,
  };
  var state = {};
  for (var k in DEFAULTS) state[k] = DEFAULTS[k];
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') for (var k2 in DEFAULTS) if (k2 in saved) state[k2] = saved[k2];
  } catch (e) {}

  function auth() {
    var t = localStorage.getItem('ring_token');
    return t ? { Authorization: 'Bearer ' + t } : null;
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  async function refresh() {
    var h = auth();
    if (!h) return state;
    try {
      var r = await fetch('/api/settings', { headers: h });
      if (!r.ok) return state;
      var d = await r.json();
      if (d && d.settings) {
        for (var k in DEFAULTS) if (k in d.settings) state[k] = d.settings[k];
        persist();
      }
    } catch (e) {}
    return state;
  }

  // 画面側は押した瞬間に反映して、保存はその裏で行う(失敗したら元に戻す)
  async function update(patch) {
    var before = {};
    for (var k in patch) { before[k] = state[k]; state[k] = patch[k]; }
    persist();
    var h = auth();
    if (!h) return state;
    try {
      h['Content-Type'] = 'application/json';
      var r = await fetch('/api/settings', { method: 'PUT', headers: h, body: JSON.stringify({ settings: patch }) });
      if (!r.ok) throw new Error('save failed');
      var d = await r.json();
      if (d && d.settings) { for (var k3 in DEFAULTS) if (k3 in d.settings) state[k3] = d.settings[k3]; persist(); }
    } catch (e) {
      for (var k4 in before) state[k4] = before[k4];
      persist();
      throw e;
    }
    return state;
  }

  window.bcSettings = {
    DEFAULTS: DEFAULTS,
    get: function (k) { return state[k]; },
    all: function () { var o = {}; for (var k in state) o[k] = state[k]; return o; },
    refresh: refresh,
    update: update,
  };
  refresh();
})();
