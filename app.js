'use strict';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const GSI_DEM_URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
const GSI_PHOTO_URL = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>';
const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const CACHE_PREFIX = 'ski3d:osm:v1:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DIFFICULTY = {
  novice: { label: '初級', color: '#2e9e44', rank: 0 },
  easy: { label: '初級', color: '#2e9e44', rank: 1 },
  intermediate: { label: '中級', color: '#e0312b', rank: 2 },
  advanced: { label: '上級', color: '#111111', rank: 3 },
  expert: { label: '上級', color: '#111111', rank: 4 },
  extreme: { label: '上級', color: '#111111', rank: 5 },
  freeride: { label: '非圧雪', color: '#f08a00', rank: 6 },
};
const UNKNOWN_DIFFICULTY = { label: '不明', color: '#7a8796', rank: 7 };

const LIFT_TYPES = {
  cable_car: 'ロープウェイ',
  gondola: 'ゴンドラ',
  mixed_lift: 'ゴンドラ/リフト',
  chair_lift: 'リフト',
  drag_lift: 'Tバー',
  't-bar': 'Tバー',
  'j-bar': 'Jバー',
  platter: 'Tバー',
  rope_tow: 'ロープトウ',
  magic_carpet: 'ムービングベルト',
};

// ---------------------------------------------------------------------------
// 国土地理院 標高タイル → MapLibre の terrain 形式 (mapbox エンコード) に変換
// 地理院の dem_png は x = R*2^16 + G*2^8 + B, 標高 = x*0.01m (x >= 2^23 は負値/欠測)
// ---------------------------------------------------------------------------

let flatTile = null;

async function encodeMapboxTile(heights) {
  const size = 256;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.round(((heights ? heights[i] : 0) + 10000) * 10));
    img.data[i * 4] = (v >> 16) & 255;
    img.data[i * 4 + 1] = (v >> 8) & 255;
    img.data[i * 4 + 2] = v & 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

async function loadGsiDem(params, abortController) {
  const [z, x, y] = params.url.replace('gsidem://', '').split('/');
  const url = GSI_DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetch(url, { signal: abortController.signal });
  if (res.status === 404) {
    // 海上など標高データの無いタイルは 0m の平面にする
    flatTile = flatTile || (await encodeMapboxTile(null));
    return { data: flatTile.slice(0) };
  }
  if (!res.ok) throw new Error(`DEM tile ${res.status}`);

  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const src = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const heights = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0; i < heights.length; i++) {
    const v = src[i * 4] * 65536 + src[i * 4 + 1] * 256 + src[i * 4 + 2];
    if (v === 8388608) heights[i] = 0; // 欠測
    else if (v > 8388608) heights[i] = (v - 16777216) * 0.01;
    else heights[i] = v * 0.01;
  }
  return { data: await encodeMapboxTile(heights) };
}

maplibregl.addProtocol('gsidem', loadGsiDem);

// ---------------------------------------------------------------------------
// 地理計算
// ---------------------------------------------------------------------------

const R_EARTH = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function distance(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return toDeg(Math.atan2(y, x));
}

function destination(p, bearingDeg, meters) {
  const d = meters / R_EARTH;
  const br = toRad(bearingDeg);
  const lat1 = toRad(p[1]);
  const lng1 = toRad(p[0]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 =
    lng1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [toDeg(lng2), toDeg(lat2)];
}

function lineLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += distance(coords[i - 1], coords[i]);
  return len;
}

function angleDiff(from, to) {
  return ((to - from + 540) % 360) - 180;
}

function boundsOf(coordsList) {
  const b = new maplibregl.LngLatBounds();
  for (const coords of coordsList) for (const c of coords) b.extend(c);
  return b;
}

