'use strict';

// ---------------------------------------------------------------------------
// 写真と比べる: 自分で撮った写真と、同じ場所・向きの3D表示を並べた比較画像を作る
// (app.js の map / current / selected などを使う)
// ---------------------------------------------------------------------------

const compare = {
  active: false,
  photo: null, // HTMLImageElement
  vp: null, // 立ち位置 { pos: [lng, lat], bearing, look (見上げ角 度), placeName }
  picking: false,
  course: null, // 撮影地点の候補にするコース
  resultBlob: null,
  saved: null, // 開く前の表示設定 (閉じるときに戻す)
};
const EYE_HEIGHT = 3; // 目線の高さ [m] (地形データが粗いので少し高め)
const SKI_LINE_LAYERS = ['run-areas', 'runs-casing', 'runs', 'lifts', 'lifts-dash', 'highlight', 'lift-labels', 'run-labels'];

function openCompare() {
  if (!current) return;
  stopTour();
  compare.course = selected;
  hideInfo();
  compare.active = true;
  compare.saved = { exag: exagInput.value, fov: map.getVerticalFieldOfView(), maxPitch: map.getMaxPitch() };
  // 実際の景色と比べるので起伏の強調はなし、視線を水平より上にも向けられるようにする
  setExaggeration(1);
  map.setMaxPitch(110);
  setAreaLabelsVisible(false);
  renderLandmarks();
  $('compare').hidden = false;
  $('compare-result').hidden = true;
  if (isCompactScreen()) $('panel').classList.add('collapsed');
  updateCompareSteps();
}

function closeCompare() {
  compare.active = false;
  compare.picking = false;
  compare.vp = null;
  document.body.classList.remove('compare-picking', 'compare-view');
  $('compare').hidden = true;
  for (const h of INTERACTIONS) map[h].enable();
  if (compare.saved) {
    setExaggeration(Number(compare.saved.exag));
    map.setVerticalFieldOfView(compare.saved.fov);
    map.easeTo({ pitch: Math.min(map.getPitch(), 75), duration: 800 });
    map.setMaxPitch(compare.saved.maxPitch);
  }
  setAreaLabelsVisible(true);
  setCompareMarker(null);
}

function setExaggeration(v) {
  exagInput.value = v;
  $('exag-label').textContent = '×' + v;
  map.setTerrain({ source: 'dem', exaggeration: Number(v) });
}

// 比較画面を開いている間にコース・リフトを選ぶと、撮影地点の候補になる
function setCompareCourse(item) {
  compare.course = item;
  setHighlight(item.coords);
  updateCompareSteps();
}

function updateCompareSteps() {
  $('cmp-step-view').classList.toggle('disabled', !compare.vp);
  const c = compare.course;
  $('cmp-from-course').disabled = !c;
  $('cmp-from-course').textContent = c
    ? `「${c.name}」の${c.kind === 'lift' ? '山頂側' : 'スタート地点'}に立つ`
    : 'コースを選ぶとスタート地点に立てます';
  $('cmp-make').disabled = !(compare.photo && compare.vp);
  $('cmp-place').textContent = compare.vp ? `撮影地点: ${compare.vp.placeName}` : '撮影地点が未設定です';
  $('cmp-title').placeholder = defaultCompareTitle();
}

function defaultCompareTitle() {
  const parts = [];
  const area = compare.course?.area || current?.area?.name;
  if (area && area !== 'その他') parts.push(area);
  if (compare.vp?.placeName && compare.vp.placeName !== '地図で選んだ地点') parts.push(compare.vp.placeName);
  return parts.join(' ') || current?.resort?.name || '';
}

// --- 写真 ---------------------------------------------------------------

$('cmp-photo').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    compare.photo = img;
    $('cmp-thumb').src = img.src;
    $('cmp-thumb').hidden = false;
    updateCompareSteps();
  };
  img.src = URL.createObjectURL(file);
});

// --- 撮影地点 -------------------------------------------------------------

let compareMarker = null;
function setCompareMarker(pos) {
  if (compareMarker) compareMarker.remove();
  compareMarker = null;
  if (!pos) return;
  const el = document.createElement('div');
  el.className = 'compare-marker';
  el.textContent = '📷';
  compareMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(pos).addTo(map);
}

