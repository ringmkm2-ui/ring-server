// 起動演出(splash.html = / から呼ぶ)。しずくが集まって吹き出しになり「Bro」が出る →
// o の穴に飛び込むと向こうに地球があり、世界中が線でつながる → 地球ごと閉じて次の画面へ。
//  - 描画はWorker(OffscreenCanvas)で回す。メインが詰まってもカクつかない
//  - 再生はセッションで1回だけ。再読み込みや戻るでは出さない。画面を触れば飛ばせる
//  - 端末の「視差効果を減らす」/ 省アニメ設定では出さない
//  - WebGLが無い・遅い・何か失敗した時は黙って消す(起動は止めない)
(function () {
  var isWorker = typeof document === 'undefined';

  // ---------- 時間割(秒) ----------
  var T = { impact: 1.02, text: 1.42, sheen: 1.62, portal: 2.02, dive: 2.16, diveEnd: 2.8, close: 3.95, end: 4.55 };
  var DROPS = 6;
  var LOGO_R = 0.76;              // 吹き出しの横半径(短辺の半分=1)
  var HOLE = [0.426, -0.046];     // ロゴ上の o の穴の中心(吹き出しの横半径=1)
  var HOLE_R = 0.095;

  var SDF_B64 = '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7KLm3gWAD0aEC02xhCT3qqvUXwzztfyPgEhSnT2y4VMv41RB1THmuFRwmd/eJcBXsdADkETNATBib1M3f+jHLKsoSiZO77231o6jH70AAOw5xpprzalLzbO6CyIpq7SiahatAmBDDIzwCxXRLSWb0/sH9ickZi4NxByIiERKacfRe28ce1znHGOupXtvNYDfVMOAB5KUZWauqmtvtfu6DMLY5uEOKLXW3ltvqYanLgAAa5xzjrnWmmvvKwEiIEupZddsBEMFgAoBl+urzlJKqap71e/JjwhAzCJSmgFXd8iOn9Taeuut0J7nGOc45zjPMeaee6vaJ/Qp7EiA03w98pgHBAACEvo2dQ/kkvd9u1QgAAB6nmNcDrDW1uueReJSVt3m7h4BWACgZongqnvVUprqLqWu99DsF+yf0jtw0QgAYmSWUms7emPXNfNTjfOcY869P8v/AABYNrmtOVfmMbvzPiIjmHoEkJTSeq+15REAAE8nG2OuNdfcW69/x6WUtrdZFkVEDAAtzN13XaW0tXcpdRWR78kfAAClNDWPK2iBMFtbtbVeUG2veZ7jfH4ec6yEya4Gxu87irrnPMeca669t183GTIjgqo5kNRaS6mtttZ6qwAAsOaa53nOMcdaa6y9swIirqWtpu7hgYjMBwJANVOtu5S6+34gM+8oHV/If9zVAkiqWgQgEl/XbausYaa65/l8jrnUIpCkOHxGnoo155zn85iXC9h1AySwHcsCqSSYWGutrTUEANA5x8goG3OuMfeF8pHUsqp6Zg5iEakAQE1111UvNEAkAZT97fxfjwDicv05ZGQSKbVUCYdIxGqtbYEsxQGRyD4hUK8x5xxznmPMOdbUu5KjxAB0GUgptdYipdZaGwMAxFxzzZkaGHOuods88mYqpam7O2CWgAUBQEqpq6muu3deisgP5McOSJxxDYjIRCJSSiHdd55H4hJIJNkE3r+PABtzjjHnGOfzHCm/RUTiOYwA6sRSa7l9oCQKueaac60xzudzzLnWygSAIrsU83BHlKyAawUAaFv3Lmn3crvA2wD40v1PHUiWmgEEQlLdRAoDQmIgUh15lb3L4jIJ8d1r7o3515przDnneT6PNedWDQsAfGCAVBNMKLWUUmpejmvNtdacczyfz2dGjnoAopRVmpl7EA+us84yCwIA11XqfI2bMBPZD+p/Zhe4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';
  var LAND_B64 = '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'; // 陸地のマスク(正距円筒図法 512x256、Natural Earth)

  // 地球: 都市(緯度,経度)と、つなぐ線(どこから,どこへ,出る時刻)
  var CITY = { tyo: [35.68, 139.69], sel: [37.57, 126.98], sha: [31.23, 121.47], syd: [-33.87, 151.21], sin: [1.35, 103.82], bom: [19.08, 72.88],
    hnl: [21.31, -157.86], lax: [34.05, -118.24], mow: [55.76, 37.62], akl: [-36.85, 174.76], van: [49.28, -123.12], jkt: [-6.2, 106.85] };
  var ARCS = [['tyo', 'sel', 2.5], ['tyo', 'syd', 2.58], ['tyo', 'sin', 2.66], ['tyo', 'hnl', 2.74], ['sin', 'bom', 2.9], ['tyo', 'lax', 2.98],
    ['syd', 'akl', 3.08], ['sha', 'mow', 3.16], ['hnl', 'van', 3.24], ['jkt', 'syd', 3.3]];
  var ARC_GROW = 0.55, TILT = 0.42, SEG = 28;
  function yawAt(t) { return 2.52 - 0.28 * (t - 3.0); }
  function unit(ll) { var la = ll[0] * Math.PI / 180, lo = ll[1] * Math.PI / 180; return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]; }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function smooth(a, b, x) { var s = clamp01((x - a) / (b - a)); return s * s * (3 - 2 * s); }
  function spring(t, w, k) { return t <= 0 ? 0 : 1 - Math.exp(-k * t) * Math.cos(w * t); }

  // しずく i の位置と半径
  function dropAt(i, t, far) {
    var arrive = 0.5 + i * 0.1, win = 0.72, s = clamp01((t - (arrive - win)) / win);
    if (s <= 0 || s >= 1) return null;
    var e = Math.pow(s, 2.1);
    var a = (i * 2.399963) + 0.7 + 1.9 * (1 - e);
    var rad = (far + 0.3) * (1 - e);
    var r = 0.185 * (1 - smooth(0.82, 1, s) * 0.55);
    return { x: Math.cos(a) * rad, y: Math.sin(a) * rad, r: r, s: s };
  }

  // ---------- 描画(Worker / メイン共通) ----------
  var VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  var FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 uRes;uniform float uS,uT,uBloom,uForm,uMix,uBlob,uText,uSheen,uPortal,uZ,uDive,uFront,uMax,uE;',
    'uniform vec3 uDrops[6];uniform vec3 uBase,uAcc;uniform vec2 uF;uniform sampler2D uSdf,uLand;uniform float uR;',
    'uniform vec2 uGC;uniform float uGR,uTc,uTs,uYc,uYs,uOnly,uClose;',
    'const vec2 HOLE=vec2(' + HOLE[0] + ',' + HOLE[1] + ');const float HR=' + HOLE_R + ';',
    'float smin(float a,float b,float k){float h=max(k-abs(a-b),0.)/k;return min(a,b)-h*h*k*.25;}',
    'float n2(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);',
    ' float a=fract(sin(dot(i,vec2(127.1,311.7)))*43758.5),b=fract(sin(dot(i+vec2(1,0),vec2(127.1,311.7)))*43758.5),',
    ' c=fract(sin(dot(i+vec2(0,1),vec2(127.1,311.7)))*43758.5),d=fract(sin(dot(i+vec2(1,1),vec2(127.1,311.7)))*43758.5);',
    ' return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}',
    'vec2 toQ(vec2 p){return HOLE+(p-uF)/(uR*uZ);}',
    // 吹き出しの形(ロゴの輪郭に合わせた楕円+しっぽ)。qの単位
    'float bubble(vec2 q){',
    ' float k=length(q/vec2(1.,.805));float d=(k-1.)*.805*min(1.,1./max(k*.9,.5));',
    ' vec2 a=vec2(-.60,-.40),b=vec2(-.862,-.79);vec2 pa=q-a,ba=b-a;float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.);',
    ' float tl=length(pa-ba*h)-mix(.22,.018,pow(h,.72));',
    ' return smin(d,tl,.1);}',
    'float mapP(vec2 p){',
    ' float bb=1e3;',
    ' if(uMix<1.){bb=length(p)-uBlob;for(int i=0;i<6;i++){if(uDrops[i].z>0.)bb=smin(bb,length(p-uDrops[i].xy)-uDrops[i].z,.16);}}',
    ' if(uMix<=0.)return bb;',
    ' float d=bubble(toQ(p))*uR*uZ;',
    ' return uMix>=1.?d:mix(bb,d,uMix);}',
    // 地の色: 深い色のオーロラ。衝撃波が通ると明るいブランド色に変わる
    'vec3 deepC(vec2 p,out float f){',
    ' float t=uT*.55;vec2 w=p+.28*vec2(sin(p.y*1.7+t),cos(p.x*1.4-t*.8));',
    ' f=.5+.5*sin(w.x*1.5+w.y*1.2+t*1.2);float g=.5+.5*sin(w.y*2.1-w.x*.8-t);',
    ' return mix(uAcc*.06+vec3(.012,.014,.03),uAcc*.3+vec3(.01,.015,.05),f*f)+uAcc*.2*g*g*g;}',
    'vec3 ground(vec2 p){',
    ' float f;vec3 deep=deepC(p,f);',
    ' float L=length(p);float front=smoothstep(uFront,uFront-.9,L);',
    ' vec3 lit=mix(uAcc*.92,mix(uAcc,vec3(1.),.42),clamp(.5-.28*(p.x-p.y)+.14*f,0.,1.));',
    ' return mix(deep,lit,front*step(.001,uFront));}',
    // 穴の向こうの宇宙と地球(点描の大陸)
    'vec3 sceneG(vec2 p){',
    ' float f;vec3 c=deepC(p*.6,f)*.85;',
    ' vec2 sc=floor(p*70.);float hs=fract(sin(dot(sc,vec2(41.3,289.1)))*45758.5);',
    ' if(hs>.984){vec2 fs=fract(p*70.)-.5;c+=vec3(.85,.95,1.)*smoothstep(.24,0.,length(fs))*(.55+.45*sin(uT*5.+hs*90.));}',
    ' vec2 d=(p-uGC)/uGR;float r2=dot(d,d);float r=sqrt(r2);float gpx=1./(uS*uGR);',
    ' c+=mix(uAcc,vec3(1.),.35)*exp(-max(r-1.,0.)*6.)*.55*smoothstep(.5,1.,r);',
    ' if(r<1.+gpx){',
    '  float z=sqrt(max(1.-r2,0.));vec3 n=vec3(d,z);',
    '  vec3 m=vec3(n.x,uTc*n.y+uTs*n.z,-uTs*n.y+uTc*n.z);m=vec3(uYc*m.x+uYs*m.z,m.y,-uYs*m.x+uYc*m.z);',
    '  float lat=asin(clamp(m.y,-1.,1.));float lon=atan(m.x,m.z);',
    '  const float SP=.042;float gy=lat/SP;float latc=(floor(gy)+.5)*SP;float cl=max(cos(latc),.06);',
    '  float gx=lon*cl/SP;float lonc=(floor(gx)+.5)*SP/cl;vec2 fc=vec2(fract(gx),fract(gy))-.5;',
    '  float land=texture2D(uLand,vec2(lonc/6.28318+.5,.5-latc/3.14159)).r;',
    '  float cell=SP*uGR*uS*max(z,.15);float aa=clamp(1.3/max(cell,1.),.04,.5);',
    '  float dm=smoothstep(.36+aa,.36-aa,length(fc));',
    '  vec3 l=normalize(vec3(-.45,.55,.7));float lam=max(dot(n,l),0.);',
    '  vec3 g=mix(uAcc*.07+vec3(.008,.016,.04),uAcc*.32+vec3(.02,.04,.08),lam);',
    '  g+=mix(uAcc,vec3(1.),.55)*(.4+.8*lam)*dm*mix(.06,1.,land);',
    '  g+=mix(uAcc,vec3(1.),.5)*pow(1.-z,3.)*.9;',
    '  g+=vec3(1.)*pow(max(dot(reflect(-l,n),vec3(0.,0.,1.)),0.),40.)*.2;',
    '  c=mix(c,g,smoothstep(1.+gpx,1.-gpx,r));',
    ' }',
    ' return c;}',
    'void main(){',
    ' vec2 p=(gl_FragCoord.xy-.5*uRes)/uS;float px=1./uS;',
    ' float L=length(p);',
    ' float dith=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5)-.5)/255.;',
    // 飛び込んだ後は地球だけ。最後は宇宙ごと円に縮んで閉じる(外は透明=下の色)
    ' if(uOnly>.5){',
    '  vec3 c=sceneG(p);float a=1.;',
    '  if(uClose<50.){float an=atan(p.y,p.x);float w=(n2(vec2(an*2.3,uT*1.5)+3.)-.5)*.35+(n2(vec2(an*6.,-uT*2.))-.5)*.12;',
    '   float e=L+w*min(uClose,.6)-uClose;a=smoothstep(.035,-.035,e);c+=mix(uAcc,vec3(1.),.4)*smoothstep(.25,0.,abs(e))*.7;}',
    '  c+=dith;gl_FragColor=vec4(c*a,a);return;',
    ' }',
    ' vec3 col=ground(p);',
    // 衝撃波のリング
    ' if(uFront>0.&&uFront<uMax+1.){float r=abs(L-uFront);col+=mix(uAcc,vec3(1.),.72)*exp(-r*r*160.)*.9*(1.-smoothstep(1.,uMax+1.,uFront));}',
    ' float d=mapP(p);',
    // 外側: 周りの光と影
    ' if(d>0.){float gl=exp(-d*3.6);float sh=exp(-d*14.)*.28*uMix;col*=1.-sh;col+=mix(uAcc,vec3(1.),.35)*gl*.2*(1.-.55*step(.001,uFront));}',
    ' else{',
    '  vec2 ex=vec2(uE,0.);vec2 g=vec2(mapP(p+ex.xy)-d,mapP(p+ex.yx)-d)/uE;',
    '  float W=.17*uZ*max(uMix,.3);float rim=clamp(-d/W,0.,1.);float h=sqrt(max(1.-(1.-rim)*(1.-rim),.0));',
    '  float sl=(1.-rim)/max(h,.12);vec3 n=normalize(vec3(g*sl,1.));',
    '  vec2 off=-n.xy*.34*(1.-rim*.82)/max(uZ*.25,1.);',
    '  vec3 re=vec3(ground(p+off).r,ground(p+off*1.1).g,ground(p+off*1.22).b);',
    '  vec2 q=toQ(p);',
    // すりガラス: ロゴと同じ、左上が明るく右下に抜ける乳白
    '  float grad=clamp(.5-.42*(q.x-q.y),0.,1.);',
    '  float milk=uMix*(.42+.42*grad);col=mix(re,mix(vec3(.9,.97,.93),vec3(1.),grad),milk);',
    '  vec3 v=vec3(0.,0.,1.);vec3 l1=normalize(vec3(-.55,.75,.7));vec3 hv=normalize(l1+v);',
    '  float sp=pow(max(dot(n,hv),0.),70.);float sp2=pow(max(dot(n,normalize(vec3(.6,-.7,.5))),0.),14.);',
    '  float fr=pow(1.-n.z,2.6);',
    '  col+=vec3(1.)*sp*1.1;col+=mix(uAcc,vec3(1.),.6)*sp2*.5;col=mix(col,vec3(1.),fr*.5);',
    '  col+=vec3(1.)*smoothstep(-.012*uZ,0.,d)*.65;',
    // ひかりの帯
    '  if(uSheen>0.&&uSheen<1.){float b=(q.x-q.y)*.7-mix(-1.2,1.2,uSheen);col+=vec3(1.)*exp(-b*b*38.)*.55;}',
    // 文字(ロゴから作った距離場)
    '  if(uText>0.){',
    '   vec2 tp=vec2(600.+q.x*338.,583.-q.y*338.);vec2 uv=vec2((tp.x-360.)/510.,(tp.y-450.)/260.);',
    '   if(uv.x>0.&&uv.x<1.&&uv.y>0.&&uv.y<1.){',
    '    float td=(texture2D(uSdf,uv).r-.5)*40./338.;',
    '    float aa=max(px/(uR*uZ)*1.4,.002);float grow=mix(-.05,0.,uText);float inT=smoothstep(-aa,aa,td+grow);',
    '    vec3 tc=mix(uAcc,mix(uAcc,vec3(1.),.22),clamp(.5-.4*(q.x-q.y),0.,1.));',
    '    float inner=smoothstep(.016,0.,td);vec3 tt=tc*(1.-inner*.16);',
    '    col=mix(col,tt,inT*smoothstep(0.,.25,uText));',
    '    col+=vec3(1.)*smoothstep(.014,0.,abs(td+.006))*(1.-inT)*.18*uText;',
    '   }',
    '  }',
    ' }',
    // o の穴が開く。向こうに地球
    ' if(uPortal>0.){',
    '  vec2 q=toQ(p);float ds=(length((q-HOLE)/vec2(1.,1.02))-HR*uPortal)*uR*uZ;',
    '  float hm=1.-smoothstep(-px*1.3,px*1.3,ds);',
    '  float dd=max(ds,0.);vec3 rb=vec3(exp(-dd*30.),exp(-dd*42.),exp(-dd*58.));col+=rb*1.15*(1.-uDive*.5)*(1.-hm);',
    '  col+=mix(uAcc,vec3(1.),.5)*exp(-dd*7.)*.35*uPortal*(1.-hm);',
    '  if(hm>0.)col=mix(col,sceneG(p),hm);',
    ' }',
    // 飛び込む時の光の筋
    ' if(uDive>0.){float a=atan(p.y,p.x);float st=n2(vec2(a*9.,uT*2.))*n2(vec2(a*23.,3.));col+=vec3(1.)*pow(st,3.)*uDive*smoothstep(.1,1.8,L)*1.1;}',
    // 最初のインク: 下地の色(ネイティブと同じ色)から滲んで広がる
    ' if(uBloom<1.){float a=atan(p.y,p.x);float w=(n2(vec2(a*2.3,uT*1.5)+3.)-.5)*.5+(n2(vec2(a*6.,-uT*2.))-.5)*.2;',
    '  float R=uBloom*(uMax+.9);float e=L+w*min(R*1.2,.8)-R;float m=smoothstep(.09,-.09,e);',
    '  vec3 ec=mix(uAcc,vec3(1.),.25)*smoothstep(.34,0.,abs(e))*.5;col=mix(uBase,col+ec,m);}',
    ' gl_FragColor=vec4(col+dith,1.);',
    '}'
  ].join('\n');

  // 地球をつなぐ光の線(帯の三角形をJSで作って足し算で重ねる)。穴/閉じる円の外は描かない
  var VS2 = 'attribute vec4 a0;attribute vec2 a1;uniform vec2 uK;varying vec2 vUV,vP,vK;void main(){vP=a0.xy;vUV=a0.zw;vK=a1;gl_Position=vec4(a0.x*uK.x,a0.y*uK.y,0.,1.);}';
  var FS2 = 'precision mediump float;varying vec2 vUV,vP,vK;uniform vec3 uClip,uAcc;void main(){' +
    'if(length(vP-uClip.xy)>uClip.z)discard;float r=length(vUV);' +
    'float a=vK.y<.5?smoothstep(1.,0.,r):smoothstep(.28,0.,abs(r-.72));a*=vK.x*1.35;' +
    'gl_FragColor=vec4(mix(uAcc,vec3(1.),.62)*a,0.);}';

  function bytes(b64) { var s = atob(b64), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  // PNG(base64) -> 画像。Workerでもページでも使える形で
  function decode(b64) {
    var blob = new Blob([bytes(b64)], { type: 'image/png' });
    if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
    return new Promise(function (ok, ng) { var img = new Image(), u = URL.createObjectURL(blob); img.onload = function () { URL.revokeObjectURL(u); ok(img); }; img.onerror = ng; img.src = u; });
  }
  function loadTex() { return Promise.all([decode(SDF_B64), decode(LAND_B64)]); }

  function makeRenderer(canvas, o) {
    var gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('no webgl');
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
    var pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('link');
    gl.useProgram(pr);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = {}; ['uRes', 'uS', 'uT', 'uBloom', 'uForm', 'uMix', 'uBlob', 'uText', 'uSheen', 'uPortal', 'uZ', 'uDive', 'uFront', 'uMax', 'uE', 'uDrops', 'uBase', 'uAcc', 'uF', 'uSdf', 'uLand', 'uR',
      'uGC', 'uGR', 'uTc', 'uTs', 'uYc', 'uYs', 'uOnly', 'uClose'].forEach(function (n) { U[n] = gl.getUniformLocation(pr, n); });
    gl.uniform3fv(U.uBase, o.base); gl.uniform3fv(U.uAcc, o.accent); gl.uniform1i(U.uSdf, 0); gl.uniform1i(U.uLand, 1);
    gl.uniform1f(U.uTc, Math.cos(TILT)); gl.uniform1f(U.uTs, Math.sin(TILT));

    var pr2 = gl.createProgram(); gl.attachShader(pr2, sh(gl.VERTEX_SHADER, VS2)); gl.attachShader(pr2, sh(gl.FRAGMENT_SHADER, FS2)); gl.linkProgram(pr2);
    if (!gl.getProgramParameter(pr2, gl.LINK_STATUS)) throw new Error('link2');
    var l0 = gl.getAttribLocation(pr2, 'a0'), l1 = gl.getAttribLocation(pr2, 'a1');
    var U2 = { k: gl.getUniformLocation(pr2, 'uK'), clip: gl.getUniformLocation(pr2, 'uClip') };
    gl.useProgram(pr2); gl.uniform3fv(gl.getUniformLocation(pr2, 'uAcc'), o.accent); gl.useProgram(pr);
    var buf2 = gl.createBuffer();
    var MAXV = ARCS.length * (SEG * 6 + 36);
    var vb = new Float32Array(MAXV * 6);
    var arcs = ARCS.map(function (a) {
      var A = unit(CITY[a[0]]), B = unit(CITY[a[1]]);
      var ang = Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));
      return { A: A, B: B, ang: ang, t0: a[2], hgt: 0.1 + 0.2 * ang / Math.PI };
    });

    var scale = o.scale, w = o.w, h = o.h, S = Math.min(Math.min(w, h) / 2, 240);
    var far = Math.sqrt(w * w + h * h) / 2 / S;
    var gMax = 0.8 * Math.min(w, h) / 2 / S;
    gl.useProgram(pr2); gl.uniform2f(U2.k, S / (w / 2), S / (h / 2)); gl.useProgram(pr);
    var zEnd = (far + 0.35) / (HOLE_R * LOGO_R);
    function size() { canvas.width = Math.max(2, Math.round(w * scale)); canvas.height = Math.max(2, Math.round(h * scale)); gl.viewport(0, 0, canvas.width, canvas.height); gl.uniform2f(U.uRes, canvas.width, canvas.height); gl.uniform1f(U.uS, S * scale); gl.uniform1f(U.uMax, far); }
    size();
    var dr = new Float32Array(DROPS * 3);

    function draw(t) {
      gl.uniform1f(U.uT, t);
      var be = clamp01(t / 0.62); gl.uniform1f(U.uBloom, 1 - Math.pow(1 - be, 2.6));
      var count = 0;
      for (var i = 0; i < DROPS; i++) {
        var d = dropAt(i, t, far);
        dr[i * 3] = d ? d.x : 0; dr[i * 3 + 1] = d ? d.y : 0; dr[i * 3 + 2] = d ? d.r : 0;
        if (t >= 0.5 + i * 0.1) count++;
      }
      gl.uniform3fv(U.uDrops, dr);
      var pre = t < T.impact ? 0.03 + count * 0.034 + 0.02 * Math.sin(t * 22) * smooth(0.5, 1, t) : 0.25;
      gl.uniform1f(U.uBlob, pre);
      var tau = t - T.impact;
      var mix = smooth(0, 0.3, tau); gl.uniform1f(U.uMix, mix);
      var sp = spring(tau, 13, 6.5);
      gl.uniform1f(U.uForm, sp);
      gl.uniform1f(U.uFront, tau > 0 ? tau * (far + 1) * 2.7 * (1 - 0.3 * clamp01(tau)) : 0);
      gl.uniform1f(U.uText, smooth(T.text, T.text + 0.34, t));
      gl.uniform1f(U.uSheen, clamp01((t - T.sheen) / 0.5));
      var por = smooth(T.portal, T.dive + 0.08, t); gl.uniform1f(U.uPortal, por);
      var ds = clamp01((t - T.dive) / (T.diveEnd - T.dive));
      gl.uniform1f(U.uDive, smooth(0, 0.35, ds) * (1 - smooth(0.85, 1, ds)));
      // 飛び込む直前に一瞬だけ引く(溜め)
      var anti = 1 - 0.07 * smooth(T.portal - 0.12, T.dive, t) * (1 - smooth(0, 0.14, ds));
      var eased = Math.pow(ds, 3.1);
      var z = anti * Math.exp(Math.log(zEnd) * eased);
      gl.uniform1f(U.uZ, z);
      var R = LOGO_R * (mix > 0 ? 0.78 + 0.22 * sp : 0.78);
      gl.uniform1f(U.uR, R);
      var k = 1 - smooth(0.05, 0.75, ds);
      gl.uniform2f(U.uF, HOLE[0] * R * k, HOLE[1] * R * k);
      gl.uniform1f(U.uE, 0.006 * z);
      // 地球
      var fx = HOLE[0] * R * k, fy = HOLE[1] * R * k;
      var cl = clamp01((t - T.close) / (T.end - T.close)), ce = cl < 0.5 ? 4 * cl * cl * cl : 1 - Math.pow(-2 * cl + 2, 3) / 2;
      var gR = Math.min(0.055 * Math.pow(z, 0.75), gMax) * (1 + 0.05 * smooth(T.diveEnd, T.close, t)) * (1 - ce);
      var yaw = yawAt(t), yc = Math.cos(yaw), ys = Math.sin(yaw);
      gl.uniform2f(U.uGC, fx, fy); gl.uniform1f(U.uGR, Math.max(gR, 1e-4));
      gl.uniform1f(U.uYc, yc); gl.uniform1f(U.uYs, ys);
      var only = ds >= 1, cr = (far + 0.5) * (1 - ce);
      gl.uniform1f(U.uOnly, only ? 1 : 0); gl.uniform1f(U.uClose, cl > 0 ? cr : 1e3);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (por <= 0 || gR < 0.01) return;
      var n = buildArcs(t, fx, fy, gR, yc, ys);
      if (!n) return;
      gl.useProgram(pr2);
      gl.uniform3f(U2.clip, fx, fy, only ? (cl > 0 ? cr : 1e3) : HOLE_R * por * R * z);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf2); gl.bufferData(gl.ARRAY_BUFFER, vb.subarray(0, n * 6), gl.STREAM_DRAW);
      gl.enableVertexAttribArray(l0); gl.vertexAttribPointer(l0, 4, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(l1); gl.vertexAttribPointer(l1, 2, gl.FLOAT, false, 24, 16);
      gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, 0, n);
      gl.disable(gl.BLEND); gl.disableVertexAttribArray(l1);
      gl.useProgram(pr);
    }

    // 線の三角形を作る。地球の裏に回った所は消す
    var nv = 0;
    function put(x, y, u, v, a, kind) { var i = nv * 6; vb[i] = x; vb[i + 1] = y; vb[i + 2] = u; vb[i + 3] = v; vb[i + 4] = a; vb[i + 5] = kind; nv++; }
    function quad(x, y, r, a, kind) {
      put(x - r, y - r, -1, -1, a, kind); put(x + r, y - r, 1, -1, a, kind); put(x + r, y + r, 1, 1, a, kind);
      put(x - r, y - r, -1, -1, a, kind); put(x + r, y + r, 1, 1, a, kind); put(x - r, y + r, -1, 1, a, kind);
    }
    function buildArcs(t, cx, cy, gR, yc, ys) {
      nv = 0;
      var tc = Math.cos(TILT), ts = Math.sin(TILT), px = 1 / S;
      var fade = 1 - smooth(T.close - 0.2, T.close + 0.15, t);
      if (fade <= 0) return 0;
      var P = [];
      function proj(m, out) {
        var x1 = yc * m[0] - ys * m[2], z1 = ys * m[0] + yc * m[2], y1 = m[1];
        var x = x1, y = tc * y1 - ts * z1, zz = ts * y1 + tc * z1;
        var rr = Math.sqrt(x * x + y * y);
        out[0] = cx + gR * x; out[1] = cy + gR * y; out[2] = zz >= 0 ? 1 : smooth(1.0, 1.08, rr);
        return out;
      }
      for (var i = 0; i < arcs.length; i++) {
        var ac = arcs[i], g = clamp01((t - ac.t0) / ARC_GROW);
        if (g <= 0) continue;
        var ge = 1 - Math.pow(1 - g, 2.2), sa = Math.sin(ac.ang) || 1e-4, cnt = Math.max(2, Math.ceil(SEG * ge));
        P.length = 0;
        for (var j = 0; j <= cnt; j++) {
          var s = ge * j / cnt, wa = Math.sin((1 - s) * ac.ang) / sa, wb = Math.sin(s * ac.ang) / sa, lift = 1 + ac.hgt * Math.sin(Math.PI * s);
          P.push(proj([(wa * ac.A[0] + wb * ac.B[0]) * lift, (wa * ac.A[1] + wb * ac.B[1]) * lift, (wa * ac.A[2] + wb * ac.B[2]) * lift], [0, 0, 0]).concat([s]));
        }
        var hw = 2.1 * px;
        for (j = 0; j < cnt; j++) {
          var p0 = P[j], p1 = P[j + 1], dx = p1[0] - p0[0], dy = p1[1] - p0[1], dl = Math.sqrt(dx * dx + dy * dy) || 1;
          var nx = -dy / dl * hw, ny = dx / dl * hw;
          var a0 = p0[2] * fade * (0.3 + 0.7 * smooth(ge - 0.45, ge, p0[3])), a1 = p1[2] * fade * (0.3 + 0.7 * smooth(ge - 0.45, ge, p1[3]));
          put(p0[0] + nx, p0[1] + ny, 0, 1, a0, 0); put(p0[0] - nx, p0[1] - ny, 0, -1, a0, 0); put(p1[0] + nx, p1[1] + ny, 0, 1, a1, 0);
          put(p0[0] - nx, p0[1] - ny, 0, -1, a0, 0); put(p1[0] - nx, p1[1] - ny, 0, -1, a1, 0); put(p1[0] + nx, p1[1] + ny, 0, 1, a1, 0);
        }
        var st = P[0], hd = P[cnt];
        quad(st[0], st[1], 3.6 * px, st[2] * fade, 0);
        if (g < 1) quad(hd[0], hd[1], 7 * px, hd[2] * fade, 0);
        else {
          var age = t - ac.t0 - ARC_GROW;
          quad(hd[0], hd[1], 3.6 * px, hd[2] * fade, 0);
          if (age < 0.7) quad(hd[0], hd[1], (5 + 26 * age) * px, hd[2] * fade * (1 - age / 0.7), 1);
        }
      }
      return nv;
    }
    return {
      draw: draw,
      slower: function () { if (scale <= o.scale * 0.5) return; scale *= 0.72; size(); },
      setTextures: function (imgs) {
        imgs.forEach(function (img, i) {
          var tx = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tx);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, i === 1 ? gl.REPEAT : gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        });
        gl.activeTexture(gl.TEXTURE0);
      },
      clear: function () { gl.clearColor(o.base[0], o.base[1], o.base[2], 1); gl.clear(gl.COLOR_BUFFER_BIT); },
      lose: function () { try { var e = gl.getExtension('WEBGL_lose_context'); if (e) e.loseContext(); } catch (e2) {} }
    };
  }

  function runLoop(rd, startAt, now, raf, onEnd) {
    var last = 0, n = 0, sum = 0, stopped = false, tried = 0;
    function frame() {
      if (stopped) return;
      var ms = now(), t = (ms - startAt) / 1000;
      if (t >= T.end) { onEnd(); return; }
      if (t >= 0) {
        rd.draw(t);
        if (last) {
          sum += ms - last; n++;
          // 重い端末は解像度を落として滑らかさを取る(2回まで)
          if (n === 10) { if (sum / n > 24 && tried < 2) { tried++; rd.slower(); } n = 0; sum = 0; }
        }
        last = ms;
      }
      raf(frame);
    }
    raf(frame);
    return function () { stopped = true; };
  }

  // ---------- Worker側 ----------
  if (isWorker) {
    var rdW = null, stopW = null;
    var abs = function () { return performance.timeOrigin + performance.now(); };
    self.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.type === 'init') {
        try {
          rdW = makeRenderer(m.canvas, m.opts);
          loadTex().then(function (imgs) {
            rdW.setTextures(imgs);
            rdW.clear();
            self.requestAnimationFrame(function () { self.postMessage({ type: 'ready' }); });
          }).catch(function (e) { self.postMessage({ type: 'fail', error: String(e) }); });
        } catch (e) { self.postMessage({ type: 'fail', error: String(e) }); }
      } else if (m.type === 'go' && rdW) {
        stopW = runLoop(rdW, m.at, abs, function (f) { self.requestAnimationFrame(f); }, function () { self.postMessage({ type: 'done' }); });
      } else if (m.type === 'stop') {
        if (stopW) stopW();
        if (rdW) rdW.lose();
      }
    };
    return;
  }

  // ---------- ページ側 ----------
  var S_DONE = 'bro_intro_done';
  var ACCENT = { green: '#1fd655', blue: '#2f8df0', orange: '#f5793a', pink: '#ee4fa6', purple: '#8a4ff0', mono: '#8e8e93', dark: '#3d4656' };
  var doc = document, root = doc.documentElement;

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function rgb(hex) { if (hex.length === 4) hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]; var n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  function enabled() {
    if (ls('batterySaverAnimations') === '1') return false;
    return !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function isColdStart() {
    try {
      if (sessionStorage.getItem(S_DONE)) return false;
      sessionStorage.setItem(S_DONE, '1');
    } catch (e) { return false; }
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (nav && (nav.type === 'reload' || nav.type === 'back_forward')) return false;
    return true;
  }
  var active = null;

  function play(opts) {
    opts = opts || {};
    if (active) return null;
    var w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return null;

    var st = doc.createElement('style');
    st.textContent =
      '#broIntro{position:fixed;inset:0;z-index:2147482000;overflow:hidden;contain:strict;touch-action:none;-webkit-user-select:none;user-select:none;transition:opacity .2s ease}' +
      '#broIntro canvas{position:absolute;inset:0;width:100%;height:100%;display:block}' +
      '#broIntro .bi-cover{position:absolute;inset:0}';
    var base = rgb(opts.base || '#ffffff'); // 次の画面の背景色。最初と最後はこの色になる
    var box = doc.createElement('div'); box.id = 'broIntro'; box.setAttribute('aria-hidden', 'true');
    var cv = doc.createElement('canvas');
    var cover = doc.createElement('div'); cover.className = 'bi-cover';
    cover.style.background = 'rgb(' + base.map(function (v) { return Math.round(v * 255); }).join(',') + ')';
    box.appendChild(cv); box.appendChild(cover);
    root.appendChild(st); root.appendChild(box);

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var scale = Math.min(dpr, Math.sqrt(780000 / (w * h)));
    var icon = ls('appIcon'), accent = rgb(ACCENT[icon] || ACCENT.green);
    var rOpts = { w: w, h: h, scale: scale, base: base, accent: accent };

    var worker = null, rd = null, stopMain = null, timers = [], finished = false;
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function finish(fade, natural) {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      if (stopMain) stopMain();
      if (worker) { try { worker.postMessage({ type: 'stop' }); } catch (e) {} later2(function () { worker.terminate(); }, 300); }
      if (rd) rd.lose();
      var rm = function () { box.remove(); st.remove(); active = null; };
      if (typeof opts.onDone === 'function') { try { opts.onDone(); } catch (e) {} }
      if (fade) { box.style.opacity = '0'; box.style.pointerEvents = 'none'; later2(rm, 220); } else rm();
    }
    function later2(fn, ms) { setTimeout(fn, ms); }

    // pointerdownで消すと、指を離した時のclickが下のボタンに抜ける
    box.addEventListener('click', function (e) { e.stopPropagation(); finish(true); });

    function go() {
      timers.forEach(clearTimeout); timers.length = 0;
      cover.remove();
      var startAt = performance.timeOrigin + performance.now() + 40;
      later(function () { finish(false); }, (T.end + 2.5) * 1000);
      return startAt;
    }

    function fallbackMain() {
      loadTex().then(function (imgs) {
        if (finished) return;
        try {
          rd = makeRenderer(cv, rOpts); rd.setTextures(imgs); rd.clear();
          var at = go();
          stopMain = runLoop(rd, at, function () { return performance.timeOrigin + performance.now(); }, function (f) { requestAnimationFrame(f); }, function () { finish(false, true); });
        } catch (e) { finish(false); }
      }, function () { finish(false); });
    }

    // 記録用: 時間を指定して1枚ずつ描く(出荷の動作には関係しない)
    if (opts.capture) {
      return loadTex().then(function (imgs) {
        rd = makeRenderer(cv, Object.assign({}, rOpts, { scale: opts.scale || scale })); rd.setTextures(imgs); cover.remove();
        return { end: T.end, draw: function (t) { rd.draw(t); }, remove: function () { finish(false); } };
      });
    }

    active = { finish: finish };
    later(function () { finish(false); }, 1800); // 準備に時間がかかるなら出さない
    var off = typeof OffscreenCanvas !== 'undefined' && cv.transferControlToOffscreen && !opts.noWorker;
    if (off) {
      try {
        var oc = cv.transferControlToOffscreen();
        worker = new Worker('/js/broIntro.js');
        worker.onerror = function () { finish(false); };
        worker.onmessage = function (ev) {
          var m = ev.data || {};
          if (finished) return;
          if (m.type === 'ready') {
            worker.postMessage({ type: 'go', at: go() });
          } else if (m.type === 'done') finish(false, true);
          else if (m.type === 'fail') finish(false);
        };
        worker.postMessage({ type: 'init', canvas: oc, opts: rOpts }, [oc]);
      } catch (e) { finish(false); }
    } else {
      fallbackMain();
    }
    return active;
  }

  // splash.html が呼ぶ。true を返したらこのセッションでは二度と true にならない
  function shouldPlay() { return enabled() && isColdStart(); }
  window.BroIntro = { play: play, enabled: enabled, shouldPlay: shouldPlay };
})();
