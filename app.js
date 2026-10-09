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

const OVERPASS_ENDPOINTS = window.OVERPASS_ENDPOINTS; // osm-query.js
const CACHE_PREFIX = 'ski3d:osm:v2:';
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

const buildQuery = window.buildOsmQuery; // osm-query.js

// GitHub Actions が週1回保存している data/<id>.js を読む (無ければ null)。
// fetch() で JSON を読む方法だとファイルを直接開いた (file://) ときにブラウザに拒否されるため、
// <script> タグで読み込み、data/<id>.js が window.SKI_DATA[id] にデータを入れる形にしている。
function fetchBundledData(id) {
  const loaded = () => {
    const data = window.SKI_DATA?.[id];
    return data?.elements?.length ? data : null;
  };
  if (loaded()) return Promise.resolve(loaded());
  return new Promise((resolve) => {
    const script = document.createElement('script');
    // 公開サーバーでは古いデータがキャッシュされ続けないよう1時間ごとに URL を変える
    const bust = location.protocol === 'file:' ? '' : `?h=${Math.floor(Date.now() / 3600000)}`;
    script.src = `data/${id}.js${bust}`;
    script.onload = () => resolve(loaded());
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

// 期限切れのキャッシュも、取得に失敗したときの予備として返す
function readCache(id) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + id);
    if (!raw) return null;
    const { time, data } = JSON.parse(raw);
    if (!data?.elements?.length) return null; // 以前の不具合で保存された空データは使わない
    return { data, time, expired: Date.now() - time > CACHE_TTL_MS };
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

class FetchError extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason; // 'offline' | 'busy' | 'timeout' | 'other'
  }
}

const FETCH_TIMEOUT_MS = 90 * 1000;