async function setViewpoint(pos, bearingDeg, placeName) {
  compare.picking = false;
  document.body.classList.remove('compare-picking');
  compare.vp = { pos, bearing: bearingDeg, look: -6, placeName };
  setCompareMarker(pos);
  updateCompareSteps();
  // 立ち位置のまわりの地形を読み込んでから目線の高さに降りる
  map.flyTo({ center: pos, zoom: 15, pitch: 60, bearing: bearingDeg, duration: 1200 });
  await waitForIdle(6000);
  if (!compare.active || compare.vp?.pos !== pos) return;
  document.body.classList.add('compare-view');
  for (const h of INTERACTIONS) map[h].disable();
  setCompareMarker(null);
  applyViewpoint();
  // 遠くの地形が読み込まれると標高が変わるので、そのたびに合わせ直す
  map.once('idle', applyViewpoint);
}

function applyViewpoint() {
  const vp = compare.vp;
  if (!compare.active || !vp || !document.body.classList.contains('compare-view')) return;
  const ground = elevationAt(vp.pos, 0);
  const eyeAlt = ground + EYE_HEIGHT;
  const dist = 3000;
  const target = destination(vp.pos, vp.bearing, dist);
  const targetAlt = eyeAlt + Math.tan(toRad(vp.look)) * dist;
  const opts = map.calculateCameraOptionsFromTo(
    new maplibregl.LngLat(vp.pos[0], vp.pos[1]),
    eyeAlt,
    new maplibregl.LngLat(target[0], target[1]),
    targetAlt,
  );
  map.jumpTo(opts);
  $('cmp-direction').textContent = `向き ${Math.round(((vp.bearing % 360) + 360) % 360)}° / 視線 ${vp.look > 0 ? '+' : ''}${Math.round(vp.look)}°`;
}

$('cmp-from-course').addEventListener('click', async () => {
  const c = compare.course;
  if (!c) return;
  // 標高から上端を判定するため、未計算なら地形を読み込んで計算する
  const a = c.analysis || (await ensureAnalysis(c));
  if (!compare.active || compare.course !== c) return;
  let coords = a ? a.coords : c.coords;
  if (c.kind === 'lift') coords = coords.slice().reverse(); // リフトは降り場 (山頂側) に立つ
  setViewpoint(coords[0], bearing(coords[0], coords[Math.min(coords.length - 1, 3)]), c.name);
});
$('cmp-pick').addEventListener('click', () => {
  compare.picking = true;
  compare.vp = null;
  document.body.classList.remove('compare-view');
  for (const h of INTERACTIONS) map[h].enable();
  document.body.classList.add('compare-picking');
  updateCompareSteps();
});
map.on('click', (e) => {
  if (!compare.active || !compare.picking) return;
  setViewpoint([e.lngLat.lng, e.lngLat.lat], map.getBearing(), '地図で選んだ地点');
});

// --- 向きの調整 -------------------------------------------------------------

function renderLandmarks() {
  const el = $('cmp-landmarks');
  el.innerHTML = '';
  for (const lm of current?.resort?.landmarks || []) {
    const b = document.createElement('button');
    b.textContent = `${lm.name}に向ける`;
    b.addEventListener('click', () => {
      if (!compare.vp) return;
      compare.vp.bearing = bearing(compare.vp.pos, lm.lngLat);
      // 山頂が画面の少し上に来るよう、見上げ角を山頂の高さから決める
      const d = distance(compare.vp.pos, lm.lngLat);
      const eye = elevationAt(compare.vp.pos, 0) + EYE_HEIGHT;
      compare.vp.look = Math.max(-20, Math.min(15, toDeg(Math.atan((lm.elevation - eye) / d)) - 4));
      applyViewpoint();
    });
    el.appendChild(b);
  }
  el.hidden = !el.children.length;
}

const turn = (deg) => {
  if (!compare.vp) return;
  compare.vp.bearing += deg;
  applyViewpoint();
};
const lookBy = (deg) => {
  if (!compare.vp) return;
  compare.vp.look = Math.max(-45, Math.min(30, compare.vp.look + deg));
  applyViewpoint();
};
holdButton($('cmp-left'), (dt) => turn(-25 * dt));
holdButton($('cmp-right'), (dt) => turn(25 * dt));
holdButton($('cmp-up'), (dt) => lookBy(10 * dt));
holdButton($('cmp-down'), (dt) => lookBy(-10 * dt));
$('cmp-fov').addEventListener('input', (e) => {
  map.setVerticalFieldOfView(Number(e.target.value));
  $('cmp-fov-label').textContent = `${e.target.value}°`;
  applyViewpoint();
});

