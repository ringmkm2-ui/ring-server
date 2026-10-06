// communityE2E.js
// コミュニティのE2E暗号化。鍵の作り方・配り方・暗号化の中身はグループと全く同じなので、
// groupE2E.js の部品(X3DHでの鍵配布、secretboxでの本文暗号化)をそのまま使い、
// サーバーの /api/communities/* 側だけを繋ぎ替えている。
//
// 依存(この順で先に読み込む): libsodium-wrappers.min.js, signalkeymanager.js, groupE2E.js
// ページ側に window.myUserId と api(url, opts) があること。
(function () {
  const KEY_PREFIX = 'community_key_'; // community_key_<id>_v<version>

  function g() {
    if (!window.groupE2E) throw new Error('groupE2E.js not loaded');
    return window.groupE2E;
  }

  // 指定した版(未指定なら最新)のコミュニティ鍵を取り出す。
  // 端末に残っていればそれを使い、無ければサーバーから自分宛の塊を取って復号する。
  async function getKey(communityId, version) {
    if (version != null) {
      const c = localStorage.getItem(KEY_PREFIX + communityId + '_v' + version);
      if (c) return { key: new Uint8Array(JSON.parse(c)), version };
    }
    const q = version != null ? '?version=' + encodeURIComponent(version) : '';
    const res = await api('/api/communities/' + communityId + '/my-key' + q);
    if (!res || !res.encryptedKey) {
      const e = new Error('コミュニティの鍵がまだ配られていません');
      e.code = 'NO_KEY';
      throw e;
    }
    const cacheKey = KEY_PREFIX + communityId + '_v' + res.keyVersion;
    const cached = localStorage.getItem(cacheKey);
    if (cached) return { key: new Uint8Array(JSON.parse(cached)), version: res.keyVersion };

    const key = await g().decryptGroupKey(res.encryptedKey);
    localStorage.setItem(cacheKey, JSON.stringify(Array.from(key)));
    if (window.bcKeyBackup) window.bcKeyBackup.syncSoon();
    return { key, version: res.keyVersion };
  }

  // 作成時: 新しい鍵を作って自分宛に暗号化する。戻り値を /api/communities の body に入れる
  async function createInitialKey() {
    await g().ensureMyIdentity();
    const key = await g().generateGroupKey();
    const encryptedKeyForSelf = await g().encryptGroupKeyForMember(key, window.myUserId);
    return { key, encryptedKeyForSelf };
  }

  // 作ったコミュニティの鍵を端末に覚えさせる
  function rememberKey(communityId, version, key) {
    localStorage.setItem(KEY_PREFIX + communityId + '_v' + version, JSON.stringify(Array.from(key)));
    if (window.bcKeyBackup) window.bcKeyBackup.syncSoon();
  }

  async function encryptText(text, key) { return g().encryptGroupText(text, key); }
  async function decryptText(json, key) { return g().decryptGroupText(json, key); }

  // 鍵をまだ持っていない人へ配る。参加した人は次に誰かが開いた時に受け取れる
  let distributing = false;
  async function distributePendingKeys() {
    if (distributing) return 0;
    distributing = true;
    let total = 0;
    try {
      const res = await api('/api/communities/pending-keys');
      if (!res || !Array.isArray(res.communities) || !res.communities.length) return 0;
      await g().ensureMyIdentity();
      for (const c of res.communities) {
        let mine;
        try { mine = await getKey(c.communityId); } catch (e) { continue; }
        if (mine.version !== c.keyVersion) continue;
        const entries = [];
        for (const uid of c.userIds) {
          try {
            entries.push({ userId: uid, encryptedKey: await g().encryptGroupKeyForMember(mine.key, uid) });
          } catch (e) {
            // 相手がまだ暗号鍵を作っていないだけ。その人が作った後に配られる
          }
        }
        if (!entries.length) continue;
        const r = await api('/api/communities/' + c.communityId + '/distribute-keys', {
          method: 'POST',
          body: JSON.stringify({ keyVersion: c.keyVersion, encryptedKeysForMembers: entries }),
        });
        if (r && r.delivered) total += r.delivered;
      }
    } catch (e) {
      console.warn('[communityE2E] 鍵の配布に失敗:', e);
    } finally {
      distributing = false;
    }
    return total;
  }

  // 誰も今の鍵を読めなくなった時や、誰かが抜けた後の立て直し
  async function rotateKey(communityId, memberIds, expectedVersion) {
    await g().ensureMyIdentity();
    const key = await g().generateGroupKey();
    const entries = [];
    for (const uid of memberIds) {
      try {
        entries.push({ userId: uid, encryptedKey: await g().encryptGroupKeyForMember(key, uid) });
      } catch (e) {
        if (uid === window.myUserId) throw e; // 自分宛が作れないのは致命的
      }
    }
    const r = await api('/api/communities/' + communityId + '/rotate-key', {
      method: 'POST',
      body: JSON.stringify({ expectedVersion, encryptedKeysForMembers: entries }),
    });
    if (!r || !r.ok) throw new Error((r && r.error) || 'rotate failed');
    rememberKey(communityId, r.keyVersion, key);
    return r.keyVersion;
  }

  window.communityE2E = {
    getKey, createInitialKey, rememberKey, encryptText, decryptText,
    distributePendingKeys, rotateKey,
  };
})();
