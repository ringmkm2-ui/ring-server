// utils/uploadScope.js
// 画像・動画を置く場所(フォルダ)が、その人が使ってよい場所かを確かめる共通処理。
// Googleドライブ(routes/drive.js)と、Cloudinaryの署名(routes/media.js の /sign)で同じ基準を使う。
//   brochat/dm/<自分>_<相手>[/<ファイルID>]   相手が今の友だち(ブロック無し)
//   brochat/groups/<グループ>[/<ファイルID>]  今のメンバー
//   brochat/posts[/<自分>]                   投稿(タイムライン)
//   brochat/reports                          バグ報告・通報の添付
const db = require('../db/db');
const { areFriends, isBlockedEither } = require('./relations');

const SUB = '(?:/[A-Za-z0-9_-]{1,80})?';
const DM_RE = new RegExp('^brochat/dm/([A-Za-z0-9_-]{1,200})' + SUB + '$');
const GROUP_RE = new RegExp('^brochat/groups/([A-Za-z0-9-]{1,64})' + SUB + '$');
const POSTS_RE = /^brochat\/posts(?:\/([A-Za-z0-9_-]{1,64}))?$/;

async function canUploadTo(userId, folder) {
  if (!userId || typeof folder !== 'string' || folder.length > 300) return false;
  const dm = DM_RE.exec(folder);
  if (dm) {
    const ids = dm[1].split('_');
    if (ids.length !== 2 || !ids.includes(userId)) return false;
    const peer = ids[0] === userId ? ids[1] : ids[0];
    if (!peer || peer === userId) return false;
    return (await areFriends(userId, peer)) && !(await isBlockedEither(userId, peer));
  }
  const gr = GROUP_RE.exec(folder);
  if (gr) return !!(await db.get('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL', [gr[1], userId]));
  const po = POSTS_RE.exec(folder);
  if (po) return !po[1] || po[1] === userId;
  return folder === 'brochat/reports';
}

module.exports = { canUploadTo };