// Overpass API のサーバーを順番に試す。onProgress には何台目を試しているかを渡す
async function fetchOverpass(query, onProgress) {
  if (navigator.onLine === false) throw new FetchError('offline', 'navigator.onLine = false');
  const errors = [];
  for (const [i, endpoint] of OVERPASS_ENDPOINTS.entries()) {
    onProgress?.(i + 1, OVERPASS_ENDPOINTS.length);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      });
      if (res.status === 429 || res.status === 503 || res.status === 504) {
        throw new FetchError(res.status === 504 ? 'timeout' : 'busy', `${endpoint}: HTTP ${res.status}`);
      }
      if (!res.ok) throw new FetchError('other', `${endpoint}: HTTP ${res.status}`);
      const json = await res.json();
      // サーバー側でタイムアウトすると HTTP 200 のまま remark にエラーが入り、データが空で返ってくる
      if (json.remark && /error|timed out|out of memory/i.test(json.remark)) {
        throw new FetchError('timeout', `${endpoint}: ${json.remark}`);
      }
      return json;
    } catch (e) {
      errors.push(
        e instanceof FetchError ? e : new FetchError(e.name === 'AbortError' ? 'timeout' : 'other', `${endpoint}: ${e.message}`),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  if (navigator.onLine === false) throw new FetchError('offline', 'offline');
  // 全サーバーで失敗。混雑・タイムアウトがあればそれを理由として返す
  const reason = errors.find((e) => e.reason === 'busy' || e.reason === 'timeout')?.reason || 'other';
  throw new FetchError(reason, errors.map((e) => e.message).join(' / '));
}

const FETCH_ERROR_MESSAGES = {
  offline: 'インターネットに接続されていません。接続を確認してから再試行してください。',
  busy: 'コースデータのサーバー(OpenStreetMap / Overpass API)が混み合っています。1〜2分おいてから再試行してください。',
  timeout: 'コースデータの取得に時間がかかりすぎて中断されました。サーバーが混んでいる可能性があります。少しおいてから再試行してください。',
  other: 'コースデータを取得できませんでした。少しおいてから再試行してください。',
};

function osmName(tags) {
  return tags['name:ja'] || tags.name || tags['piste:name'] || tags['name:en'] || tags.ref || '';
}

function nameEn(tags, name) {
  const en = tags['name:en'] || '';
  return en && en !== name ? en : '';
}

function toFeatures(osm) {
  const features = [];
  for (const el of osm.elements || []) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags || {};
    if (tags.landuse === 'winter_sports') continue; // スキー場の範囲は buildAreas で扱う
    const coords = el.geometry.map((g) => [g.lon, g.lat]);
    const name = osmName(tags);

    if (tags.aerialway) {
      features.push({
        type: 'Feature',
        id: el.id,
        geometry: { type: 'LineString', coordinates: coords },
        properties: {
          kind: 'lift',
          name,
          nameEn: nameEn(tags, name),
          liftType: tags.aerialway,
          occupancy: tags['aerialway:occupancy'] || '',
          duration: tags['aerialway:duration'] || '',
          capacity: tags['aerialway:capacity'] || '',
          description: tags.description || '',
        },
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
        nameEn: nameEn(tags, name),
        difficulty: tags['piste:difficulty'] || '',
        color: diff.color,
        grooming: tags['piste:grooming'] || '',
        lit: tags['piste:lit'] || tags.lit || '',
        description: tags.description || '',
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

// ---------------------------------------------------------------------------
// スキー場 (エリア内の個々のスキー場) の判定
// ---------------------------------------------------------------------------

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

// OSM の landuse=winter_sports (way / multipolygon relation) を名前付きの範囲にする
function parseSkiAreaPolygons(osm) {
  const polys = [];
  for (const el of osm.elements || []) {
    const tags = el.tags || {};
    if (tags.landuse !== 'winter_sports') continue;
    let rings = [];
    if (el.type === 'way' && el.geometry) {
      rings = [el.geometry.map((g) => [g.lon, g.lat])];
    } else if (el.type === 'relation' && el.members) {
      const outers = el.members
        .filter((m) => m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === ''))
        .map((m) => m.geometry.map((g) => [g.lon, g.lat]));
      rings = chainSegments(outers);
    }
    rings = rings.filter((r) => r.length >= 4);
    if (!rings.length) continue;
    polys.push({ name: tags['name:ja'] || tags.name || '', nameEn: tags['name:en'] || tags.name || '', rings });
  }
  return polys;
}

// エリア定義 (resorts.js の areas) と OSM の範囲を突き合わせて、スキー場の一覧を作る
function buildAreas(osm, resort, features) {
  const polys = parseSkiAreaPolygons(osm);
  const areas = (resort.areas || []).map((a) => ({
    name: a.name,
    match: a.match,
    liftMatch: a.lifts,
    fallbackCenter: a.center,
    rings: [],
  }));
  for (const poly of polys) {
    if (!poly.name && !poly.nameEn) continue;
    // 「白馬村 / Hakuba Valley」のように複数のスキー場をまとめて囲む範囲は使わない
    const others = polys.filter((p) => p !== poly);
    const contained = others.filter((p) => poly.rings.some((ring) => pointInRing(p.rings[0][0], ring)));
    if (contained.length >= 2) continue;
    const label = poly.name + ' ' + poly.nameEn;
    let area = areas.find((a) => a.match && a.match.test(label));
    if (area) area.curated = true;
    if (!area) {
      // 定義に無い名前付きのスキー場は自動で追加 (同名はまとめる)
      area = areas.find((a) => a.name === poly.name) || { name: poly.name || poly.nameEn, rings: [] };
      if (!areas.includes(area)) areas.push(area);
    }
    area.rings.push(...poly.rings);
  }
  // リフト名で振り分けたリフト (範囲がまとまっているスキー場の判定に使う)
  const anchors = [];
  for (const f of features) {
    if (f.properties.kind !== 'lift') continue;
    const label = `${f.properties.name} ${f.properties.nameEn || ''}`;
    const area = areas.find((a) => a.liftMatch && a.liftMatch.test(label));
    if (area) anchors.push({ area, coords: f.geometry.coordinates });
  }
  areas.anchors = anchors;
  return areas;
}

// 線の中点が含まれるスキー場の範囲 (複数なら一番小さい範囲)、無ければ最寄りのスキー場を返す
function assignArea(coords, areas) {
  const mid = coords[Math.floor(coords.length / 2)];
  let best = null;
  let bestArea = Infinity;
  for (const area of areas) {
    for (const ring of area.rings) {
      if (pointInRing(mid, ring)) {
        const a = ringArea(ring);
        if (a < bestArea) {
          bestArea = a;
          best = area;
        }
      }
    }
  }
  // スキー場ごとの範囲が無い場合は、名前で振り分けたリフトのうち一番近いものに合わせる
  if (!best?.curated && areas.anchors.length) {
    let nearestAnchor = null;
    let anchorDist = 2000;
    for (const a of areas.anchors) {
      for (const c of a.coords) {
        const d = distance(mid, c);
        if (d < anchorDist) {
          anchorDist = d;
          nearestAnchor = a.area;
        }
      }
    }
    if (nearestAnchor) return nearestAnchor;
  }
  if (best) return best;
  let nearest = null;
  let nearestDist = 3000; // 3km 以上離れていれば「その他」
  for (const area of areas) {
    const points = area.rings.length ? area.rings.flat() : area.fallbackCenter ? [area.fallbackCenter] : [];
    for (let i = 0; i < points.length; i += Math.max(1, Math.floor(points.length / 200))) {
      const d = distance(mid, points[i]);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = area;
      }
    }
  }
  return nearest;
}

function buildRunList(features) {
  const groups = new Map();
  for (const f of features) {
    if (f.properties.kind !== 'run') continue;
    const key = f.properties.name + '|' + f.properties.difficulty + '|' + f.properties.area;
    if (!groups.has(key)) groups.set(key, { ...f.properties, segments: [] });
    groups.get(key).segments.push(f.geometry.coordinates);
  }
  const runs = [];
  for (const g of groups.values()) {
    for (const coords of chainSegments(g.segments)) {
      const length = lineLength(coords);
      if (!g.name && length < 250) continue; // 名前の無い短い区間は一覧から除外
      runs.push({
        kind: 'run',
        area: g.area,
        name: g.name || '名称なしコース',
        nameEn: g.nameEn,
        difficulty: g.difficulty,
        color: g.color,
        grooming: g.grooming,
        lit: g.lit,
        description: g.description,
        coords,
        length,
      });
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
      ...f.properties,
      name: f.properties.name || LIFT_TYPES[f.properties.liftType] || 'リフト',
      coords: f.geometry.coordinates,
      length: lineLength(f.geometry.coordinates),
    }))
    .sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// 地図
// ---------------------------------------------------------------------------

// 季節ごとの見た目。地理院の航空写真は雪の無い時期のものなので、
// 冬は写真を白っぽく加工し、雪面の陰影と圧雪ゲレンデの白い帯を重ねて雪景色を表現する。
const SEASONS = {
  winter: {
    photo: {
      'raster-saturation': -0.85,
      'raster-brightness-min': 0.5,
      'raster-brightness-max': 1,
      'raster-contrast': 0.1,
    },
    snowLayers: 'visible',
    sky: {
      'sky-color': '#9fbfdf',
      'horizon-color': '#e9eff5',
      'fog-color': '#f1f4f7',
      'sky-horizon-blend': 0.7,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.6,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0],
    },
  },
  summer: {
    photo: {
      'raster-saturation': 0,
      'raster-brightness-min': 0,
      'raster-brightness-max': 1,
      'raster-contrast': 0,
    },
    snowLayers: 'none',
    sky: {
      'sky-color': '#7fb4e6',
      'horizon-color': '#dcebf7',
      'fog-color': '#eaf2f9',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.75,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0],
    },
  },
};

function applySeason(name) {
  const season = SEASONS[name];
  for (const [prop, value] of Object.entries(season.photo)) map.setPaintProperty('photo', prop, value);
  for (const id of ['snow-shade', 'run-areas-snow', 'runs-snow']) map.setLayoutProperty(id, 'visibility', season.snowLayers);
  map.setSky(season.sky);
  document.querySelectorAll('[data-season]').forEach((b) => b.classList.toggle('active', b.dataset.season === name));
  snowfall.setSeason(name);
  if (typeof buildings3d !== 'undefined') buildings3d.setSeason(name);
}

const map = new maplibregl.Map({
  attributionControl: false, // 下で追加 (スマホでは小さく畳んだ表示にする)
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
    sky: SEASONS.winter.sky,
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
      // 陰影用。terrain と同じソースを共有すると解像度が落ちるので別ソースにする
      'hillshade-dem': {
        type: 'raster-dem',
        tiles: ['gsidem://{z}/{x}/{y}'],
        tileSize: 256,
        maxzoom: 14,
        encoding: 'mapbox',
      },
      ski: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        attribution: OSM_ATTRIBUTION,
      },
      highlight: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f4f7fa' } },
      { id: 'photo', type: 'raster', source: 'photo', paint: SEASONS.winter.photo },
      {
        id: 'snow-shade',
        type: 'hillshade',
        source: 'hillshade-dem',
        paint: {
          'hillshade-shadow-color': '#5a7ca6',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#9db8d6',
          'hillshade-exaggeration': 0.45,
          'hillshade-illumination-direction': 315,
        },
      },
      // 冬: 圧雪されたゲレンデ (林の中の白い帯)
      {
        id: 'run-areas-snow',
        type: 'fill',
        source: 'ski',
        filter: ['==', ['get', 'kind'], 'run-area'],
        paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.75 },
      },
      {
        id: 'runs-snow',
        type: 'line',
        source: 'ski',
        filter: ['==', ['get', 'kind'], 'run'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 3, 16, 40, 19, 320],
          'line-blur': ['interpolate', ['exponential', 2], ['zoom'], 12, 1, 16, 12, 19, 96],
          'line-opacity': 0.9,
        },
      },
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
      // クリック判定用の透明な太線
      {
        id: 'runs-hit',
        type: 'line',
        source: 'ski',
        filter: ['==', ['get', 'kind'], 'run'],
        paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 },
      },
      {
        id: 'lifts-hit',
        type: 'line',
        source: 'ski',
        filter: ['==', ['get', 'kind'], 'lift'],
        paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 },
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
map.addControl(
  new maplibregl.AttributionControl({
    compact: window.matchMedia('(max-width: 600px), (max-height: 500px)').matches,
  }),
  'bottom-right',
);
// MapLibre の小さい表示は最初だけ開いた状態になるので、読み込み後に畳む (ⓘ で開ける)
const foldAttribution = () =>
  document.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show').forEach((el) => el.classList.remove('maplibregl-compact-show'));
