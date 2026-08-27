// public/js/liquidGlass.js
// -----------------------------------------------------------------------
// Liquid Glass デザインシステム共通JS
// Codepen (glassThickness/bezelWidth/ior/scaleRatio) 準拠のSVGフィルターエンジン搭載
// -----------------------------------------------------------------------
(function () {

  // ============================================================
  // Liquid Glass SVGフィルターエンジン (Codepen準拠)
  // glassThickness: ガラスの厚み(屈折量)
  // bezelWidth: ベゼル幅(縁の太さ)
  // ior: 屈折率 (1.4 = ガラス相当)
  // scaleRatio: スケール比
  // specularOpacity: 光沢の強さ
  // ============================================================
  const DEFAULT_CONFIG = {
    glassThickness: 80,
    bezelWidth: 40,
    ior: 1.4,
    scaleRatio: 1.0,
    blur: 1,
    specularOpacity: 0.6,
    specularSat: 0,
    tintColor: '255,255,255',
    tintOpacity: 0,
  };

  // ボタン用(小さめ・軽め)
  const BTN_CONFIG = {
    glassThickness: 30,
    bezelWidth: 40,
    ior: 1.4,
    scaleRatio: 1.0,
    blur: 0,
    specularOpacity: 0.5,
    specularSat: 0,
    tintColor: '255,255,255',
    tintOpacity: 0,
  };

  const SurfaceEquations = {
    convex_squircle: (x) => Math.pow(1 - Math.pow(1 - x, 4), 1/4)
  };

  function calcDisplacement1D(gt, bw, sf, ri, s=128) {
    const e = 1/ri, r = [];
    for (let i = 0; i < s; i++) {
      const x = i/s, y = sf(x);
      const dx = x < 1 ? 0.0001 : -0.0001;
      const d = (sf(Math.max(0, Math.min(1, x+dx))) - y) / dx;
      const m = Math.sqrt(d*d+1);
      const n = [-d/m, -1/m];
      const dt = n[1];
      const k = 1 - e*e*(1-dt*dt);
      if (k < 0) { r.push(0); }
      else {
        const rf = [-(e*dt+Math.sqrt(k))*n[0], e-(e*dt+Math.sqrt(k))*n[1]];
        r.push(rf[0]*((y*bw+gt)/rf[1]));
      }
    }
    return r;
  }

  function calcDisplacement2D(cw, ch, ow, oh, rad, bw, md, pMap) {
    const img = new ImageData(cw, ch);
    for (let i = 0; i < img.data.length; i+=4) { img.data[i]=128; img.data[i+1]=128; img.data[i+3]=255; }
    const rSq=rad*rad, rp1Sq=(rad+1)**2, rmBwSq=Math.max(0,rad-bw)**2;
    const wB=ow-rad*2, hB=oh-rad*2, oX=(cw-ow)/2, oY=(ch-oh)/2;
    for (let y1=0; y1<oh; y1++) {
      for (let x1=0; x1<ow; x1++) {
        const idx=((oY+y1)*cw+oX+x1)*4;
        const x=x1<rad?x1-rad:x1>=ow-rad?x1-rad-wB:0;
        const y=y1<rad?y1-rad:y1>=oh-rad?y1-rad-hB:0;
        const dSq=x*x+y*y;
        if (dSq<=rp1Sq && dSq>=rmBwSq) {
          const dist=Math.sqrt(dSq);
          const op=dSq<rSq?1:1-(dist-rad)/(Math.sqrt(rp1Sq)-rad);
          const bIdx=Math.floor(Math.max(0,Math.min(1,(rad-dist)/bw))*pMap.length);
          const dVal=pMap[Math.max(0,Math.min(bIdx,pMap.length-1))]||0;
          const dX=md>0?(-(dist>0?x/dist:0)*dVal)/md:0;
          const dY=md>0?(-(dist>0?y/dist:0)*dVal)/md:0;
          img.data[idx]=Math.max(0,Math.min(255,128+dX*127*op));
          img.data[idx+1]=Math.max(0,Math.min(255,128+dY*127*op));
        }
      }
    }
    return img;
  }

  function calcSpecular(ow, oh, rad) {
    const img = new ImageData(ow, oh);
    const sVec=[Math.cos(Math.PI/3), Math.sin(Math.PI/3)];
    const rSq=rad*rad, rp1Sq=(rad+1)**2, rmSSq=Math.max(0,(rad-1.5)**2);
    for (let y1=0; y1<oh; y1++) {
      for (let x1=0; x1<ow; x1++) {
        const x=x1<rad?x1-rad:x1>=ow-rad?x1-rad-(ow-rad*2):0;
        const y=y1<rad?y1-rad:y1>=oh-rad?y1-rad-(oh-rad*2):0;
        const dSq=x*x+y*y;
        if (dSq<=rp1Sq && dSq>=rmSSq) {
          const dist=Math.sqrt(dSq);
          const op=dSq<rSq?1:1-(dist-rad)/(Math.sqrt(rp1Sq)-rad);
          const dp=Math.abs((dist>0?x/dist:0)*sVec[0]+(dist>0?-y/dist:0)*sVec[1]);
          const cf=dp*Math.sqrt(1-(1-Math.max(0,Math.min(1,(rad-dist)/1.5)))**2);
          const c=Math.min(255,255*cf);
          const idx=(y1*ow+x1)*4;
          img.data[idx]=img.data[idx+1]=img.data[idx+2]=c;
          img.data[idx+3]=Math.min(255,c*cf*op);
        }
      }
    }
    return img;
  }

  function imgToURL(img) {
    const c=document.createElement('canvas');
    c.width=img.width; c.height=img.height;
    c.getContext('2d').putImageData(img,0,0);
    return c.toDataURL();
  }

  // SVGフィルターを生成してDOMに挿入
  let filterIdCounter = 0;
  function createGlassFilter(w, h, rad, cfg) {
    const id = 'lg-filter-' + (filterIdCounter++);
    const bw = Math.round(cfg.bezelWidth/100 * Math.min(w,h)/2);
    const gt = cfg.glassThickness;
    const pMap = calcDisplacement1D(gt, bw, SurfaceEquations.convex_squircle, cfg.ior);
    const md = Math.max(...pMap.map(Math.abs)) || 1;
    const dispImg = imgToURL(calcDisplacement2D(w, h, w, h, rad, bw, md, pMap));
    const specImg = imgToURL(calcSpecular(w, h, rad));

    const scale = md * cfg.scaleRatio;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style','width:0;height:0;position:absolute');
    svg.setAttribute('aria-hidden','true');
    svg.innerHTML = `<defs>
      <filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="${cfg.blur}" result="blurred"/>
        <feImage href="${dispImg}" x="0" y="0" width="${w}" height="${h}" result="dmap" preserveAspectRatio="none"/>
        <feDisplacementMap in="blurred" in2="dmap" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="displaced"/>
        <feColorMatrix in="displaced" type="saturate" values="${1+cfg.specularSat}" result="saturated"/>
        <feImage href="${specImg}" x="0" y="0" width="${w}" height="${h}" result="specular" preserveAspectRatio="none"/>
        <feComposite in="saturated" in2="specular" operator="in" result="spec_sat"/>
        <feComponentTransfer in="specular" result="spec_fade"><feFuncA type="linear" slope="${cfg.specularOpacity}"/></feComponentTransfer>
        <feBlend in="spec_sat" in2="displaced" mode="normal" result="ws"/>
        <feBlend in="spec_fade" in2="ws" mode="normal"/>
      </filter>
    </defs>`;
    document.body.appendChild(svg);
    return id;
  }

  // 要素にLiquid Glassフィルターを適用
  function applyGlassFilter(el, cfg) {
    cfg = Object.assign({}, BTN_CONFIG, cfg || {});
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    const style = getComputedStyle(el);
    const rad = Math.round(parseFloat(style.borderRadius) || h/2);
    const filterId = createGlassFilter(w, h, Math.min(rad, Math.min(w,h)/2), cfg);

    // backdrop-filter: url() はChrome系のみサポート
    const useBackdrop = !!window.chrome;
    if (useBackdrop) {
      el.style.backdropFilter = `url(#${filterId})`;
      el.style.webkitBackdropFilter = `url(#${filterId})`;
    } else {
      el.style.filter = `url(#${filterId})`;
    }
  }

  // ページ内の全glassボタンにフィルターを適用
  function applyGlassFiltersToAll() {
    // 既にフィルター適用済みのものはスキップ
    const targets = document.querySelectorAll(
      '.glass-interactive:not([data-lg-applied]),' +
      '.btn-glass:not([data-lg-applied]),' +
      '.glass-send-btn:not([data-lg-applied]),' +
      '.glass-plus-btn:not([data-lg-applied]),' +
      '.glass-clear:not([data-lg-applied]),' +
      '.lg-btn:not([data-lg-applied])'
    );
    targets.forEach(el => {
      el.dataset.lgApplied = '1';
      // レイアウト完了後に適用（getBoundingClientRectが正確になってから）
      requestAnimationFrame(() => applyGlassFilter(el));
    });
  }

  // ============================================================
  // Haptic Feedback
  // ============================================================
  const HAPTIC_PATTERNS = {
    light: 10,
    medium: 20,
    selection: 8,
    success: [10, 40, 10],
    warning: [20, 40, 20],
    error: [30, 60, 30, 60, 30],
    call: [500, 300, 500, 300, 500],
  };
  function haptic(type) {
    if (!('vibrate' in navigator)) return;
    const pattern = HAPTIC_PATTERNS[type] || HAPTIC_PATTERNS.light;
    try { navigator.vibrate(pattern); } catch(e) {}
  }

  // ============================================================
  // Materialize アニメーション
  // ============================================================
  function materializeIn(el, light) {
    if (!el) return;
    const cls = light ? 'glass-materialize-light' : 'glass-materialize';
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function dematerialize(el, onDone) {
    if (!el) { if (onDone) onDone(); return; }
    el.classList.add('glass-dematerialize');
    const handler = () => {
      el.removeEventListener('animationend', handler);
      if (onDone) onDone();
    };
    el.addEventListener('animationend', handler, { once: true });
    setTimeout(handler, 400);
  }

  // ============================================================
  // View Transitions (glassMorph)
  // ============================================================
  function glassMorph(updateFn) {
    if (document.startViewTransition) {
      try { return document.startViewTransition(updateFn); } catch(e) { updateFn(); }
    } else { updateFn(); }
  }

  let morphTagCounter = 0;
  function glassMorphTag(el, name) {
    if (!el || !('viewTransitionName' in el.style)) return;
    el.style.viewTransitionName = name || `glass-morph-${morphTagCounter++}`;
  }
  function glassMorphUntag(el) {
    if (!el) return;
    el.style.viewTransitionName = '';
  }

  // ============================================================
  // グローバル公開
  // ============================================================
  window.LiquidGlass = {
    haptic,
    materializeIn,
    dematerialize,
    glassMorph,
    glassMorphTag,
    glassMorphUntag,
    applyGlassFilter,
    applyGlassFiltersToAll,
    createGlassFilter,
  };

  // タップ時のハプティクス + 膨らむフラッシュアニメーション
  document.addEventListener('click', (e) => {
    const target = e.target.closest('.glass-interactive');
    if (target && !target.dataset.noAutoHaptic) haptic('light');
  }, { passive: true });

  // DOMContentLoaded後に全ボタンへフィルター適用
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // レイアウト安定を待ってから適用
      setTimeout(applyGlassFiltersToAll, 300);
    });
  } else {
    setTimeout(applyGlassFiltersToAll, 300);
  }

})();
