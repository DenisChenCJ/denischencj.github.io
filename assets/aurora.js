/* ==========================================================================
   極光：頂端七色光譜條往下不規則暈開的光幕
   --------------------------------------------------------------------------
   做法
   - 低解析度 canvas（約每 5 個 CSS 像素算一格）逐格計算，再由 CSS 放大到全寬；
     放大本身就是柔化，所以不必另外做模糊。
   - 每一欄有自己的「垂幕長度」，由幾組週期互不成整數比的正弦疊加而成，
     所以光幕會一直伸長、縮短，看起來不重複。
   - 顏色相位直接讀 CSS 光譜條的動畫時間，上方細條與下方光幕的顏色永遠對齊。
   - 七個顏色讀 style.css 的 --spec-1 ~ --spec-7，改顏色只要改那裡。

   省電
   - 每秒約 30 格；畫布捲出畫面或分頁隱藏時停止計算。
   - 系統開啟「減少動態效果」時只畫一格靜態畫面。

   可調參數集中在下方 TUNE。
   ========================================================================== */
(function () {
  'use strict';

  var TUNE = {
    cellPx: 5,          // 一格對應幾個 CSS 像素（越大越柔、越省電）
    fps: 30,
    curtainGain: 0.78,  // 光幕整體亮度
    hemGain: 0.42,      // 光幕下緣那道較亮的「裙邊」
    topGlowGain: 0.55,  // 緊貼光譜條下方的光暈
    topGlowPx: 22,      // 光暈往下衰減的距離
    pulseSec: 4.5,      // 整體呼吸閃爍的半週期（與舊版光暈相同）
    warpPx: 30,         // 光幕越往下越會左右擺動的幅度
    fallbackFlowSec: 14 // 讀不到 CSS 動畫時，自己用的流動週期
  };

  var canvas = document.querySelector('.aurora');
  var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) {
    // 畫不出極光時，光譜條改回一直顯示
    document.documentElement.classList.remove('aurora-on');
    return;
  }

  var TAU = Math.PI * 2;
  var LEN_KNEE = 0.5, LEN_MAX = 0.78;   // 垂幕長度的收斂起點與上限（畫布高度的比例）

  /* --- 顏色查表：7 色＋回到第 1 色，與 CSS linear-gradient 的插值方式相同 --- */
  var LUT_N = 1024;
  var lut = new Float32Array(LUT_N * 3);
  (function buildPalette() {
    var cs = getComputedStyle(document.documentElement);
    var stops = [];
    for (var i = 1; i <= 7; i++) stops.push(hexToRgb(cs.getPropertyValue('--spec-' + i)));
    stops.push(stops[0]);
    for (var k = 0; k < LUT_N; k++) {
      var p = (k / LUT_N) * 7, a = Math.floor(p), f = p - a;
      for (var c = 0; c < 3; c++) {
        lut[k * 3 + c] = stops[a][c] + (stops[a + 1][c] - stops[a][c]) * f;
      }
    }
  })();

  /* --- 垂直亮度剖面：s = 列位置 ÷ 該欄垂幕長度 --- */
  var PROF_N = 512, PROF_MAX = 1.35;
  var prof = new Float32Array(PROF_N);
  (function buildProfile() {
    for (var k = 0; k < PROF_N; k++) {
      var s = (k / (PROF_N - 1)) * PROF_MAX;
      var fall = Math.max(0, 1 - s);
      fall = Math.pow(fall, 1.15);
      var d = s - 0.8;
      var hem = Math.exp(-(d * d) / 0.014);
      prof[k] = fall + TUNE.hemGain * hem;
    }
  })();

  /* --- 尺寸 --- */
  var cssW = 0, cssH = 0, W = 0, H = 0, M = 0, cols = 0, cell = 1, spatial = 1;
  var image = null;
  var colLen, colInt, colSin, colCos;

  function resize() {
    var r = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === cssW && h === cssH && image) return false;
    cssW = w; cssH = h;
    W = clamp(Math.round(cssW / TUNE.cellPx), 64, 400);
    H = clamp(Math.round(cssH / TUNE.cellPx), 32, 200);
    cell = cssW / W;
    spatial = clamp(cssW / 1100, 0.55, 1);
    M = Math.ceil(TUNE.warpPx / cell) + 2;   // 左右多算幾欄，給擺動取樣
    cols = W + M * 2;
    canvas.width = W;
    canvas.height = H;
    image = ctx.createImageData(W, H);
    colLen = new Float32Array(cols);
    colInt = new Float32Array(cols);
    colSin = new Float32Array(cols);
    colCos = new Float32Array(cols);
    return true;
  }

  /* --- 時鐘：與 CSS 光譜條共用 --- */
  var flowAnim = null, flowLookups = 0;
  function flowPhase(tSec) {
    if (!flowAnim && flowLookups < 120 && document.getAnimations) {
      flowLookups++;
      var list = document.getAnimations();
      for (var i = 0; i < list.length; i++) {
        if (list[i].animationName === 'spectrum-flow') { flowAnim = list[i]; break; }
      }
    }
    if (flowAnim && flowAnim.currentTime != null) {
      var dur = flowAnim.effect.getComputedTiming().duration;
      if (dur > 0) return (flowAnim.currentTime % dur) / dur;
    }
    return reducedMotion ? 0 : frac(tSec / TUNE.fallbackFlowSec);
  }

  function now() { return performance.now() / 1000; }

  /* --- 繪製一格 --- */
  function render(t) {
    var flow = flowPhase(t);
    var data = image.data;

    // 整體呼吸：柔和的 ease-in-out 來回，與舊版光暈同週期
    var tri = Math.abs(frac(t / (TUNE.pulseSec * 2)) * 2 - 1);  // 0→1→0
    var ease = tri * tri * (3 - 2 * tri);
    var pulseStrong = 0.45 + 0.55 * ease;   // 光譜條下方的光暈
    var pulseSoft = 0.78 + 0.22 * ease;     // 光幕本體

    // 每欄：垂幕長度、亮度紋理（細條光束＋局部閃爍）、擺動相位
    for (var j = 0; j < cols; j++) {
      // 窄螢幕把起伏的尺度縮小，手機上也看得到好幾條垂幕
      var x = (j - M + 0.5) * cell / spatial;
      // 垂幕長度：大部分偏短（base），少數幾條長舌（spikes）會伸得很長
      var base = 0.24
        + 0.08 * Math.sin(TAU * (x / 640 + 0.017 * t) + 0.3)
        + 0.06 * Math.sin(TAU * (x / 283 - 0.039 * t) + 1.9)
        + 0.04 * Math.sin(TAU * (x / 137 + 0.063 * t) + 4.1)
        + 0.025 * Math.sin(TAU * (x / 71 - 0.107 * t) + 2.6);
      // 長舌：三組窄而尖的峰，間距互不成整數比；各自慢慢伸長、縮回，時間也錯開
      var s1 = Math.max(0, Math.sin(TAU * (x / 560 + 0.012 * t) + 0.9));
      var s2 = Math.max(0, Math.sin(TAU * (x / 390 - 0.019 * t) + 2.3));
      var s3 = Math.max(0, Math.sin(TAU * (x / 870 + 0.008 * t) + 4.4));
      var g1 = 0.5 + 0.5 * Math.sin(TAU * (0.041 * t + x / 2300) + 1.1);
      var g2 = 0.5 + 0.5 * Math.sin(TAU * (0.033 * t - x / 1900) + 3.7);
      var g3 = 0.5 + 0.5 * Math.sin(TAU * (0.027 * t + x / 2900) + 5.2);
      var spikes = 0.55 * g1 * Math.pow(s1, 6)
                 + 0.45 * g2 * Math.pow(s2, 8)
                 + 0.62 * g3 * Math.pow(s3, 10);
      // 長度上限用平滑收斂，不用硬截斷：硬截斷會讓超過上限的長舌被削成平底（梯形）。
      // 超過 KNEE 之後越長越難再長，最多逼近 MAX；MAX 讓整條長舌（含下緣尾光）落在畫布底部淡出區之上
      var n = base + spikes;
      if (n > LEN_KNEE) n = LEN_KNEE + (LEN_MAX - LEN_KNEE) * (1 - Math.exp(-(n - LEN_KNEE) / (LEN_MAX - LEN_KNEE)));
      colLen[j] = (n < 0.1 ? 0.1 : n) * H;

      // 細條光束：疏密由一層緩慢變化的包絡決定，有的區段光滑、有的區段條紋明顯
      var rayEnv = 0.5 + 0.5 * Math.sin(TAU * (x / 410 + 0.013 * t) + 2.2);
      var rays = 1 - 0.42 * rayEnv * rayEnv
        * (1 - (0.5 + 0.5 * Math.sin(TAU * (x / 47 + 0.021 * t) + 0.7))
             * (0.5 + 0.5 * Math.sin(TAU * (x / 29 - 0.034 * t) + 3.1))
             * (0.6 + 0.4 * Math.sin(TAU * (x / 83 + 0.011 * t) + 5.3)));
      var shimmer = 0.8 + 0.2
        * Math.sin(TAU * (x / 190 + 0.31 * t) + 1.3)
        * Math.sin(TAU * (x / 870 - 0.13 * t));
      colInt[j] = rays * shimmer;

      var a = TAU * (x / 520 - 0.029 * t);
      colSin[j] = Math.sin(a);
      colCos[j] = Math.cos(a);
    }

    var warpCols = TUNE.warpPx / cell;
    var profScale = (PROF_N - 1) / PROF_MAX;
    var uScale = cell / cssW;
    var o = 0;

    for (var y = 0; y < H; y++) {
      var yf = (y + 0.5) / H;
      var ycss = yf * cssH;
      var topGlow = TUNE.topGlowGain * pulseStrong * Math.exp(-ycss / TUNE.topGlowPx);
      var wy = warpCols * yf * yf;               // 越下面擺得越多
      var wph = yf * 2.4 + 0.05 * t;
      var sW = Math.sin(wph), cW = Math.cos(wph);
      var fade = yf > 0.82 ? Math.pow((1 - yf) / 0.18, 2) : 1;  // 畫布底部收乾淨

      for (var x2 = 0; x2 < W; x2++, o += 4) {
        var xw = x2 + M + wy * (colSin[x2 + M] * cW + colCos[x2 + M] * sW);
        if (xw < 0) xw = 0; else if (xw > cols - 1.001) xw = cols - 1.001;
        var i0 = xw | 0, f = xw - i0;
        var len = colLen[i0] + (colLen[i0 + 1] - colLen[i0]) * f;
        var ci = colInt[i0] + (colInt[i0 + 1] - colInt[i0]) * f;

        var s = (y + 0.5) / len;
        var pv = s >= PROF_MAX ? 0 : prof[(s * profScale) | 0];
        var v = (pv * ci * TUNE.curtainGain * pulseSoft + topGlow) * fade;

        if (v < 0.004) { data[o + 3] = 0; continue; }

        var u = (xw - M + 0.5) * uScale + flow;
        var li = ((u - Math.floor(u)) * LUT_N | 0) * 3;
        data[o] = lut[li];
        data[o + 1] = lut[li + 1];
        data[o + 2] = lut[li + 2];
        data[o + 3] = v >= 1 ? 255 : v * 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  /* --- 迴圈、可見性、減少動態效果 --- */
  var mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reducedMotion = !!(mqReduce && mqReduce.matches);
  var visible = true, rafId = 0, last = 0;
  var STILL_T = 37;   // 靜態畫面用的時間點（挑一個光幕長短錯落的瞬間）

  function frame(ts) {
    rafId = 0;
    if (!visible || reducedMotion) return;
    if (ts - last >= 1000 / TUNE.fps - 2) {
      last = ts;
      render(now());
    }
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (reducedMotion) { resize(); render(STILL_T); return; }
    if (!rafId && visible) rafId = requestAnimationFrame(frame);
  }

  resize();
  render(reducedMotion ? STILL_T : now());
  start();

  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      if (resize()) render(reducedMotion ? STILL_T : now());
    }).observe(canvas);
  } else {
    window.addEventListener('resize', function () {
      if (resize()) render(reducedMotion ? STILL_T : now());
    });
  }

  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) start();
    }).observe(canvas);
  }

  if (mqReduce) {
    var onChange = function (e) { reducedMotion = e.matches; start(); };
    if (mqReduce.addEventListener) mqReduce.addEventListener('change', onChange);
    else if (mqReduce.addListener) mqReduce.addListener(onChange);
  }

  /* --- 光譜條：頂端時隱藏，往下捲、極光離開畫面時淡入 ---
     捲動距離 0 → 畫布高度的 45%，透明度 0 → 1。極光最亮的上緣捲走後細條才接手，兩者不會疊在一起；
     底下只剩少數長舌的尾端，很淡。 */
  var bar = document.querySelector('.spectrum');
  if (bar) {
    var barTicking = false, barLast = -1;
    var updateBar = function () {
      barTicking = false;
      var span = Math.max(1, canvas.offsetHeight * 0.45);
      var o = clamp(window.scrollY / span, 0, 1);
      o = Math.round(o * 100) / 100;
      if (o !== barLast) { barLast = o; bar.style.setProperty('--bar-o', o); }
    };
    window.addEventListener('scroll', function () {
      if (!barTicking) { barTicking = true; requestAnimationFrame(updateBar); }
    }, { passive: true });
    window.addEventListener('resize', updateBar);
    updateBar();
  }

  /* --- 小工具 --- */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function frac(v) { return v - Math.floor(v); }
  function hexToRgb(h) {
    h = String(h).trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
})();