map.once('load', foldAttribution);
map.once('idle', foldAttribution);

map.on('load', () => {
  map.setTerrain({ source: 'dem', exaggeration: Number(exagInput.value) });
  applySeason('winter');
  const initial = RESORTS.find((r) => r.id === new URLSearchParams(location.search).get('resort')) || RESORTS[0];
  selectResort(initial);
});

// ---------------------------------------------------------------------------
// 降雪エフェクト (地図の上に重ねたキャンバスに雪を描く)
// ---------------------------------------------------------------------------

const snowfall = (() => {
  const canvas = document.getElementById('snow');
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let enabled = !reduceMotion;
  let season = 'winter';
  let flakes = [];
  let frame = 0;
  let last = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round((canvas.clientWidth * canvas.clientHeight) / 9000);
    flakes = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.clientWidth,
      y: Math.random() * canvas.clientHeight,
      r: 0.8 + Math.random() * 2.2,
      v: 25 + Math.random() * 45,
      phase: Math.random() * Math.PI * 2,
    }));
  }

  function draw(time) {
    const dt = Math.min(0.1, (time - last) / 1000 || 0);
    last = time;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    for (const f of flakes) {
      f.y += f.v * dt * (f.r / 2);
      f.x += Math.sin(time / 1000 + f.phase) * 12 * dt;
      if (f.y > h + 5) {
        f.y = -5;
        f.x = Math.random() * w;
      }
      ctx.moveTo(f.x + f.r, f.y);
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    }
    ctx.fill();
    frame = requestAnimationFrame(draw);
  }

  function update() {
    const on = enabled && season === 'winter';
    canvas.hidden = !on;
    cancelAnimationFrame(frame);
    if (on) {
      resize();
      last = performance.now();
      frame = requestAnimationFrame(draw);
    }
  }

  window.addEventListener('resize', () => !canvas.hidden && resize());
  document.getElementById('snow-toggle').checked = enabled;
  return {
    setEnabled(v) {
      enabled = v;
      update();
    },
    setSeason(v) {
      season = v;
      document.getElementById('snow-toggle').disabled = v !== 'winter';
      update();
    },
  };
})();

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

// スマホ縦向き・横向き (画面が狭い/低い) かどうか
function isCompactScreen() {
  return window.matchMedia('(max-width: 600px), (max-height: 500px)').matches;
}

function setStatus(text) {
  statusEl.classList.remove('error');
  statusEl.textContent = text;
}

// 取得失敗のメッセージと「再試行」ボタンを表示する
function showFetchError(message, retry) {
  statusEl.classList.add('error');
  statusEl.textContent = message;
  const btn = document.createElement('button');
  btn.textContent = '↻ 再試行';
  btn.addEventListener('click', retry);
  statusEl.appendChild(document.createElement('br'));
  statusEl.appendChild(btn);
  $('panel').classList.remove('collapsed');
  $('lifts').innerHTML = '<li class="empty">データを取得できませんでした</li>';
  $('runs').innerHTML = '<li class="empty">データを取得できませんでした</li>';
}

$('toggle-panel').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

speedInput.addEventListener('input', () => {
  $('speed-label').textContent = '×' + speedInput.value;
});
exagInput.addEventListener('input', () => {
  $('exag-label').textContent = '×' + exagInput.value;
  map.setTerrain({ source: 'dem', exaggeration: Number(exagInput.value) });
  buildings3d.refresh();
});

document.querySelectorAll('[data-season]').forEach((b) =>
  b.addEventListener('click', () => applySeason(b.dataset.season)),
);
$('snow-toggle').addEventListener('change', (e) => snowfall.setEnabled(e.target.checked));

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

function renderList(el, items, describe, onClick, emptyText, groupByArea = false) {
  el.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    el.appendChild(li);
    return;
  }
  let lastArea = null;
  for (const item of items) {
    if (groupByArea && item.area !== lastArea) {
      lastArea = item.area;
      const header = document.createElement('li');
      header.className = 'group';
      header.textContent = item.area;
      el.appendChild(header);
    }
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
  hideInfo();

  map.flyTo({ center: resort.center, zoom: 12.5, pitch: 55, bearing: 0, duration: 3000, essential: true });
  map.getSource('ski').setData({ type: 'FeatureCollection', features: [] });
  $('lifts').innerHTML = '';
  $('runs').innerHTML = '';
  $('areas').innerHTML = '';
  for (const m of areaMarkers) m.remove();
  areaMarkers = [];
  buildings3d.load(resort); // 建物の立体表示 (buildings.js、対応エリアのみ)

  const cached = readCache(resort.id);
  let osm = null;
  let notice = '';
  // 1. リポジトリに保存済みのデータ → 2. ブラウザのキャッシュ → 3. Overpass API から直接取得
  setStatus('コース・リフトのデータを読み込み中…');
  const bundled = await fetchBundledData(resort.id);
  if (token !== loadToken) return;
  if (bundled) osm = bundled;
  else if (cached && !cached.expired) osm = cached.data;
  if (!osm) {
    try {
      osm = await fetchOverpass(buildQuery(resort.bbox), (n, total) => {
        if (token === loadToken) setStatus(`OpenStreetMap からコース・リフトを取得中…(サーバー ${n}/${total})`);
      });
      writeCache(resort.id, osm);
    } catch (e) {
      if (token !== loadToken) return;
      console.error(e);
      if (cached) {
        // 古いデータでも無いよりは良いので表示する
        osm = cached.data;
        const date = new Date(cached.time).toLocaleDateString('ja-JP');
        notice = `※最新データを取得できなかったため、${date} に保存したデータを表示しています。`;
      } else {
        showFetchError(FETCH_ERROR_MESSAGES[e.reason] || FETCH_ERROR_MESSAGES.other, () => selectResort(resort));
        return;
      }
    }
  }
  if (token !== loadToken) return;

  const features = toFeatures(osm);
  const areaList = buildAreas(osm, resort, features);
  for (const f of features) {
    const coords = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates;
    f.properties.area = assignArea(coords, areaList)?.name || 'その他';
  }
  const runs = buildRunList(features);
  const lifts = buildLiftList(features);
  const lineFeatures = features.filter((f) => f.geometry.type === 'LineString');
  const bounds = lineFeatures.length
    ? boundsOf(lineFeatures.map((f) => f.geometry.coordinates))
    : new maplibregl.LngLatBounds([resort.bbox[1], resort.bbox[0]], [resort.bbox[3], resort.bbox[2]]);

  // コース・リフトのあるスキー場だけを、北から順に並べる
  const areas = [];
  for (const a of [...areaList, { name: 'その他', rings: [] }]) {
    const own = lineFeatures.filter((f) => f.properties.area === a.name);
    if (!own.length) continue;
    const areaBounds = boundsOf(own.map((f) => f.geometry.coordinates));
    areas.push({
      name: a.name,
      bounds: areaBounds,
      labelAt: labelPosition(a, own, areaBounds),
      runCount: runs.filter((r) => r.area === a.name).length,
      liftCount: lifts.filter((l) => l.area === a.name).length,
    });
  }
  areas.sort((a, b) => (a.name === 'その他') - (b.name === 'その他') || b.labelAt[1] - a.labelAt[1]);
  current = { resort, features, runs, lifts, bounds, areas, area: null };

  map.getSource('ski').setData({ type: 'FeatureCollection', features });
  map.fitBounds(bounds, { padding: 60, pitch: 60, bearing: map.getBearing(), duration: 2500 });

  renderAreaLabels();
  renderAreaChips();
  renderItemLists();
  setStatus(
    `${resort.name}: スキー場 ${areas.filter((a) => a.name !== 'その他').length} か所 / コース ${runs.length} 本 / リフト ${lifts.length} 本 (データ: OpenStreetMap)` +
      (notice ? '\n' + notice : ''),
  );
}

