// utils/siteHosts.js
// このアプリを配信するホスト名の一覧。独自ドメインを足す時はここに足す。
//
//  - ring-server-50sy.onrender.com : 元のURL(APKと既存の端末はこっち。外さない)
//  - brochat.org / www.brochat.org : 独自ドメイン(onrender.com 全体がフィルターで止められる環境向け)
//
// どのホストで開いても同じサーバー・同じDBに繋がる。ホストが変わると localStorage が別物になる
// (= 端末に置いた暗号鍵やログインは引き継がれない)ので、既存ユーザーは元のURLのままにしておく。
// テスト用のサーバーは EXTRA_SITE_HOSTS(カンマ区切り)で自分のホスト名を足す。本番では設定しない
const SITE_HOSTS = ['ring-server-50sy.onrender.com', 'brochat.org', 'www.brochat.org']
  .concat(String(process.env.EXTRA_SITE_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(h => /^[a-z0-9.-]+$/.test(h)));
const SITE_ORIGINS = SITE_HOSTS.map(h => 'https://' + h);

// リクエストが届いたホストが上の一覧にあれば、そのホストのURLを返す。無ければ null。
// (Hostヘッダーは偽装できるが、一覧にあるホスト以外は採用しないので、任意のURLは作れない)
function knownBase(req) {
  const h = String((req && req.get && req.get('host')) || '').toLowerCase();
  return SITE_HOSTS.includes(h) ? 'https://' + h : null;
}

module.exports = { SITE_HOSTS, SITE_ORIGINS, knownBase };