// 立ち位置モードではドラッグで向き・視線を変える
{
  const container = map.getCanvasContainer();
  let last = null;
  container.addEventListener('pointerdown', (e) => {
    if (!compare.active || !document.body.classList.contains('compare-view')) return;
    last = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  container.addEventListener('pointermove', (e) => {
    if (!last || last.id !== e.pointerId || !compare.active) return;
    const fovPerPx = map.getVerticalFieldOfView() / container.clientHeight;
    compare.vp.bearing -= (e.clientX - last.x) * fovPerPx;
    compare.vp.look = Math.max(-45, Math.min(30, compare.vp.look + (e.clientY - last.y) * fovPerPx));
    last = { x: e.clientX, y: e.clientY, id: e.pointerId };
    applyViewpoint();
  });
  const end = () => (last = null);
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
}

// --- 比較画像の作成 ---------------------------------------------------------

// 地図の今の表示を画像として取り出す (描画直後でないと WebGL の内容は読めない)
function captureMap() {
  return new Promise((resolve) => {
    map.once('render', () => resolve(map.getCanvas().toDataURL('image/png')));
    map.triggerRepaint();
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// 画像を枠いっぱいに切り抜いて描く (object-fit: cover)
function drawCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

function drawTag(ctx, text, x, y) {
  ctx.font = 'bold 30px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif';
  const w = ctx.measureText(text).width + 32;
  ctx.fillStyle = 'rgba(15, 25, 40, 0.72)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, 50, 25);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 16, y + 26);
}

async function makeCompareImage() {
  if (!compare.photo || !compare.vp) return;
  $('cmp-make').disabled = true;
  $('cmp-make').textContent = '作成中…';
  try {
    const showLines = $('cmp-lines').checked;
    if (!showLines) for (const id of SKI_LINE_LAYERS) map.setLayoutProperty(id, 'visibility', 'none');
    await waitForIdle(8000);
    const shot = await loadImage(await captureMap());
    if (!showLines) for (const id of SKI_LINE_LAYERS) map.setLayoutProperty(id, 'visibility', 'visible');

    const square = document.querySelector('input[name="cmp-layout"]:checked').value === 'square';
    const W = 1080;
    const H = square ? 1080 : 1350;
    const HEAD = 104;
    const FOOT = 56;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f1b2b';
    ctx.fillRect(0, 0, W, H);

    // 見出し
    const title = $('cmp-title').value.trim() || defaultCompareTitle();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 44px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.fillText(title, 36, 62, W - 72);
    ctx.fillStyle = '#9fb6d0';
    ctx.font = '26px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.fillText('実際の景色 vs 3Dビューア', 36, 94);

    const gap = 8;
    const bodyH = H - HEAD - FOOT;
    let a; // 写真の枠
    let b; // 3Dの枠
    if (square) {
      const w = (W - gap) / 2;
      a = [0, HEAD, w, bodyH];
      b = [w + gap, HEAD, w, bodyH];
    } else {
      const h = (bodyH - gap) / 2;
      a = [0, HEAD, W, h];
      b = [0, HEAD + h + gap, W, h];
    }
    drawCover(ctx, compare.photo, ...a);
    drawCover(ctx, shot, ...b);
    drawTag(ctx, '📷 実際の写真', a[0] + 20, a[1] + 20);
    drawTag(ctx, '🗻 3Dビューア', b[0] + 20, b[1] + 20);

    // 出典 (国土地理院・OpenStreetMap の利用条件)
    ctx.fillStyle = '#8aa0b8';
    ctx.font = '20px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.fillText('3D: 地形・航空写真 国土地理院 / コース © OpenStreetMap contributors', 36, H - 22, W - 72);

    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    const url = URL.createObjectURL(blob);
    $('cmp-preview').src = url;
    $('cmp-download').href = url;
    compare.resultBlob = blob;
    $('compare-result').hidden = false;
    $('cmp-share').hidden = !(navigator.canShare && navigator.canShare({ files: [new File([blob], 'x.jpg', { type: 'image/jpeg' })] }));
  } catch (e) {
    console.error(e);
    alert('画像を作れませんでした。地図の読み込みが終わってからもう一度お試しください。');
  } finally {
    $('cmp-make').disabled = false;
    $('cmp-make').textContent = '比較画像を作る';
  }
}

$('cmp-make').addEventListener('click', makeCompareImage);
$('cmp-share').addEventListener('click', async () => {
  const blob = compare.resultBlob;
  if (!blob) return;
  try {
    await navigator.share({ files: [new File([blob], 'ski-compare.jpg', { type: 'image/jpeg' })] });
  } catch {
    // キャンセル時など
  }
});
$('cmp-result-close').addEventListener('click', () => ($('compare-result').hidden = true));
$('open-compare').addEventListener('click', openCompare);
$('compare-close').addEventListener('click', closeCompare);
$('compare-min').addEventListener('click', () => $('compare').classList.toggle('minimized'));