// ラベルはスキー場の範囲の中心 (無ければリフト・コースの範囲の中心) に置く
function labelPosition(area, own, areaBounds) {
  if (area.rings.length) {
    const biggest = area.rings.reduce((a, b) => (ringArea(b) > ringArea(a) ? b : a));
    const c = boundsOf([biggest]).getCenter();
    return [c.lng, c.lat];
  }
  const c = areaBounds.getCenter();
  return [c.lng, c.lat];
}

// ---------------------------------------------------------------------------
// スキー場名の表示と絞り込み
// ---------------------------------------------------------------------------

let areaMarkers = [];

function renderAreaLabels() {
  for (const m of areaMarkers) m.remove();
  areaMarkers = [];
  for (const area of current.areas) {
    if (area.name === 'その他') continue;
    const el = document.createElement('button');
    el.className = 'area-label';
    el.innerHTML = '<span class="area-name"></span><span class="area-meta"></span>';
    el.children[0].textContent = area.name;
    el.children[1].textContent = `コース${area.runCount}・リフト${area.liftCount}`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      focusArea(area);
    });
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(area.labelAt).addTo(map);
    marker._area = area;
    areaMarkers.push(marker);
  }
  updateAreaLabelState();
}

function updateAreaLabelState() {
  for (const m of areaMarkers) {
    m.getElement().classList.toggle('active', current.area === m._area);
    m.getElement().classList.toggle('dim', !!current.area && current.area !== m._area);
  }
}

// フライト中はラベルが視界を遮るので隠す
function setAreaLabelsVisible(visible) {
  document.body.classList.toggle('hide-area-labels', !visible);
}

function renderAreaChips() {
  const el = $('areas');
  el.innerHTML = '';
  const named = current.areas.filter((a) => a.name !== 'その他');
  $('areas-section').hidden = named.length < 2;
  const make = (label, area) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('active', current.area === area);
    b.addEventListener('click', () => (area ? focusArea(area) : focusArea(null)));
    el.appendChild(b);
  };
  make('すべて', null);
  for (const a of current.areas) make(a.name, a);
}

function focusArea(area) {
  stopTour();
  hideInfo();
  current.area = area;
  renderAreaChips();
  renderItemLists();
  updateAreaLabelState();
  const b = area ? area.bounds : current.bounds;
  map.fitBounds(b, { padding: 60, pitch: 60, bearing: map.getBearing(), duration: 2000, maxZoom: 15 });
  if (area) setStatus(`${area.name}: コース ${area.runCount} 本 / リフト ${area.liftCount} 本`);
}

function renderItemLists() {
  const inArea = (item) => !current.area || item.area === current.area.name;
  const order = new Map(current.areas.map((a, i) => [a.name, i]));
  const sortByArea = (items) =>
    current.area ? items : items.slice().sort((a, b) => (order.get(a.area) ?? 99) - (order.get(b.area) ?? 99));
  renderList(
    $('lifts'),
    sortByArea(current.lifts.filter(inArea)),
    (l) => ({ color: '#ffd400', label: l.name, meta: `${LIFT_TYPES[l.liftType] || ''} ${formatLength(l.length)}` }),
    (l) => selectItem(l),
    'リフトのデータがありません',
    !current.area,
  );
  renderList(
    $('runs'),
    sortByArea(current.runs.filter(inArea)),
    (r) => ({
      color: r.color,
      label: r.name,
      meta: `${(DIFFICULTY[r.difficulty] || UNKNOWN_DIFFICULTY).label} ${formatLength(r.length)}`,
    }),
    (r) => selectItem(r),
    'コースのデータがありません',
    !current.area,
  );
}

// 地図上のコース・リフトにマウスを乗せると名前を表示し、クリックで詳細カードを開く
const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'hover-popup', offset: 10 });

for (const layer of ['runs-hit', 'lifts-hit']) {
  map.on('mousemove', layer, (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    const sub =
      p.kind === 'lift' ? LIFT_TYPES[p.liftType] || 'リフト' : (DIFFICULTY[p.difficulty] || UNKNOWN_DIFFICULTY).label;
    const label = document.createElement('div');
    label.innerHTML = '<b></b> <span></span><div class="popup-area"></div>';
    label.children[0].textContent = p.name || (p.kind === 'lift' ? 'リフト' : '名称なしコース');
    label.children[1].textContent = sub;
    label.children[2].textContent = p.area;
    hoverPopup.setLngLat(e.lngLat).setDOMContent(label).addTo(map);
  });
  map.on('mouseleave', layer, () => {
    map.getCanvas().style.cursor = '';
    hoverPopup.remove();
  });
  map.on('click', layer, (e) => {
    if (!current || (typeof compare !== 'undefined' && compare.picking)) return;
    const f = e.features[0];
    const list = layer === 'runs-hit' ? current.runs : current.lifts;
    const name = f.properties.kind === 'lift' ? f.properties.name || LIFT_TYPES[f.properties.liftType] || 'リフト' : f.properties.name || '名称なしコース';
    const click = [e.lngLat.lng, e.lngLat.lat];
    const nearest = (item) => Math.min(...item.coords.map((c) => distance(c, click)));
    const candidates = list.filter((item) => item.name === name);
    const match = candidates.sort((a, b) => nearest(a) - nearest(b))[0];
    if (match) selectItem(match);
  });
}

// ---------------------------------------------------------------------------
// コース・リフトの詳細 (標高プロファイル・斜度の計算と説明文)
// ---------------------------------------------------------------------------

const GROOMING = {
  classic: '圧雪',
  skating: '圧雪',
  'classic+skating': '圧雪',
  mogul: 'コブ',
  backcountry: '非圧雪',
  no: '非圧雪',
};
// 所要時間の目安に使う平均速度 [m/s]
const LIFT_SPEED = {
  cable_car: 8,
  gondola: 5,
  mixed_lift: 5,
  chair_lift: 2.3,
  drag_lift: 3,
  't-bar': 3,
  'j-bar': 3,
  platter: 3,
  rope_tow: 2,
  magic_carpet: 0.6,
};

