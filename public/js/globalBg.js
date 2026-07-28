// 全ページ共通の背景設定を適用するスクリプト。
// <head>内で <script defer src="/js/globalBg.js"></script> として
// 読み込むこと。defer属性により、このスクリプトはHTML全体の
// パースが終わった後、DOMContentLoadedの直前に実行されることが
// 保証される。そのため実行時点でdocument.bodyは必ず存在する。
//
// 過去の実装は<head>内で<style>タグより前に同期<script>として
// 置かれており、HTML解析をその場でブロックした上にdocument.bodyが
// まだ存在しないタイミングで実行されていた。これが「最初だけ白い
// 画面が一瞬映ってからコンテンツが現れる」チラつきの直接原因だった。
(function applyGlobalBackground(){
  const bg = localStorage.getItem('myBgImage');
  if(bg){
    document.documentElement.style.backgroundImage = `url(${bg})`;
    document.documentElement.style.backgroundSize = 'cover';
    document.documentElement.style.backgroundPosition = 'center';
    document.documentElement.style.backgroundAttachment = 'fixed';
    document.documentElement.style.backgroundRepeat = 'no-repeat';
    document.body.classList.add('has-custom-bg');
  }

  // 設定画面で背景を変更した際、別タブでも即座に反映する
  window.addEventListener('storage', (e)=>{
    if(e.key!=='myBgImage')return;
    const newBg = e.newValue;
    if(newBg){
      document.documentElement.style.backgroundImage = `url(${newBg})`;
      document.documentElement.style.backgroundSize = 'cover';
      document.documentElement.style.backgroundPosition = 'center';
      document.documentElement.style.backgroundAttachment = 'fixed';
      document.documentElement.style.backgroundRepeat = 'no-repeat';
      document.body.classList.add('has-custom-bg');
    }else{
      document.documentElement.style.backgroundImage = '';
      document.body.classList.remove('has-custom-bg');
    }
  });
})();
