// db/hideOldPosts.js
// 2026-11-02: 公開前の投稿をまとめて非表示にした。消してはいない。
//
//  - posts.hidden_at に印を付け、同時に deleted_at も入れる(フィード・チャンネル・コメント・
//    いいね一覧は全部 deleted_at IS NULL で絞っているので、クエリは触らずに消える)
//  - 対象は HIDE_POSTS_BEFORE(UTC)以前に作られた投稿だけ。それ以降の投稿は触らない
//  - 起動のたびに走るが、hidden_at が入った行は二度と対象にならない(= 新しい投稿を隠し続けることはない)
//  - ユーザーが自分で消した投稿(deleted_at あり・hidden_at なし)はそのまま
//
// 元に戻す:  UPDATE posts SET deleted_at = NULL WHERE hidden_at IS NOT NULL;
//   (hidden_at は残すこと。消すと次の起動でまた隠れる)
const HIDE_POSTS_BEFORE = '2026-11-02 13:30:00';

module.exports = { HIDE_POSTS_BEFORE };