// 経路上の距離 d [m] の地点を返す
function makePathSampler(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]));
  const total = cum[cum.length - 1];
  return {
    total,
    at(d) {
      d = Math.max(0, Math.min(total, d));
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= d) lo = mid;
        else hi = mid;
      }
      const seg = cum[hi] - cum[lo] || 1;
      const t = (d - cum[lo]) / seg;
      return [
        coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
        coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t,
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// OpenStreetMap からコース・リフトを取得
// ---------------------------------------------------------------------------

function buildQuery(bbox) {
  const b = bbox.join(',');
  return `[out:json][timeout:60];
(
  way["piste:type"="downhill"](${b});
  way["aerialway"~"^(cable_car|gondola|mixed_lift|chair_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet)$"](${b});
);
out geom;`;
}

function readCache(id) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + id);
    if (!raw) return null;
    const { time, data } = JSON.parse(raw);
    if (Date.now() - time > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(id, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + id, JSON.stringify({ time: Date.now(), data }));
  } catch {
    // 容量超過などは無視 (次回また取得するだけ)
  }
}

async function fetchOverpass(query) {
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function osmName(tags) {
  return tags['name:ja'] || tags.name || tags['piste:name'] || tags['name:en'] || tags.ref || '';
}

function toFeatures(osm) {
  const features = [];
  for (const el of osm.elements || []) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags || {};
    const coords = el.geometry.map((g) => [g.lon, g.lat]);
    const name = osmName(tags);

    if (tags.aerialway) {
      features.push({
        type: 'Feature',
        id: el.id,
        geometry: { type: 'LineString', coordinates: coords },
        properties: { kind: 'lift', name, liftType: tags.aerialway },
      });
      continue;
    }

    const diff = DIFFICULTY[tags['piste:difficulty']] || UNKNOWN_DIFFICULTY;
    const closed = coords.length > 3 && coords[0][0] === coords.at(-1)[0] && coords[0][1] === coords.at(-1)[1];
    const isArea = tags.area === 'yes' || (closed && tags.area !== 'no');
    features.push({
      type: 'Feature',
      id: el.id,
      geometry: isArea ? { type: 'Polygon', coordinates: [coords] } : { type: 'LineString', coordinates: coords },
      properties: {
        kind: isArea ? 'run-area' : 'run',
        name,
        difficulty: tags['piste:difficulty'] || '',
        color: diff.color,
      },
    });
  }
  return features;
}

