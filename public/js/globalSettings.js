// 全ページ共通の設定(ダークモード・バッテリーセーバー時のアニメーション無効化)を
// 適用するスクリプト。globalBg.jsと同様に各HTMLファイルの<head>で読み込むこと。
(function applyGlobalSettings(){
  function applyDarkMode(){
    const dark = localStorage.getItem('darkMode') === '1';
    if(dark){
      document.documentElement.classList.add('dark-mode');
    }else{
      document.documentElement.classList.remove('dark-mode');
    }
  }

  // バッテリーセーバーの検出について:
  // Battery Status APIはプライバシー上の懸念から大半のブラウザで
  // 廃止されており、「バッテリーセーバーがオンかどうか」を直接
  // 判定する標準的な手段は現状のWebプラットフォームには存在しない。
  // そのため、ユーザーが設定画面で手動でオンにするトグルと、
  // OSの「動きを減らす」設定(prefers-reduced-motion)の両方を
  // 判定材料として使う。
  function applyReducedMotion(){
    const manualBatterySaver = localStorage.getItem('batterySaverAnimations') === '1';
    const osReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(manualBatterySaver || osReducedMotion){
      document.documentElement.classList.add('reduce-motion');
    }else{
      document.documentElement.classList.remove('reduce-motion');
    }
  }

  function applyAll(){
    applyDarkMode();
    applyReducedMotion();
  }

  applyAll();
  document.addEventListener('DOMContentLoaded', applyAll);

  // 設定画面での変更をリアルタイム反映(同一タブ内)
  window.addEventListener('settings-changed', applyAll);
  // 別タブでの変更も反映
  window.addEventListener('storage', (e) => {
    if(e.key === 'darkMode' || e.key === 'batterySaverAnimations') applyAll();
  });

  // OS側の「動きを減らす」設定が変化した場合にも追従
  if(window.matchMedia){
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if(mq.addEventListener) mq.addEventListener('change', applyReducedMotion);
  }

  // --- モバイルデータ節約: 現在モバイル回線かどうかの判定 ---
  // Network Information APIは対応ブラウザが限定的(主にAndroid Chrome系)。
  // 非対応ブラウザでは判定不能なため、その場合は「モバイル回線ではない」
  // 扱いにして、意図せず全ユーザーの画質が下がらないようにする。
  window.isOnMobileData = function(){
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if(!conn) return false;
    if(typeof conn.type === 'string'){
      return conn.type === 'cellular';
    }
    // typeが取れない環境向けのフォールバック: effectiveTypeで代用
    if(typeof conn.effectiveType === 'string'){
      return ['slow-2g','2g','3g'].includes(conn.effectiveType);
    }
    return false;
  };

  // --- 画像圧縮ヘルパー ---
  // モバイルデータ節約がオンで、かつ実際にモバイル回線と判定された場合、
  // 送信前に画像を縮小・再エンコードしてデータ量を削減する。
  window.maybeCompressImage = function(dataUrl){
    return new Promise((resolve) => {
      const saverEnabled = localStorage.getItem('mobileDataSaver') === '1';
      if(!saverEnabled || !window.isOnMobileData()){
        resolve(dataUrl);
        return;
      }
      const img = new Image();
      img.onload = () => {
        const maxDim = 1024; // 節約モード時の最大辺
        let { width, height } = img;
        if(width > maxDim || height > maxDim){
          if(width > height){ height = Math.round(height * maxDim / width); width = maxDim; }
          else{ width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        // JPEG品質0.6で再エンコードしてデータ量を削減
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };
      img.onerror = () => resolve(dataUrl); // 失敗時は元データのまま送る
      img.src = dataUrl;
    });
  };
})();
