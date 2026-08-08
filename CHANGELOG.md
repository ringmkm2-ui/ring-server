# Bro Chat 変更履歴 (v1.2.0 -> v1.4.0)

## 変更内容

### 1. バージョン管理スクリプト (bump-version.js)

問題点:
- 毎回バグ修正後、package.json と 3つの HTML ファイルを手動で更新していた（手間・ミスのリスク）

解決策:
```
npm run bump -- major    # 1.2.0 -> 2.0.0
npm run bump -- minor    # 1.2.0 -> 1.3.0
npm run bump -- patch    # 1.2.0 -> 1.2.1
npm run bump -- 1.5.0    # 直接指定
```

実装内容:
- package.json の version フィールドを更新
- public/admin.html, public/groupchat.html, public/talklist.html の version-badge を同期更新
- 1コマンドで全て自動化

---

### 2. バックグラウンド着信対応（Service Worker + Web Push + WebSocket リトライ）

問題点:
- アプリを閉じるとWebSocket接続が切れる
- スリープモードでアプリが止まると着信が届かない
- 単純な固定間隔リトライでは復帰が遅い

実装内容:

A. VAPID Web Push通知
- utils/webPush.js: サーバーからユーザーの全登録デバイスへPush送信するヘルパー。無効化された購読は自動削除
- routes/push.js: 購読登録/解除、VAPID公開鍵取得のエンドポイント
- db: push_subscriptions テーブルを追加（schema.postgres.sql / db.postgres.js / db.sqlite.js）
- ws/wsServer.js: call_offer時に発信者情報つきでPush送信。WS配達の成否に関わらず常に送信し、スリープ中でもOS側で起こす。call_reject/call_end時は通知キャンセル用のPushも送信
- public/js/pushSubscribe.js（新規共通スクリプト）: 全ページでService Worker登録・Push購読処理

B. Service Workerの拡張 (public/sw.js)
- push イベントで着信通知を表示（バイブレーションパターン、応答/拒否ボタンつき）
- notificationclick でアプリを開く、または既存ウィンドウにフォーカス
- クライアントからのキープアライブメッセージ受信

C. クライアント側リスナー (admin.html / talklist.html)
- Service Workerからのメッセージを受けてバックグラウンド着信を復元
- 25秒ごとのキープアライブ送信

D. WebSocket リコネクション強化
- 旧: 5秒固定リトライ
- 新: 指数バックオフ（1秒 -> 2秒 -> 5秒 -> ... -> 最大10分）

---

### 3. ビデオ通話

実装内容:
- 発信ボタンの隣にビデオ通話ボタンを追加
- 通話画面にリモート映像（全画面）と自分の映像（小窓）を表示
- 映像ON/OFF切り替え、インカメラ/アウトカメラ切り替えに対応
- call_offer に isVideo フラグを追加し、サーバー側で中継
- Push通知にもisVideoを含め、バックグラウンドから復帰した際にビデオ通話として起動

---

### 4. 画像送信バグの修正（個人チャット、admin.html）

見つかったバグ:

1. メディア受信時の復号処理が丸ごと欠落
   content は {text, media, mediaType} というJSON構造で、暗号化されているのは内側の media フィールドだけだったが、受信処理4箇所（syncMessages / WS受信 / message_edited / initialLoadHistory）が content 全体を復号にかけていた。結果、画像は暗号化バイナリのまま表示され、常に破綻していた。
   -> メディアかどうかを自動判別してmediaだけ復号する共通関数 decryptMessageContent を新設し、4箇所を置き換え

2. 自分が送った画像が送信直後から消える
   送信完了時、キャッシュにも画面表示にも "[画像]" というラベル文字列しか保存しておらず、実データを保持していなかった。
   -> 平文Base64を含むJSONをキャッシュ・表示両方に使うよう修正。localStorage容量超過時のフォールバックも追加

3. 既読更新等の再描画で画像が消える
   parseMsgContent のキャッシュ設計上、mediaSrcを毎回除外していたが、既読・リアクション更新のたびに同じメッセージのDOMを作り直す実装のため、2回目以降の再描画で画像が消えていた。
   -> mediaSrcも含めて全フィールドをキャッシュし、contentが変化した場合のみ再パースするよう修正

groupchat.html（グループチャット）は暗号化していない設計のため、同種のバグはなし。

---

## ファイル変更一覧

| ファイル | 変更内容 |
|---------|--------|
| bump-version.js | 新規: バージョン管理スクリプト |
| package.json | npm run bump スクリプト追加、web-push依存追加 |
| utils/webPush.js | 新規: Web Push送信ヘルパー |
| routes/push.js | 新規: Push購読登録/解除エンドポイント |
| public/js/pushSubscribe.js | 新規: 全ページ共通のPush購読登録スクリプト |
| public/sw.js | Push通知受信、通話通知、キープアライブ処理を追加 |
| public/admin.html | ビデオ通話UI・ロジック、バックグラウンド着信復帰、画像送信バグ修正 |
| public/talklist.html | バックグラウンド着信復帰の中継処理 |
| public/groupchat.html | WSリコネクション強化 |
| db/schema.postgres.sql | push_subscriptions テーブル追加 |
| db/db.postgres.js | push_subscriptions マイグレーション追加 |
| db/db.sqlite.js | push_subscriptions テーブル追加 |
| ws/wsServer.js | call_offerにisVideo対応、Push送信の組み込み |

---

## 今後の課題

1. iOS対応: 現状はAndroid中心の実装。iOSでのWeb Push利用にはSafari 16.4以降かつホーム画面追加（PWA化）が必須で未対応
2. グループメッセージのE2E暗号化: 未実装
3. マルチデバイス公開鍵管理: 同じユーザーが別デバイスからログインすると公開鍵が上書きされるリスクが残っている

---

バージョン: v1.4.0
更新日: 2026-08-07