// 同じ名前のコースが複数の way に分かれていることが多いので、端点が繋がるものを連結する
function chainSegments(segments) {
  const EPS = 8; // m
  const remaining = segments.map((s) => s.slice());
  remaining.sort((a, b) => lineLength(b) - lineLength(a));
  const chains = [];
  while (remaining.length) {
    let chain = remaining.shift();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < remaining.length; i++) {
        const s = remaining[i];
        const head = chain[0];
        const tail = chain.at(-1);
        let joined = null;
        if (distance(tail, s[0]) < EPS) joined = chain.concat(s.slice(1));
        else if (distance(tail, s.at(-1)) < EPS) joined = chain.concat(s.slice(0, -1).reverse());
        else if (distance(head, s.at(-1)) < EPS) joined = s.concat(chain.slice(1));
        else if (distance(head, s[0]) < EPS) joined = s.slice().reverse().concat(chain.slice(1));
        if (joined) {
          chain = joined;
          remaining.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    chains.push(chain);
  }
  return chains;
}

function buildRunList(features) {
  const groups = new Map();
  for (const f of features) {
    if (f.properties.kind !== 'run') continue;
    const key = f.properties.name + '|' + f.properties.difficulty;
    if (!groups.has(key)) groups.set(key, { ...f.properties, segments: [] });
    groups.get(key).segments.push(f.geometry.coordinates);
  }
  const runs = [];
  for (const g of groups.values()) {
    for (const coords of chainSegments(g.segments)) {
      const length = lineLength(coords);
      if (!g.name && length < 250) continue; // 名前の無い短い区間は一覧から除外
      runs.push({ name: g.name || '名称なしコース', difficulty: g.difficulty, color: g.color, coords, length });
    }
  }
  runs.sort((a, b) => {
    const ra = (DIFFICULTY[a.difficulty] || UNKNOWN_DIFFICULTY).rank;
    const rb = (DIFFICULTY[b.difficulty] || UNKNOWN_DIFFICULTY).rank;
    return ra - rb || b.length - a.length;
  });
  return runs;
}

function buildLiftList(features) {
  return features
    .filter((f) => f.properties.kind === 'lift')
    .map((f) => ({
      name: f.properties.name || LIFT_TYPES[f.properties.liftType] || 'リフト',
      liftType: f.properties.liftType,
      coords: f.geometry.coordinates,
      length: lineLength(f.geometry.coordinates),
    }))
    .sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// 地図
// ---------------------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  center: [138.5, 38.5],
  zoom: 5,
  pitch: 0,
  maxPitch: 85,
  hash: false,
  localIdeographFontFamily: '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif',
  style: {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sky: {
      'sky-color': '#7fb4e6',
      'horizon-color': '#dcebf7',
      'fog-color': '#eaf2f9',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.75,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0],
    },
    sources: {
      photo: {
        type: 'raster',
        tiles: [GSI_PHOTO_URL],
        tileSize: 256,
        maxzoom: 18,
        attribution: GSI_ATTRIBUTION,
      },
      dem: {
        type: 'raster-dem',
        tiles: ['gsidem://{z}/{x}/{y}'],
        tileSize: 256,
        maxzoom: 14,
        encoding: 'mapbox',
        attribution: GSI_ATTRIBUTION,
      },
      ski: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        attribution: OSM_ATTRIBUTION,
      },
      highlight: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'photo', type: 'raster', source: 'photo' },
      {
        id: 'run-areas',
        type: 'fill',
        source: 'ski',
        filter: ['==', ['get', 'kind'], 'run-area'],
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 },
      },
      {
        id: 'runs-casing',
        type: 'line',
        source: 'ski',
        filter: ['==', ['get', 'kind'], 'run'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 7], 'line-opacity': 0.8 },
      },
      {
        id: 'runs',
        type: 'line',
        source: 'ski',
        filter: ['==', ['get', 'kind'], 'run'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 4] },
      },
      {
        id: 'lifts',
        type: 'line',
        source: 'ski',
        filter: ['==', ['get', 'kind'], 'lift'],
        paint: { 'line-color': '#222222', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 16, 3.5] },
      },
      {
        id: 'lifts-dash',
        type: 'line',
        source: 'ski',
        filter: ['==', ['get', 'kind'], 'lift'],
        paint: {
          'line-color': '#ffd400',
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 2],
          'line-dasharray': [2, 2],
        },
      },
      {
        id: 'highlight',
        type: 'line',
        source: 'highlight',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#00e5ff', 'line-width': 6, 'line-opacity': 0.75, 'line-blur': 1 },
      },
      {
        id: 'lift-labels',
        type: 'symbol',
        source: 'ski',
        filter: ['all', ['==', ['get', 'kind'], 'lift'], ['!=', ['get', 'name'], '']],
        minzoom: 13,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 400,
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 12,
        },
        paint: { 'text-color': '#222', 'text-halo-color': '#ffd400', 'text-halo-width': 1.5 },
      },
      {
        id: 'run-labels',
        type: 'symbol',
        source: 'ski',
        filter: ['all', ['==', ['get', 'kind'], 'run'], ['!=', ['get', 'name'], '']],
        minzoom: 13.5,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 400,
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 12,
        },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-right');