let selected = null; // 詳細カードに表示中の item

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 経路を 20m 間隔で標高サンプリングし、向きを揃えて斜度などを計算する。
// 地形タイルが読み込まれている必要があるので、経路を画面に収めて idle を待ってから呼ぶ。
function analyzePath(item) {
  const exag = Number(exagInput.value);
  const direction = item.kind === 'lift' ? 'up' : 'down';
  let coords = item.coords;
  const first = elevationAt(coords[0], null);
  const last = elevationAt(coords.at(-1), null);
  if (first == null || last == null) return null;
  if ((direction === 'down' && first < last) || (direction === 'up' && first > last)) coords = coords.slice().reverse();

  const path = makePathSampler(coords);
  const n = Math.max(2, Math.min(400, Math.ceil(path.total / 20) + 1));
  const profile = [];
  let prev = first / exag;
  for (let i = 0; i < n; i++) {
    const d = (path.total * i) / (n - 1);
    const e = elevationAt(path.at(d), null);
    const h = e == null ? prev : e / exag;
    profile.push({ d, h });
    prev = h;
  }

  // 約40m区間ごとの斜度 (DEM のノイズを抑えるため隣接2点ではなく1つ飛ばしで計算)
  let maxSlope = 0;
  let maxSlopeAt = 0;
  for (let i = 0; i + 2 < profile.length; i++) {
    const dd = profile[i + 2].d - profile[i].d;
    if (dd <= 0) continue;
    const slope = toDeg(Math.atan(Math.abs(profile[i + 2].h - profile[i].h) / dd));
    if (slope > maxSlope) {
      maxSlope = slope;
      maxSlopeAt = (profile[i].d + dd / 2) / path.total;
    }
  }
  const hs = profile.map((p) => p.h);
  // 地形タイルが読み込まれる前は標高が 0 になる (スキー場が海抜0mのことはない) ので、未取得として扱う
  if (hs.every((h) => Math.abs(h) < 1)) return null;
  const top = Math.max(...hs);
  const bottom = Math.min(...hs);
  const drop = Math.abs(profile.at(-1).h - profile[0].h);
  return {
    coords,
    profile,
    total: path.total,
    top,
    bottom,
    drop,
    maxSlope,
    maxSlopeAt,
    avgSlope: toDeg(Math.atan(drop / path.total)),
  };
}

function describe(item, a) {
  const len = formatLength(item.length);
  const drop = Math.round(a.drop);
  if (item.kind === 'lift') {
    const type = LIFT_TYPES[item.liftType] || 'リフト';
    const minutes = Number(item.duration) || Math.max(1, Math.round(item.length / (LIFT_SPEED[item.liftType] || 2.5) / 60));
    return `全長${len}・標高差約${drop}mを上る${type}。乗車時間は約${minutes}分${item.duration ? '' : '(目安)'}。`;
  }
  const level = {
    novice: '初心者向け',
    easy: '初級者向け',
    intermediate: '中級者向け',
    advanced: '上級者向け',
    expert: 'エキスパート向け',
    extreme: 'エキスパート向け',
    freeride: '上級者向けの非圧雪',
  }[item.difficulty];
  const size = item.length >= 2500 ? 'ロングコース' : item.length >= 800 ? 'コース' : '短めのコース';
  const parts = [`${level ? level + 'の、' : ''}全長${len}・標高差約${drop}mの${size}。`];
  const m = a.maxSlope;
  if (m < 10) parts.push('全体を通して緩やかで、のんびり滑れます。');
  else if (m < 18) parts.push('適度な斜度で、ターンの練習にぴったりです。');
  else if (m < 25) parts.push('しっかりした斜度の区間があり、滑りごたえがあります。');
  else if (m < 32) parts.push('急斜面があり、確実なターン技術が必要です。');
  else parts.push('かなりの急斜面があり、上級者向けです。');
  if (m >= 10) {
    const where = a.maxSlopeAt < 0.33 ? '上部' : a.maxSlopeAt < 0.67 ? '中盤' : '下部';
    parts.push(`いちばん急なのは${where}で、約${Math.round(m)}°。`);
  }
  if (item.grooming === 'mogul') parts.push('コブ斜面があります。');
  if (item.grooming === 'backcountry' || item.grooming === 'no') parts.push('圧雪されていない非圧雪コースです。');
  if (item.lit === 'yes') parts.push('ナイター営業の対象です。');
  return parts.join('');
}

function profileSvg(a, color) {
  const W = 300;
  const H = 96;
  const PAD = { l: 34, r: 6, t: 8, b: 16 };
  const range = Math.max(10, a.top - a.bottom);
  const x = (d) => PAD.l + (d / a.total) * (W - PAD.l - PAD.r);
  const y = (h) => PAD.t + (1 - (h - a.bottom) / range) * (H - PAD.t - PAD.b);
  const line = a.profile.map((p) => `${x(p.d).toFixed(1)},${y(p.h).toFixed(1)}`).join(' ');
  const area = `${x(0)},${H - PAD.b} ${line} ${x(a.total)},${H - PAD.b}`;
  return `<svg viewBox="0 0 ${W} ${H}" class="profile" role="img" aria-label="標高プロファイル">
    <polygon points="${area}" fill="${color}" fill-opacity="0.15"/>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" stroke="#c5cdd6"/>
    <text x="${PAD.l - 4}" y="${y(a.top) + 4}" text-anchor="end">${Math.round(a.top)}</text>
    <text x="${PAD.l - 4}" y="${y(a.bottom) + 4}" text-anchor="end">${Math.round(a.bottom)}</text>
    <text x="${PAD.l}" y="${H - 3}">0</text>
    <text x="${W - PAD.r}" y="${H - 3}" text-anchor="end">${formatLength(a.total)}</text>
    <circle id="profile-marker" r="4.5" cx="${x(0)}" cy="${y(a.profile[0].h)}" fill="#00b8d4" stroke="#fff" stroke-width="1.5" visibility="hidden"/>
  </svg>`;
}

function updateProfileMarker(item, d) {
  const marker = document.getElementById('profile-marker');
  if (!marker || selected !== item || !item.analysis) return;
  const a = item.analysis;
  const svg = marker.ownerSVGElement.viewBox.baseVal;
  const i = Math.min(a.profile.length - 1, Math.round((d / a.total) * (a.profile.length - 1)));
  const range = Math.max(10, a.top - a.bottom);
  marker.setAttribute('cx', 34 + (d / a.total) * (svg.width - 40));
  marker.setAttribute('cy', 8 + (1 - (a.profile[i].h - a.bottom) / range) * (svg.height - 24));
  marker.setAttribute('visibility', 'visible');
  // 最小化中に見える進み具合のバー
  const bar = document.getElementById('info-progress-bar');
  if (bar) bar.style.width = `${Math.min(100, (d / a.total) * 100).toFixed(1)}%`;
}

