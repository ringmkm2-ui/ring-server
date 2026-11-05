// utils/uploadQuota.js
// アップロード中の量と本数を覚えておく(サーバー1台の前提)。
// 日次上限は「保存が終わった分」の合計で見ていたので、同時に送るとどれも上限の手前に見えて、全部通っていた。
// 始める前に容量を予約し、終わったら(失敗でも)返す。保存できた分はその時点で drive_files に載っている。
// メモリに置くのは、途中で再起動しても「返し忘れた予約」が残らないようにするため。
const { withLock } = require('./keyedLock');

const MAX_CONCURRENT = 6; // 写真をまとめて送るくらいは通る本数
const active = new Map(); // userId -> { count, bytes, postBytes }

// check(cur): 今の予約の状態を見て、この分を足すと上限を超えるならエラー文を返す。
// 戻り値: { release } か { error }。確認と予約の間に他の予約が割り込まないよう、人ごとに1つずつ通す
function reserve(userId, size, isPost, check) {
  return withLock('upload-reserve:' + userId, async () => {
    const cur = active.get(userId) || { count: 0, bytes: 0, postBytes: 0 };
    if (cur.count >= MAX_CONCURRENT) return { error: '同時にアップロードできる数を超えました。少し待ってからお試しください' };
    const error = check ? await check(cur) : null;
    if (error) return { error };
    cur.count += 1;
    cur.bytes += size;
    if (isPost) cur.postBytes += size;
    active.set(userId, cur);
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        cur.count -= 1;
        cur.bytes -= size;
        if (isPost) cur.postBytes -= size;
        if (cur.count <= 0) active.delete(userId);
      },
    };
  });
}

module.exports = { reserve, MAX_CONCURRENT };