map.on('load', () => {
  map.setTerrain({ source: 'dem', exaggeration: Number(exagInput.value) });
  const initial = RESORTS.find((r) => r.id === new URLSearchParams(location.search).get('resort')) || RESORTS[0];
  selectResort(initial);
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const speedInput = $('speed');
const exagInput = $('exag');
const stopBtn = $('stop');

let current = null; // { resort, features, runs, lifts, bounds }
let loadToken = 0;

function setStatus(text) {
  statusEl.textContent = text;
}

$('toggle-panel').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

speedInput.addEventListener('input', () => {
  $('speed-label').textContent = '×' + speedInput.value;
});
exagInput.addEventListener('input', () => {
  $('exag-label').textContent = '×' + exagInput.value;
  map.setTerrain({ source: 'dem', exaggeration: Number(exagInput.value) });
});

for (const resort of RESORTS) {
  const btn = document.createElement('button');
  btn.className = 'resort-btn';
  btn.dataset.id = resort.id;
  btn.innerHTML = `${resort.name}<small>${resort.sub}</small>`;
  btn.addEventListener('click', () => selectResort(resort));
  $('resorts').appendChild(btn);
}

function formatLength(m) {
  return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
}

function renderList(el, items, describe, onClick, emptyText) {
  el.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    el.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    const { color, label, meta } = describe(item);
    li.innerHTML = `<span class="swatch" style="background:${color}"></span><span></span><span class="meta"></span>`;
    li.children[1].textContent = label;
    li.children[2].textContent = meta;
    li.addEventListener('click', () => onClick(item));
    el.appendChild(li);
  }
}

async function selectResort(resort) {
  stopTour();
  const token = ++loadToken;
  document.querySelectorAll('.resort-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === resort.id));
  history.replaceState(null, '', '?resort=' + resort.id);
  setHighlight(null);

  map.flyTo({ center: resort.center, zoom: 12.5, pitch: 55, bearing: 0, duration: 3000, essential: true });
  map.getSource('ski').setData({ type: 'FeatureCollection', features: [] });
  $('lifts').innerHTML = '';
  $('runs').innerHTML = '';

  let osm = readCache(resort.id);
  if (!osm) {
    setStatus('OpenStreetMap からコース・リフトを取得中…');
    try {
      osm = await fetchOverpass(buildQuery(resort.bbox));
      writeCache(resort.id, osm);
    } catch (e) {
      if (token !== loadToken) return;
      console.error(e);
      setStatus('コースデータの取得に失敗しました。時間をおいて再度お試しください。');
      return;
    }
  }
  if (token !== loadToken) return;

  const features = toFeatures(osm);
  const runs = buildRunList(features);
  const lifts = buildLiftList(features);
  const lineFeatures = features.filter((f) => f.geometry.type === 'LineString');
  const bounds = lineFeatures.length
    ? boundsOf(lineFeatures.map((f) => f.geometry.coordinates))
    : new maplibregl.LngLatBounds([resort.bbox[1], resort.bbox[0]], [resort.bbox[3], resort.bbox[2]]);
  current = { resort, features, runs, lifts, bounds };

  map.getSource('ski').setData({ type: 'FeatureCollection', features });
  map.fitBounds(bounds, { padding: 60, pitch: 60, bearing: map.getBearing(), duration: 2500 });

  renderList(
    $('lifts'),
    lifts,
    (l) => ({ color: '#ffd400', label: l.name, meta: `${LIFT_TYPES[l.liftType] || ''} ${formatLength(l.length)}` }),
    (l) => startPathTour(l, 'up'),
    'リフトのデータがありません',
  );
  renderList(
    $('runs'),
    runs,
    (r) => ({
      color: r.color,
      label: r.name,
      meta: `${(DIFFICULTY[r.difficulty] || UNKNOWN_DIFFICULTY).label} ${formatLength(r.length)}`,
    }),
    (r) => startPathTour(r, 'down'),
    'コースのデータがありません',
  );
  setStatus(`${resort.name}: コース ${runs.length} 本 / リフト ${lifts.length} 本 (データ: OpenStreetMap)`);
}

// 地図上のコース・リフトをクリックしてもフライトを開始できるようにする
for (const layer of ['runs', 'lifts']) {
  map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  map.on('click', layer, (e) => {
    if (!current) return;
    const f = e.features[0];
    const list = layer === 'runs' ? current.runs : current.lifts;
    const name = f.properties.name;
    const match =
      list.find((item) => item.name === name && item.coords.some((c) => distance(c, [e.lngLat.lng, e.lngLat.lat]) < 300)) ||
      list.find((item) => item.name === name);
    if (match) startPathTour(match, layer === 'runs' ? 'down' : 'up');
  });
}

function setHighlight(coords) {
  map.getSource('highlight').setData({
    type: 'FeatureCollection',
    features: coords ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] : [],
  });
}

// ---------------------------------------------------------------------------
// フライト (カメラアニメーション)
// ---------------------------------------------------------------------------

let tour = null; // { frame, onStop }

function stopTour() {
  if (!tour) return;
  cancelAnimationFrame(tour.frame);
  tour = null;
  stopBtn.disabled = true;
  $('orbit').classList.remove('active');
}

stopBtn.addEventListener('click', stopTour);
// ユーザーが地図を操作したらフライトを止める
for (const ev of ['mousedown', 'touchstart', 'wheel']) {
  map.getCanvasContainer().addEventListener(ev, () => stopTour(), { passive: true });
}

function waitForIdle(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    map.once('idle', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function elevationAt(lngLat, fallback) {
  const e = map.queryTerrainElevation(lngLat);
  return e == null || Number.isNaN(e) ? fallback : e;
}

// direction: 'down' = 標高の高い方から低い方へ, 'up' = 低い方から高い方へ
async function startPathTour(item, direction) {
  stopTour();
  const token = {};
  tour = { frame: 0, token };
  stopBtn.disabled = false;
  setHighlight(item.coords);
  setStatus(`${direction === 'up' ? '乗車中' : '滑走中'}: ${item.name}`);

  // 経路全体を表示して標高タイルを読み込ませる
  const bounds = boundsOf([item.coords]);
  map.fitBounds(bounds, { padding: 80, pitch: 55, duration: 1500, maxZoom: 15.5 });
  await waitForIdle();
  if (!tour || tour.token !== token) return;

  let coords = item.coords;
  const startElev = elevationAt(coords[0], 0);
  const endElev = elevationAt(coords.at(-1), 0);
  if ((direction === 'down' && startElev < endElev) || (direction === 'up' && startElev > endElev)) {
    coords = coords.slice().reverse();
  }

  const path = makePathSampler(coords);
  const isLift = direction === 'up';
  const BACK = isLift ? 180 : 160; // カメラを置く後方距離 [m]
  const CLEARANCE = isLift ? 45 : 50; // 地面からのカメラ高度 [m]
  const baseSpeed = isLift ? 12 : 18; // [m/s] 実際より速め
  let d = 0;
  let heading = bearing(path.at(0), path.at(60));
  let camAlt = null;
  let lastTime = null;
  let lastGround = elevationAt(coords[0], 0);

  const step = (time) => {
    if (!tour || tour.token !== token) return;
    const dt = lastTime == null ? 0 : Math.min(0.1, (time - lastTime) / 1000);
    lastTime = time;
    d += baseSpeed * Number(speedInput.value) * dt;

    if (d >= path.total) {
      stopTour();
      setStatus(`到着: ${item.name}`);
      map.easeTo({ pitch: 60, zoom: map.getZoom() - 1.5, duration: 2000 });
      return;
    }

    const pos = path.at(d);
    const desired = bearing(path.at(d - 40), path.at(d + 60));
    heading += angleDiff(heading, desired) * (1 - Math.exp(-dt * 1.8));

    const camPos = destination(pos, heading + 180, BACK);
    const groundTarget = elevationAt(pos, lastGround);
    lastGround = groundTarget;
    const groundCam = elevationAt(camPos, groundTarget);
    const desiredAlt = Math.max(groundCam, groundTarget) + CLEARANCE * Number(exagInput.value);
    camAlt = camAlt == null ? desiredAlt : camAlt + (desiredAlt - camAlt) * (1 - Math.exp(-dt * 2.5));

    const opts = map.calculateCameraOptionsFromTo(
      new maplibregl.LngLat(camPos[0], camPos[1]),
      camAlt,
      new maplibregl.LngLat(pos[0], pos[1]),
      groundTarget,
    );
    map.jumpTo(opts);
    tour.frame = requestAnimationFrame(step);
  };
  tour.frame = requestAnimationFrame(step);
}

$('orbit').addEventListener('click', async () => {
  if (!current) return;
  stopTour();
  const token = {};
  tour = { frame: 0, token };
  stopBtn.disabled = false;
  $('orbit').classList.add('active');
  setHighlight(null);
  setStatus(`空撮中: ${current.resort.name}`);

  const center = current.bounds.getCenter();
  map.fitBounds(current.bounds, { padding: 40, pitch: 65, bearing: map.getBearing(), duration: 2000 });
  await waitForIdle(3000);
  if (!tour || tour.token !== token) return;
  map.jumpTo({ center });

  let lastTime = null;
  const step = (time) => {
    if (!tour || tour.token !== token) return;
    const dt = lastTime == null ? 0 : Math.min(0.1, (time - lastTime) / 1000);
    lastTime = time;
    map.jumpTo({ bearing: map.getBearing() + dt * 5 * Number(speedInput.value) });
    tour.frame = requestAnimationFrame(step);
  };
  tour.frame = requestAnimationFrame(step);
});
