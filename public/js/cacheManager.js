// cacheManager.js
// IndexedDB を使用したローカルキャッシュ管理
// LINE のように即座にキャッシュから表示、バックグラウンドでサーバーと同期

class CacheManager {
  constructor(dbName = 'RingChatDB', version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        
        // グループ情報ストア
        if (!db.objectStoreNames.contains('groups')) {
          db.createObjectStore('groups', { keyPath: 'id' });
        }
        
        // メッセージストア
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('groupId', 'groupId', { unique: false });
        }
        
        // フレンド/ユーザーストア
        if (!db.objectStoreNames.contains('friends')) {
          db.createObjectStore('friends', { keyPath: 'id' });
        }
        
        // ポスト/タイムラインストア
        if (!db.objectStoreNames.contains('posts')) {
          db.createObjectStore('posts', { keyPath: 'id' });
        }
        
        // 通話履歴・録音ストア
        if (!db.objectStoreNames.contains('callRecordings')) {
          db.createObjectStore('callRecordings', { keyPath: 'id' });
        }
      };
    });
  }

  async saveGroups(groups) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('groups', 'readwrite');
      const store = tx.objectStore('groups');
      
      store.clear();
      groups.forEach(g => store.add(g));
      
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getGroups() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('groups', 'readonly');
      const store = tx.objectStore('groups');
      const req = store.getAll();
      
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async saveMessages(groupId, messages) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const index = store.index('groupId');
      
      // グループのメッセージをクリア
      const rangeReq = index.getAll(groupId);
      rangeReq.onsuccess = () => {
        rangeReq.result.forEach(msg => store.delete(msg.id));
        
        // 新規メッセージを追加
        messages.forEach(m => store.add(m));
        
        tx.oncomplete = () => resolve();
      };
      
      tx.onerror = () => reject(tx.error);
    });
  }

  async getMessages(groupId) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('messages', 'readonly');
      const index = tx.objectStore('messages').index('groupId');
      const req = index.getAll(groupId);
      
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async saveFriends(friends) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('friends', 'readwrite');
      const store = tx.objectStore('friends');
      
      store.clear();
      friends.forEach(f => store.add(f));
      
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getFriends() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('friends', 'readonly');
      const store = tx.objectStore('friends');
      const req = store.getAll();
      
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async savePosts(posts) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('posts', 'readwrite');
      const store = tx.objectStore('posts');
      
      store.clear();
      posts.forEach(p => store.add(p));
      
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getPosts() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('posts', 'readonly');
      const store = tx.objectStore('posts');
      const req = store.getAll();
      
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(tx.error);
    });
  }

  async clear() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['groups', 'messages', 'friends', 'posts'], 'readwrite');
      
      tx.objectStore('groups').clear();
      tx.objectStore('messages').clear();
      tx.objectStore('friends').clear();
      tx.objectStore('posts').clear();
      
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

// グローバル共有インスタンス
const cacheManager = new CacheManager();
window.cacheManager = cacheManager;
