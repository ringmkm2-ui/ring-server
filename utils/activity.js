// utils/activity.js
// 「アプリが実際に使われているか」の印。
//
// Neon(DB)は、クエリが途切れると自動で眠って課金が止まる。逆に言うと、誰も使っていない
// 時間に定期クエリを1本でも投げ続けると、DBは一生眠れずコンピュート時間を24時間食い続ける
// (無料枠は1か月100 CU時間しかないので、これだけで半月ほどで使い切る)。
// 2026-10-28に実際に使い切ってDBが停止し、サーバーが起動できなくなった。
//
// そこで、APIが叩かれた時とWebSocketがつながった時にここへ印を付け、
// 掃除などの「後回しでいい定期処理」は、最近使われた時だけ動かすようにする。
let last = 0;

function note() { last = Date.now(); }
function lastAt() { return last; }
// 直近 ms ミリ秒以内に使われたか(起動直後に1度も使われていなければ false)
function activeWithin(ms) { return last > 0 && Date.now() - last <= ms; }

module.exports = { note, lastAt, activeWithin };
