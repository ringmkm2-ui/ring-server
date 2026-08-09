// public/js/liquidGlass.js
// -----------------------------------------------------------------------
// Liquid Glass デザインシステムの共通JSヘルパー。
// 全ページ(admin.html/talklist.html/groupchat.html)で <script defer> 読込。
// -----------------------------------------------------------------------
(function () {

  // ============================================================
  // Haptic Feedback
  // ネイティブのUIFeedbackGenerator相当。WebにはVibration APIしか無く、
  // かつAndroid Chromeでのみ対応(iOS SafariはPWAでも非対応)なので、
  // Android中心の運用方針に合わせてこれで代替する。
  // 呼んでも何も起きない環境(iOS等)では静かに無視される。
  // ============================================================
  const HAPTIC_PATTERNS = {
    light: 10,        // 軽いタップ(通常のボタン押下)
    medium: 20,        // やや強めのタップ(送信・確定操作)
    selection: 8,       // ピッカー等での選択切り替え
    success: [10, 40, 10],   // 成功(既読・承認・接続成功)
    warning: [20, 40, 20],   // 警告
    error: [30, 60, 30, 60, 30], // エラー・拒否
    call: [500, 300, 500, 300, 500], // 着信(既存の通話バイブと統一)
  };

  function haptic(type) {
    if (!('vibrate' in navigator)) return;
    const pattern = HAPTIC_PATTERNS[type] || HAPTIC_PATTERNS.light;
    try { navigator.vibrate(pattern); } catch (e) { /* 一部ブラウザは例外を投げるが無視してよい */ }
  }

  // ============================================================
  // Materialize: 要素を「ガラスとして凝縮させながら」出現させる
  // 既存のDOM要素にクラスを付け直すことでアニメーションを(再)発火させる。
  // ============================================================
  function materializeIn(el, light) {
    if (!el) return;
    const cls = light ? 'glass-materialize-light' : 'glass-materialize';
    el.classList.remove(cls);
    // reflowを挟まないとブラウザがクラス除去+再追加を1回のスタイル計算にまとめてしまい、
    // アニメーションが発火しない(CSSアニメーションの既知の挙動)
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // 要素を消す前に退場アニメーションを再生してから実際に削除/非表示にする。
  // onDone は「アニメーションが終わって実際にDOM操作してよいタイミング」で呼ばれる。
  function dematerialize(el, onDone) {
    if (!el) { if (onDone) onDone(); return; }
    el.classList.add('glass-dematerialize');
    const handler = () => {
      el.removeEventListener('animationend', handler);
      if (onDone) onDone();
    };
    el.addEventListener('animationend', handler, { once: true });
    // prefers-reduced-motion等でアニメーションが実質0msの場合、
    // animationendが発火しない環境向けの保険(最大400ms待って強制発火)
    setTimeout(handler, 400);
  }

  // ============================================================
  // Fluid Morphing (matchedGeometryEffect 相当)
  // View Transitions API (document.startViewTransition) を使うと、
  // DOM更新の前後でスクリーンショット的な差分を取り、ブラウザが自動で
  // 形状・位置・サイズの補間アニメーションを作ってくれる。
  // Chrome/Android で広くサポートされているため、今回のAndroid中心の
  // 運用方針と相性がよい。非対応ブラウザでは即座に更新するだけの
  // フォールバックになる(見た目が多少カクつくだけで機能は失われない)。
  // ============================================================
  function glassMorph(updateFn) {
    if (document.startViewTransition) {
      try {
        return document.startViewTransition(updateFn);
      } catch (e) {
        updateFn();
      }
    } else {
      updateFn();
    }
  }

  // 特定の要素に一意な view-transition-name を振って、次のglassMorph()呼び出しで
  // その要素の形状/位置がなめらかに補間されるようにする(SwiftUIのglassEffectID
  // + Namespace に相当)。呼び出し後は名前が競合しないよう自動で解除する。
  let morphTagCounter = 0;
  function glassMorphTag(el, name) {
    if (!el || !('viewTransitionName' in el.style)) return;
    const tagName = name || `glass-morph-${morphTagCounter++}`;
    el.style.viewTransitionName = tagName;
  }
  function glassMorphUntag(el) {
    if (!el) return;
    el.style.viewTransitionName = '';
  }

  // ============================================================
  // グローバル公開 (window.LiquidGlass.xxx として各ページから利用)
  // ============================================================
  window.LiquidGlass = {
    haptic,
    materializeIn,
    dematerialize,
    glassMorph,
    glassMorphTag,
    glassMorphUntag,
  };

  // タップ操作全般への軽い触感フィードバックを、明示的な個別呼び出し無しでも
  // ある程度カバーするため、glass-interactive クラスが付いた要素のタップに
  // 自動でlightハプティクスを鳴らす(個別に強いフィードバックが必要な操作は
  // 各ページ側でhaptic('medium')等を明示的に呼べば上書きできる)。
  document.addEventListener('click', (e) => {
    const target = e.target.closest('.glass-interactive');
    if (target && !target.dataset.noAutoHaptic) {
      haptic('light');
    }
  }, { passive: true });

})();
