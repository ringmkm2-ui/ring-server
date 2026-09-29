// アイコン画像(Base64)をサーバーへアップロードし、保存された画像のURLを返す。
// DBやlocalStorageに大きなBase64を持たないため。api() は各ページの共通ヘルパーを使う。
window.uploadIcon = async function (dataUrl) {
  const r = await api('/api/icons', { method: 'POST', body: JSON.stringify({ dataUrl }) });
  if (!r || !r.url) throw new Error((r && r.error) || 'アップロードに失敗しました');
  return r.url;
};
