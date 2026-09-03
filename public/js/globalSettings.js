// 全ページ共通の設定(ダークモード・バッテリーセーバー時のアニメーション無効化)を
// 適用するスクリプト。<head>内で
// <script defer src="/js/globalSettings.js"></script> として読み込むこと。
(function applyGlobalSettings(){
  // --- ダークモード ---
  // 優先順位: 手動設定 > システム設定
  // localStorage 'darkMode': '1'=強制ON, '0'=強制OFF, null/''=システムに従う
  function applyDarkMode(){
    const manual = localStorage.getItem('darkMode');
    let dark;
    if (manual === '1') dark = true;
    else if (manual === '0') dark = false;
    else dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark-mode', dark);
  }

  function applyReducedMotion(){
    const manualBatterySaver = localStorage.getItem('batterySaverAnimations') === '1';
    const osReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.classList.toggle('reduce-motion', manualBatterySaver || osReducedMotion);
  }

  applyDarkMode();
  applyReducedMotion();

  // 設定画面での変更をリアルタイム反映(同一タブ内)
  window.addEventListener('settings-changed', () => { applyDarkMode(); applyReducedMotion(); });
  // 別タブでの変更も反映
  window.addEventListener('storage', (e) => {
    if(e.key === 'darkMode') applyDarkMode();
    if(e.key === 'batterySaverAnimations') applyReducedMotion();
  });

  // システムのダークモード変更に追従
  if(window.matchMedia){
    const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
    if(darkMq.addEventListener) darkMq.addEventListener('change', applyDarkMode);
    const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if(motionMq.addEventListener) motionMq.addEventListener('change', applyReducedMotion);
  }

  // --- モバイルデータ節約 ---
  // 手動設定がONの場合は常に節約モード
  // 手動設定がOFFでも、Network Information APIでcellularかつ低速なら自動で節約
  window.isOnMobileData = function(){
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if(!conn) return false;
    if(typeof conn.type === 'string') return conn.type === 'cellular';
    if(typeof conn.effectiveType === 'string') return ['slow-2g','2g','3g'].includes(conn.effectiveType);
    return false;
  };

  window.shouldSaveData = function(){
    const manual = localStorage.getItem('mobileDataSaver') === '1';
    if(manual) return true;
    // Save-Data HTTPヘッダーに対応するブラウザの場合
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if(conn && conn.saveData) return true;
    return false;
  };

  // --- 画像圧縮ヘルパー ---
  window.maybeCompressImage = function(dataUrl){
    return new Promise((resolve) => {
      if(!window.shouldSaveData() && !window.isOnMobileData()){
        resolve(dataUrl);
        return;
      }
      const img = new Image();
      img.onload = () => {
        const maxDim = 1024;
        let { width, height } = img;
        if(width > maxDim || height > maxDim){
          if(width > height){ height = Math.round(height * maxDim / width); width = maxDim; }
          else{ width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  };
})();
