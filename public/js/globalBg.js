// 全ページ共通の背景設定を適用するスクリプト
// 各HTMLファイルの<head>直後、または<body>の最初で読み込むこと
(function applyGlobalBackground(){
  let lastApplied = null; // 同じ背景を何度も再設定して余計な再描画を招かないためのキャッシュ
  function apply(){
    const bg = localStorage.getItem('myBgImage');
    if(!bg)return;
    if(bg === lastApplied && document.body && document.body.classList.contains('has-custom-bg')){
      return; // 前回と同じ背景かつ既に適用済みなら何もしない
    }
    lastApplied = bg;
    document.documentElement.style.backgroundImage = `url(${bg})`;
    document.documentElement.style.backgroundSize = 'cover';
    document.documentElement.style.backgroundPosition = 'center';
    document.documentElement.style.backgroundAttachment = 'fixed';
    document.documentElement.style.backgroundRepeat = 'no-repeat';
    if(document.body){
      document.body.classList.add('has-custom-bg');
    }
  }
  // head内で同期実行された場合、bodyがまだ存在しないため
  // DOMContentLoadedとloadの両方で再適用を保証する
  apply();
  document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('load', apply);
  // 背景が設定画面で変更された時にリアルタイム反映するため（別タブ用）
  window.addEventListener('storage', (e)=>{
    if(e.key==='myBgImage'){lastApplied=null;apply();}
  });
})();