// 詳細カードの最小化 (名前と進み具合だけ表示)
function setInfoMinimized(min) {
  $('info').classList.toggle('minimized', min);
  const btn = $('info').querySelector('.minimize');
  if (btn) {
    btn.textContent = min ? '▢' : '—';
    btn.setAttribute('aria-label', min ? '説明を開く' : '説明を最小化');
    btn.title = min ? '説明を開く' : '説明を最小化';
  }
}

function renderInfo(item) {
  const info = $('info');
  const a = item.analysis;
  const isLift = item.kind === 'lift';
  const diff = DIFFICULTY[item.difficulty] || UNKNOWN_DIFFICULTY;
  const badge = isLift
    ? `<span class="badge" style="background:#ffd400;color:#222">${escapeHtml(LIFT_TYPES[item.liftType] || 'リフト')}</span>`
    : `<span class="badge" style="background:${diff.color}">${diff.label}</span>`;

  const stats = [['全長', formatLength(item.length)]];
  if (a) {
    stats.push(['標高差', `${Math.round(a.drop)} m`]);
    stats.push([isLift ? '山頂側' : 'スタート', `${Math.round(isLift ? a.profile.at(-1).h : a.profile[0].h)} m`]);
    stats.push([isLift ? '山麓側' : 'ゴール', `${Math.round(isLift ? a.profile[0].h : a.profile.at(-1).h)} m`]);
    if (!isLift) {
      stats.push(['最大斜度', `約${Math.round(a.maxSlope)}°`]);
      stats.push(['平均斜度', `約${Math.round(a.avgSlope)}°`]);
    }
  }
  if (isLift && item.occupancy) stats.push(['定員', `${item.occupancy}人乗り`]);
  if (!isLift && GROOMING[item.grooming]) stats.push(['整備', GROOMING[item.grooming]]);
  if (!isLift && item.lit === 'yes') stats.push(['ナイター', 'あり']);

  info.innerHTML = `
    <div class="info-buttons">
      <button class="minimize" aria-label="説明を最小化" title="説明を最小化">—</button>
      <button class="close" aria-label="閉じる" title="閉じる">×</button>
    </div>
    <div class="info-area">${escapeHtml(item.area || '')}</div>
    <div class="info-head">${badge}<h3>${escapeHtml(item.name)}</h3></div>
    ${item.nameEn ? `<div class="name-en">${escapeHtml(item.nameEn)}</div>` : ''}
    <p class="desc">${a ? escapeHtml(describe(item, a)) : item.analyzed ? '標高データを取得できませんでした。' : '地形データを読み込み中…'}</p>
    ${item.description ? `<p class="osm-desc">${escapeHtml(item.description)}</p>` : ''}
    <dl class="stats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>
    ${a ? profileSvg(a, isLift ? '#d4a800' : diff.color === '#111111' ? '#333' : diff.color) : ''}
    <button class="go">${isLift ? '🚡 乗ってみる' : '⛷ このコースを滑る'}</button>
    <p class="note">標高・斜度は国土地理院の標高データ(約10mメッシュ)からの推定値。コース情報は OpenStreetMap。</p>
    <div class="info-progress"><div id="info-progress-bar"></div></div>`;
  info.hidden = false;
  setInfoMinimized(info.classList.contains('minimized'));
  info.querySelector('.minimize').addEventListener('click', () => setInfoMinimized(!info.classList.contains('minimized')));
  // 最小化中はヘッダー部分のタップでも開ける
  info.querySelector('.info-head').addEventListener('click', () => {
    if (info.classList.contains('minimized')) setInfoMinimized(false);
  });
  info.querySelector('.close').addEventListener('click', () => {
    stopTour();
    hideInfo();
  });
  info.querySelector('.go').addEventListener('click', () => startPathTour(item));
}

function hideInfo() {
  selected = null;
  $('info').hidden = true;
  setInfoMinimized(false);
  setHighlight(null);
}

async function selectItem(item) {
  // 「写真と比べる」を開いている間は、撮影地点の候補として使う
  if (typeof compare !== 'undefined' && compare.active) {
    setCompareCourse(item);
    return;
  }
  stopTour();
  selected = item;
  setHighlight(item.coords);
  renderInfo(item);
  await ensureAnalysis(item);
  if (selected === item) renderInfo(item);
}

// 経路を画面に収めて地形を読み込ませ、標高プロファイルを計算する (結果は item にキャッシュ)
async function ensureAnalysis(item) {
  map.fitBounds(boundsOf([item.coords]), {
    padding: { top: 80, bottom: 80, left: 80, right: 80 },
    pitch: 55,
    bearing: map.getBearing(),
    duration: 1500,
    maxZoom: 15.5,
  });
  // 通信が遅いと地形の読み込みが間に合わないので、数回待ち直す
  for (let attempt = 0; attempt < 4 && !item.analysis; attempt++) {
    await waitForIdle(attempt === 0 ? 6000 : 5000);
    item.analysis = analyzePath(item);
  }
  item.analyzed = true;
  return item.analysis;
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
  if (tour.kind === 'path') setFreeLook(false);
  tour = null;
  stopBtn.disabled = true;
  $('orbit').classList.remove('active');
}

