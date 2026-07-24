// 全ページ共通の背景設定を適用するスクリプト
// 各HTMLファイルの<head>直後、または<body>の最初で読み込むこと
(function applyGlobalBackground(){
  function apply(){
    const bg = localStorage.getItem('myBgImage');
    if(bg){
      document.documentElement.style.backgroundImage = `url(${bg})`;
      document.documentElement.style.backgroundSize = 'cover';
      document.documentElement.style.backgroundPosition = 'center';
      document.documentElement.style.backgroundAttachment = 'fixed';
      document.documentElement.style.backgroundRepeat = 'no-repeat';
      if(document.body){
        document.body.classList.add('has-custom-bg');
      }
    }
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
  // 背景が設定画面で変更された時にリアルタイム反映するため
  window.addEventListener('storage', (e)=>{
    if(e.key==='myBgImage') apply();
  });
})();
