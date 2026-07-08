// localmessagestore.js
// -----------------------------------------------------------------------
// クライアント側ローカル保存 (IndexedDB)。
// 設計方針:
//  - テキストメッセージ本文は「送信端末のローカルにのみ」永続保存する。
//    サーバーは中継のみで本文を保持しない (offline_queueは配送完了後に即削除)。
//  - 画像・動画はダウンロード後にここへキャッシュし、サーバー側の7日TTLが
//    切れても手元では見られるようにする。
//  - グループの脱退/削除メンバーはトーク一覧から隠すが、ローカル履歴は保持する
//    (このストアの `hidden` フラグで管理)。
// -----------------------------------------------------------------------
(function (root) {
  const DB_NAME = 'ring_local_store';
  const DB_VERSION = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'msgUuid' });
          store.createIndex('byConversation', 'conversationId', { unique: false });
          store.createIndex('byTimestamp', 'timestamp', { unique: false });
        }

        if (!db.objectStoreNames.contains('media_cache')) {
          db.createObjectStore('media_cache', { keyPath: 'fileId' });
        }

        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'conversationId' });
        }

        if (!db.objectStoreNames.contains('ratchet_state')) {
          // 会話ごとの現在のチェーンキーを保存 (メッセージ暗号化の継続に必要)
          db.createObjectStore('ratchet_state', { keyPath: 'conversationId' });
        }
      };

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  class LocalMessageStore {
    constructor() {
      this.dbPromise = openDB();
    }

    async _tx(storeName, mode) {
      const db = await this.dbPromise;
      return db.transaction(storeName, mode).objectStore(storeName);
    }

    // --- メッセージ保存 (重複排除: msgUuidが同じなら上書きせず無視) ---
    async saveMessage(msg) {
      // msg: { msgUuid, conversationId, senderId, text, mediaFileId, timestamp, isOwn }
      const store = await this._tx('messages', 'readwrite');
      const existing = await new Promise((resolve) => {
        const r = store.get(msg.msgUuid);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      });
      if (existing) {
        // 重複排除ロジック: 同一UUIDのメッセージは無視する
        return { saved: false, reason: 'duplicate' };
      }
      store.put(msg);
      return { saved: true };
    }

    async getMessagesForConversation(conversationId) {
      const store = await this._tx('messages', 'readonly');
      const index = store.index('byConversation');
      return new Promise((resolve, reject) => {
        const results = [];
        const req = index.openCursor(IDBKeyRange.only(conversationId));
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { results.push(cursor.value); cursor.continue(); }
          else resolve(results.sort((a, b) => a.timestamp - b.timestamp));
        };
        req.onerror = (e) => reject(e.target.error);
      });
    }

    async deleteMessage(msgUuid) {
      const store = await this._tx('messages', 'readwrite');
      store.delete(msgUuid);
    }

    // --- メディアキャッシュ (ダウンロード済みファイルを端末に永続保存) ---
    async cacheMedia(fileId, blob, meta = {}) {
      const store = await this._tx('media_cache', 'readwrite');
      store.put({ fileId, blob, meta, cachedAt: Date.now() });
    }

    async getCachedMedia(fileId) {
      const store = await this._tx('media_cache', 'readonly');
      return new Promise((resolve) => {
        const r = store.get(fileId);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    }

    // --- 会話メタ情報 (グループ脱退時などの非表示フラグもここで管理) ---
    async saveConversation(conv) {
      const store = await this._tx('conversations', 'readwrite');
      store.put(conv);
    }

    async hideConversation(conversationId) {
      const store = await this._tx('conversations', 'readwrite');
      const r = store.get(conversationId);
      r.onsuccess = () => {
        const conv = r.result || { conversationId };
        conv.hidden = true; // トークリストからは消すが、messagesストアの履歴は残す
        store.put(conv);
      };
    }

    async getVisibleConversations() {
      const store = await this._tx('conversations', 'readonly');
      return new Promise((resolve, reject) => {
        const results = [];
        const req = store.openCursor();
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            if (!cursor.value.hidden) results.push(cursor.value);
            cursor.continue();
          } else resolve(results);
        };
        req.onerror = (e) => reject(e.target.error);
      });
    }

    // --- ラチェット状態 (会話ごとの現在のチェーンキーを保存/復元) ---
    async saveRatchetState(conversationId, chainKey) {
      const store = await this._tx('ratchet_state', 'readwrite');
      store.put({ conversationId, chainKey, updatedAt: Date.now() });
    }

    async getRatchetState(conversationId) {
      const store = await this._tx('ratchet_state', 'readonly');
      return new Promise((resolve) => {
        const r = store.get(conversationId);
        r.onsuccess = () => resolve(r.result ? r.result.chainKey : null);
        r.onerror = () => resolve(null);
      });
    }
  }

  root.RingLocalMessageStore = LocalMessageStore;
})(typeof window !== 'undefined' ? window : this);