stopBtn.addEventListener('click', stopTour);
// 空撮中にユーザーが地図を操作したら止める (コース/リフトのフライト中はドラッグで視点を回せる)
for (const ev of ['mousedown', 'touchstart', 'wheel']) {
  map.getCanvasContainer().addEventListener(ev, () => tour?.kind === 'orbit' && stopTour(), { passive: true });
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

// コースは標高の高い方から低い方へ、リフトは低い方から高い方へ進む
async function startPathTour(item) {
  stopTour();
  const token = {};
  tour = { frame: 0, token };
  stopBtn.disabled = false;
  const isLift = item.kind === 'lift';
  if (selected !== item) {
    selected = item;
    renderInfo(item);
  }
  setHighlight(item.coords);
  setStatus(`${isLift ? '乗車中' : '滑走中'}: ${item.name}`);

  const analysis = item.analysis || (await ensureAnalysis(item));
  if (!tour || tour.token !== token) return;
  if (selected === item) renderInfo(item);
  const coords = analysis ? analysis.coords : item.coords;

  const path = makePathSampler(coords);
  const baseSpeed = isLift ? 12 : 18; // [m/s] 実際より速め
  tour.kind = 'path';
  tour.isLift = isLift;
  tour.paused = false;
  updatePauseButton();
  setFreeLook(true);
  // 景色が見えるよう、説明は最小化し、スマホ(縦・横)ではパネルも畳む
  setInfoMinimized(true);
  if (isCompactScreen()) $('panel').classList.add('collapsed');
  let d = 0;
  let heading = bearing(path.at(0), path.at(60));
  let cam = null; // 平滑化したカメラ位置 { pos, alt }
  let look = null; // 平滑化した注視点 { pos, alt }
  let lastTime = null;
  let lastGround = elevationAt(coords[0], 0);
  const ground = (p, fallback) => elevationAt(p, fallback);

  const step = (time) => {
    if (!tour || tour.token !== token) return;
    const dt = lastTime == null ? 0 : Math.min(0.1, (time - lastTime) / 1000);
    lastTime = time;
    applyHeldKeys(dt);
    if (!tour.paused) d += baseSpeed * Number(speedInput.value) * dt;
    updateProfileMarker(item, Math.min(d, path.total));

    if (d >= path.total) {
      stopTour();
      setStatus(`到着: ${item.name}`);
      map.easeTo({ pitch: 60, zoom: map.getZoom() - 1.5, duration: 2000 });
      return;
    }

    const pos = path.at(d);
    const desired = bearing(path.at(d - 40), path.at(d + 60));
    heading += angleDiff(heading, desired) * (1 - Math.exp(-dt * 1.8));
    const groundHere = ground(pos, lastGround);
    lastGround = groundHere;
    const { camPos, camAlt, lookPos, lookAlt } = cameraFor(cameraMode, {
      pos,
      heading,
      groundHere,
      isLift,
      ahead: (m) => path.at(d + m),
      ground,
    });

    // モード切替やドラッグ操作でカメラが瞬間移動しないよう、位置をなめらかに追従させる
    const k = cam ? 1 - Math.exp(-dt * 4) : 1;
    const lerp = (from, to) => (from == null ? to : from + (to - from) * k);
    cam = {
      pos: [lerp(cam?.pos[0], camPos[0]), lerp(cam?.pos[1], camPos[1])],
      alt: lerp(cam?.alt, camAlt),
    };
    look = {
      pos: [lerp(look?.pos[0], lookPos[0]), lerp(look?.pos[1], lookPos[1])],
      alt: lerp(look?.alt, lookAlt),
    };
    // 地形にめり込まないようにする
    cam.alt = Math.max(cam.alt, ground(cam.pos, groundHere) + 3 * Number(exagInput.value));

    const opts = map.calculateCameraOptionsFromTo(
      new maplibregl.LngLat(cam.pos[0], cam.pos[1]),
      cam.alt,
      new maplibregl.LngLat(look.pos[0], look.pos[1]),
      look.alt,
    );
    map.jumpTo(opts);
    tour.frame = requestAnimationFrame(step);
  };
  tour.frame = requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// フライト中のカメラ (視点モード + ドラッグによる視点操作)
// ---------------------------------------------------------------------------

const CAMERA_MODES = {
  chase: { label: '後ろから', dist: 160, yaw: 0, height: 50 },
  pov: { label: '一人称', dist: 0, yaw: 0, height: 4 },
  side: { label: '横から', dist: 230, yaw: 90, height: 60 },
  top: { label: '上空から', dist: 70, yaw: 0, height: 420 },
};
let cameraMode = 'chase';
// ドラッグ・ホイール・ボタン・キーで加える視点のずれ
//   yaw … 滑走者の周りを回り込む角度 / heightScale … 高さの倍率 / distScale … 距離の倍率
//   tilt … 視線 (+ で遠くの山や空のほう、- で足元のほう)
const freeLook = { yaw: 0, heightScale: 1, distScale: 1, tilt: 0 };
const FREE_LOOK_LIMITS = { height: [0.3, 10], dist: [0.3, 8], tilt: [-0.6, 1] };
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

function adjustYaw(deg) {
  freeLook.yaw = (freeLook.yaw + deg) % 360;
}
function adjustHeight(factor) {
  freeLook.heightScale = clamp(freeLook.heightScale * factor, FREE_LOOK_LIMITS.height);
}
function adjustDistance(factor) {
  freeLook.distScale = clamp(freeLook.distScale * factor, FREE_LOOK_LIMITS.dist);
}
function adjustTilt(delta) {
  freeLook.tilt = clamp(freeLook.tilt + delta, FREE_LOOK_LIMITS.tilt);
}

function cameraFor(mode, { pos, heading, groundHere, isLift, ahead, ground }) {
  const m = CAMERA_MODES[mode];
  const exag = Number(exagInput.value);
  const tilt = freeLook.tilt;
  if (mode === 'pov') {
    // 自分の目線: 進行方向の先を見る (リフトはワイヤーの高さ)。距離の倍率は見る先の遠さに使う
    const eye = (isLift ? 12 : m.height) * freeLook.heightScale;
    const lookDir = heading + freeLook.yaw;
    const lookDist = Math.max(20, 120 * freeLook.distScale * (tilt < 0 ? 1 + tilt : 1));
    const lookPos = freeLook.yaw === 0 && freeLook.distScale === 1 && tilt >= 0 ? ahead(lookDist) : destination(pos, lookDir, lookDist);
    const lookGround = ground(lookPos, groundHere);
    const baseLookAlt = isLift ? Math.max(lookGround, groundHere) + eye * exag * 0.6 : lookGround + 1.5 * exag;
    return {
      camPos: pos,
      camAlt: groundHere + eye * exag,
      lookPos,
      lookAlt: baseLookAlt + Math.max(0, tilt) * lookDist * 0.8,
    };
  }
  const dist = m.dist * freeLook.distScale;
  const camPos = destination(pos, heading + 180 + m.yaw + freeLook.yaw, dist);
  const camGround = ground(camPos, groundHere);
  const camAlt = Math.max(camGround, groundHere) + m.height * freeLook.heightScale * exag;
  // 視線を上げると、注視点を前方の高い位置にずらして遠くの山並みが入るようにする
  const viewDir = heading + m.yaw + freeLook.yaw;
  let lookPos = pos;
  let lookAlt = groundHere;
  if (tilt > 0) {
    lookPos = destination(pos, viewDir, tilt * (600 + dist));
    lookAlt = groundHere + tilt * (camAlt - groundHere);
  } else if (tilt < 0) {
    lookPos = destination(pos, viewDir + 180, -tilt * dist * 0.7);
  }
  return { camPos, camAlt, lookPos, lookAlt };
}

function setCameraMode(mode) {
  cameraMode = mode;
  resetFreeLook();
  document.querySelectorAll('[data-camera]').forEach((b) => b.classList.toggle('active', b.dataset.camera === mode));
}

function resetFreeLook() {
  freeLook.yaw = 0;
  freeLook.heightScale = 1;
  freeLook.distScale = 1;
  freeLook.tilt = 0;
}

function togglePause() {
  if (tour?.kind !== 'path') return;
  tour.paused = !tour.paused;
  updatePauseButton();
}

function updatePauseButton() {
  const paused = !!tour?.paused;
  $('hud-pause').textContent = paused ? '▶ 再開' : '⏸ 一時停止';
  $('hud-pause').classList.toggle('active', paused);
}

// キーボード (押している間ずっと効く): ←→ 回り込み / ↑↓ 高さ / W S 近く・遠く / R F 視線 / Space 一時停止
const heldKeys = new Set();
const KEY_ACTIONS = {
  ArrowLeft: (dt) => adjustYaw(-60 * dt),
  ArrowRight: (dt) => adjustYaw(60 * dt),
  ArrowUp: (dt) => adjustHeight(Math.exp(dt * 1.2)),
  ArrowDown: (dt) => adjustHeight(Math.exp(-dt * 1.2)),
  KeyW: (dt) => adjustDistance(Math.exp(-dt * 1.2)),
  KeyS: (dt) => adjustDistance(Math.exp(dt * 1.2)),
  KeyR: (dt) => adjustTilt(dt * 0.6),
  KeyF: (dt) => adjustTilt(-dt * 0.6),
};
function applyHeldKeys(dt) {
  for (const code of heldKeys) KEY_ACTIONS[code]?.(dt);
}
window.addEventListener('keydown', (e) => {
  if (tour?.kind !== 'path' || e.target.closest?.('input, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) togglePause();
  } else if (e.code === 'Escape') {
    stopTour();
  } else if (KEY_ACTIONS[e.code]) {
    e.preventDefault();
    heldKeys.add(e.code);
  }
});
window.addEventListener('keyup', (e) => heldKeys.delete(e.code));
window.addEventListener('blur', () => heldKeys.clear());

document.querySelectorAll('[data-camera]').forEach((b) => b.addEventListener('click', () => setCameraMode(b.dataset.camera)));
$('reset-look').addEventListener('click', resetFreeLook);

// フライト中は地図の通常操作を止め、ドラッグをカメラの回り込みに使う
const INTERACTIONS = ['dragPan', 'dragRotate', 'scrollZoom', 'touchZoomRotate', 'touchPitch', 'doubleClickZoom', 'keyboard'];
function setFreeLook(on) {
  for (const h of INTERACTIONS) map[h][on ? 'disable' : 'enable']();
  // 視線を上げると注視点が空中になる。中心を地面に合わせ直す機能があるとカメラの高さがずれるので切る
  map.setCenterClampedToGround(!on);
  setAreaLabelsVisible(!on);
  document.body.classList.toggle('free-look', on);
}

{
  const container = map.getCanvasContainer();
  // 1本指/マウス: 左右で回り込み・上下で高さ、2本指: ピンチで距離
  const pointers = new Map();
  let pinchDist = null;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  container.addEventListener('pointerdown', (e) => {
    if (tour?.kind !== 'path') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    container.setPointerCapture(e.pointerId);
    pinchDist = pointers.size === 2 ? spread() : null;
  });
  container.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p || tour?.kind !== 'path') return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size >= 2) {
      const now = spread();
      if (pinchDist) adjustDistance(pinchDist / now);
      pinchDist = now;
      return;
    }
    adjustYaw(-dx * 0.35);
    // Shift を押しながら上下ドラッグで視線、それ以外は高さ
    if (e.shiftKey) adjustTilt(-dy * 0.004);
    else adjustHeight(Math.exp(dy * 0.006));
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    pinchDist = null;
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  container.addEventListener(
    'wheel',
    (e) => {
      if (tour?.kind !== 'path') return;
      e.preventDefault();
      adjustDistance(Math.exp(e.deltaY * 0.0015));
    },
    { passive: false },
  );
}

// ---------------------------------------------------------------------------
// 視点プリセット (方角・角度・回転)
// ---------------------------------------------------------------------------

// 「北から見る」= カメラを北側に置いて南を向く
const FROM_DIRECTION = { n: 180, e: 270, s: 0, w: 90 };
const PITCH_PRESET = { top: 0, oblique: 55, low: 78 };

function stopOrbitOnly() {
  if (tour?.kind === 'orbit') stopTour();
}

document.querySelectorAll('[data-from]').forEach((b) =>
  b.addEventListener('click', () => {
    stopTour();
    map.easeTo({ bearing: FROM_DIRECTION[b.dataset.from], duration: 1200 });
  }),
);
document.querySelectorAll('[data-pitch]').forEach((b) =>
  b.addEventListener('click', () => {
    stopTour();
    const pitch = PITCH_PRESET[b.dataset.pitch];
    // 真上から見るときは全体が入るよう少し引く
    const zoom = pitch === 0 ? Math.min(map.getZoom(), 14) : undefined;
    map.easeTo({ pitch, zoom, duration: 1200 });
  }),
);

// 押している間だけ回転・傾ける
function holdButton(btn, onFrame) {
  let frame = 0;
  let last = null;
  const loop = (t) => {
    // 最初のフレームは時間の基準にするだけ (rAF の時刻は押した瞬間より前のことがあり、差が負になる)
    const dt = last == null ? 0 : Math.min(0.1, Math.max(0, (t - last) / 1000));
    last = t;
    onFrame(dt);
    frame = requestAnimationFrame(loop);
  };
  const start = (e) => {
    e.preventDefault();
    stopOrbitOnly();
    last = null;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(loop);
  };
  const stop = () => cancelAnimationFrame(frame);
  btn.addEventListener('pointerdown', start);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
}

const ROTATE_SPEED = 45; // 度/秒
const TILT_SPEED = 30;
holdButton($('rot-left'), (dt) => {
  if (tour?.kind === 'path') adjustYaw(-ROTATE_SPEED * dt);
  else map.jumpTo({ bearing: map.getBearing() - ROTATE_SPEED * dt });
});
holdButton($('rot-right'), (dt) => {
  if (tour?.kind === 'path') adjustYaw(ROTATE_SPEED * dt);
  else map.jumpTo({ bearing: map.getBearing() + ROTATE_SPEED * dt });
});
holdButton($('tilt-up'), (dt) => {
  if (tour?.kind === 'path') adjustHeight(Math.exp(dt * 1.2));
  else map.jumpTo({ pitch: Math.max(0, map.getPitch() - TILT_SPEED * dt) });
});
holdButton($('tilt-down'), (dt) => {
  if (tour?.kind === 'path') adjustHeight(Math.exp(-dt * 1.2));
  else map.jumpTo({ pitch: Math.min(85, map.getPitch() + TILT_SPEED * dt) });
});

// フライト中に画面下に出るコントローラー
holdButton($('hud-left'), (dt) => adjustYaw(-ROTATE_SPEED * dt));
holdButton($('hud-right'), (dt) => adjustYaw(ROTATE_SPEED * dt));
holdButton($('hud-up'), (dt) => adjustHeight(Math.exp(dt * 1.2)));
holdButton($('hud-down'), (dt) => adjustHeight(Math.exp(-dt * 1.2)));
holdButton($('hud-near'), (dt) => adjustDistance(Math.exp(-dt * 1.2)));
holdButton($('hud-far'), (dt) => adjustDistance(Math.exp(dt * 1.2)));
holdButton($('hud-look-up'), (dt) => adjustTilt(dt * 0.6));
holdButton($('hud-look-down'), (dt) => adjustTilt(-dt * 0.6));
$('hud-pause').addEventListener('click', togglePause);
$('hud-reset').addEventListener('click', resetFreeLook);
$('hud-stop').addEventListener('click', stopTour);

$('orbit').addEventListener('click', async () => {
  if (!current) return;
  stopTour();
  const token = {};
  tour = { frame: 0, token };
  stopBtn.disabled = false;
  tour.kind = 'orbit';
  $('orbit').classList.add('active');
  hideInfo();
  setStatus(`空撮中: ${current.area ? current.area.name : current.resort.name}`);

  const orbitBounds = current.area ? current.area.bounds : current.bounds;
  const center = orbitBounds.getCenter();
  map.fitBounds(orbitBounds, { padding: 40, pitch: 65, bearing: map.getBearing(), duration: 2000 });
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
