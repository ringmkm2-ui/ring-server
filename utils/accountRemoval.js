// utils/accountRemoval.js
// アカウントの削除(退会)の後始末。本人の退会(routes/auth.js /delete-account)と、
// 管理Exeからの削除(routes/admin.js)で同じ処理を使う。片方だけ直し忘れないよう1か所にまとめている。
//
// メッセージのcontent列は空にし、メタデータ(sender_id等)は外部キー制約の関係でそのまま残る
// (相手側の会話画面では「退会済みユーザー」と表示される)。ユーザー行も匿名化して残す。
const db = require('../db/db');
const sessionEvents = require('./sessionEvents');

async function removeAccount(userId) {
  // メッセージ内容を消去(メタデータは残す)
  await db.run("UPDATE messages SET content = '', deleted_at = CURRENT_TIMESTAMP WHERE sender_id = ?", [userId]);
  await db.run("UPDATE group_messages SET content = '', deleted_at = CURRENT_TIMESTAMP WHERE sender_id = ?", [userId]);
  // 関連データ削除
  await db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM one_time_prekeys WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM identity_keys WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM message_reactions WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM offline_queue WHERE sender_id = ? OR recipient_id = ?', [userId, userId]);
  await db.run('DELETE FROM call_notes WHERE owner_id = ?', [userId]);
  await db.run('DELETE FROM call_summaries WHERE owner_id = ?', [userId]);
  // ログイン関連の残り(2FA秘密鍵・予備コード・認証コード・端末セッション・プッシュ宛先)も消す
  await db.run("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'account_delete' WHERE user_id = ? AND revoked_at IS NULL", [userId]);
  await db.run('DELETE FROM email_codes WHERE username = (SELECT username FROM users WHERE id = ?)', [userId]);
  try { await db.run('DELETE FROM fcm_tokens WHERE user_id = ?', [userId]); } catch (e) { console.error('[auth] fcm_tokens cleanup:', e.message); }
  try { await db.run('DELETE FROM key_backups WHERE user_id = ?', [userId]); } catch (e) { console.error('[auth] key_backups cleanup:', e.message); }
  try { await db.run('DELETE FROM user_pubkeys WHERE user_id = ?', [userId]); } catch (e) { console.error('[auth] user_pubkeys cleanup:', e.message); }
  try { await db.run('DELETE FROM guest_upgrades WHERE user_id = ?', [userId]); } catch (e) { console.error('[auth] guest_upgrades cleanup:', e.message); }
  // 自分が作った招待コード(と、そのコードの使用記録)・自分が使った記録も消す
  try {
    await db.run('DELETE FROM invite_redemptions WHERE code IN (SELECT code FROM invite_codes WHERE owner_id = ?) OR user_id = ?', [userId, userId]);
    await db.run('DELETE FROM invite_codes WHERE owner_id = ?', [userId]);
  } catch (e) { console.error('[auth] invite cleanup:', e.message); }
  try {
    await db.run('DELETE FROM invite_removals WHERE owner_id = ? OR user_id = ?', [userId, userId]);
    await db.run('DELETE FROM call_assist_usage WHERE user_id = ?', [userId]);
  } catch (e) { console.error('[auth] removal/usage cleanup:', e.message); }
  // 投稿とコメントも消す(以前は退会後も「退会済みユーザー」の名前で公開のまま残っていた)
  try {
    await db.run('UPDATE posts SET deleted_at = CURRENT_TIMESTAMP WHERE author_id = ? AND deleted_at IS NULL', [userId]);
    await db.run('UPDATE post_comments SET deleted_at = CURRENT_TIMESTAMP WHERE author_id = ? AND deleted_at IS NULL', [userId]);
  } catch (e) { console.error('[auth] posts cleanup:', e.message); }
  // 入っていたグループから抜ける(以前は退会後もメンバーのまま残り、オーナーだった場合は誰も管理できないグループになった)
  try {
    const mine = await db.all(
      'SELECT g.id, g.owner_id FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = ? AND gm.left_at IS NULL',
      [userId]
    );
    for (const g of mine) {
      if (g.owner_id !== userId) continue;
      const next = await db.get(
        'SELECT user_id FROM group_members WHERE group_id = ? AND user_id <> ? AND left_at IS NULL ORDER BY joined_at ASC LIMIT 1',
        [g.id, userId]
      );
      if (next) await db.run('UPDATE groups SET owner_id = ? WHERE id = ?', [next.user_id, g.id]);
    }
    await db.run('UPDATE group_members SET left_at = CURRENT_TIMESTAMP WHERE user_id = ? AND left_at IS NULL', [userId]);
  } catch (e) { console.error('[auth] group cleanup:', e.message); }
  // ユーザー情報の匿名化(外部キー制約のため行自体は残す)。本名も消す
  await db.run('UPDATE users SET real_name = NULL WHERE id = ?', [userId]);
  await db.run(
    "UPDATE users SET username = ?, password_hash = '', display_name = '退会済みユーザー', profile_pic = '', bio = '', public_key = NULL, totp_secret = NULL, totp_enabled = ?, backup_codes = NULL, token_revoked_at = CURRENT_TIMESTAMP WHERE id = ?",
    [`deleted_${userId}`, false, userId]
  );
  sessionEvents.emit('revoked', { userId }); // 繋がったままのWebSocketも切る
}

module.exports = { removeAccount };
