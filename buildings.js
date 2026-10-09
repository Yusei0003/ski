// ---------------------------------------------------------------------------
// 建物の立体表示 (resorts.js で buildings: true のエリア)
//
// OpenStreetMap の建物の形 (data/<id>-buildings.js) を、three.js で屋根付きの立体にして地図に重ねる。
//   高さ … OSM の height / building:levels → resorts.js の buildingOverrides → 種類と面積からの推定 の順
//   地面 … 国土地理院の標高タイル (地形の表示と同じ dem_png z14) を直接読んで、建物ごとの地面の高さを求める
//   屋根 … roof:shape があればそれ、無ければ小さい建物は切妻・寄棟、大きい建物は平屋根。冬は雪が積もった色
// 施設 (リフト乗り場・レストラン・ホテルなど) は名前付きのラベルを出す。
// app.js の map / current / GSI_DEM_URL などを使う。
// ---------------------------------------------------------------------------

const THREE_URL = 'https://unpkg.com/three@0.169.0/build/three.module.min.js';
const DEM_ZOOM = 14;
const BURY = 15; // 地形の細かい凸凹で建物が浮かないよう、壁を地面の下まで伸ばす (m)
const EAVE = 0.5; // 傾斜屋根の軒の出 (m)
const POI_MIN_ZOOM = 14.5;

const buildings3d = (() => {
  let THREE = null;
  let threePromise = null;
  let renderer = null;
  let scene = null;
  let camera = null;
  let mesh = null; // 現在のエリアの建物 (THREE.Group)
  let origin = null; // ローカル座標 (m) の原点 [経度, 緯度]
  let state = null; // { resort, parsed, ground }
  let season = 'winter';
  let token = 0;
  let poiMarkers = [];

  const loadThree = () => (threePromise ||= import(THREE_URL).then((m) => (THREE = m)));

  // ------------------------------------------------------------------ データ

  function fetchBundled(id) {
    const loaded = () => window.SKI_BUILDINGS?.[id] || null;
    if (loaded()) return Promise.resolve(loaded());
    return new Promise((resolve) => {
      const script = document.createElement('script');
      const bust = location.protocol === 'file:' ? '' : `?h=${Math.floor(Date.now() / 3600000)}`;
      script.src = `data/${id}-buildings.js${bust}`;
      script.onload = () => resolve(loaded());
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
  }

  // "12 m" "12.5" "40 ft" → m
  function parseLength(v) {
    if (v == null) return null;
    const m = String(v).match(/^\s*([\d.]+)\s*(m|ft|')?/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return m[2] === 'ft' || m[2] === "'" ? n * 0.3048 : n;
  }

  // 文字列から決まる 0〜1 の値 (同じ建物はいつも同じ色・屋根になるように)
  function hash01(n) {
    let x = Number(n) % 2147483647;
    x = (x * 16807) % 2147483647;
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  }

  const SMALL_KINDS = /^(shed|garage|garages|hut|cabin|kiosk|toilets|carport|service|storage_tank|bunker)$/;
  const HOUSE_KINDS = /^(house|detached|residential|semidetached_house|chalet|farm|bungalow|terrace)$/;

  // 階数の推定 (タグが無いとき)
  function guessLevels(kind, area, tags) {
    if (SMALL_KINDS.test(kind)) return 1;
    if (kind === 'hotel' || tags.tourism === 'hotel') return area > 2500 ? 6 : area > 1000 ? 4 : 3;
    if (kind === 'apartments' || kind === 'dormitory') return 4;
    if (tags.tourism === 'guest_house' || kind === 'hostel') return 3;
    if (HOUSE_KINDS.test(kind)) return 2;
    if (area > 2000) return 3;
    if (area < 40) return 1;
    return 2;
  }

  function ringArea(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    return a / 2; // 東・北の座標で反時計回りなら正
  }

  // OSM の要素 → 建物 ({ rings, tags, name, ... }) と施設の点
  function parse(elements, resort) {
    const toRing = (geom) => {
      const pts = geom.map((p) => [p.lon, p.lat]);
      if (pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop();
      return pts;
    };
    const items = [];
    for (const el of elements) {
      const tags = el.tags || {};
      if (!tags.building && !tags['building:part']) continue;
      let outers = [];
      let inners = [];
      if (el.type === 'way' && el.geometry?.length >= 4) outers = [toRing(el.geometry)];
      else if (el.type === 'relation') {
        // 外周が1本の線になっている単純な形だけ扱う
        for (const m of el.members || []) {
          if (!m.geometry || m.geometry.length < 4) continue;
          const first = m.geometry[0];
          const last = m.geometry.at(-1);
          if (first.lat !== last.lat || first.lon !== last.lon) continue;
          (m.role === 'inner' ? inners : outers).push(toRing(m.geometry));
        }
      }
      for (const outer of outers) {
        if (outer.length < 3) continue;
        items.push({ id: el.id, tags, outer, inners: outers.length === 1 ? inners : [], part: !tags.building });
      }
    }

    // building:part がある建物は、外形ではなく部分 (part) の方を描く (OSM の立体建物のきまり)
    const parts = items.filter((b) => b.part);
    const buildings = items.filter((b) => {
      if (b.part) return true;
      return !parts.some((p) => pointInRing(centroidOf(p.outer), b.outer));
    });

    // 施設の点 (建物と同じ名前の点は建物側にまとめる)
    const pois = [];
    const seen = [];
    const addPoi = (lngLat, tags) => {
      const kind = poiKind(tags);
      if (!kind) return;
      const name = tags['name:ja'] || tags.name || tags['name:en'] || '';
      if (!name && !/^(lift|toilet|firstaid)$/.test(kind)) return; // 名前の無い駐車場などは出さない
      if (seen.some((s) => s.name === name && name && distance(s.lngLat, lngLat) < 150)) return;
      seen.push({ name, lngLat });
      pois.push({ lngLat, kind, name });
    };
    for (const b of buildings) addPoi(centroidOf(b.outer), b.tags);
    for (const el of elements) if (el.type === 'node') addPoi([el.lon, el.lat], el.tags || {});

    const overrides = resort.buildingOverrides || [];
    for (const b of buildings) {
      const names = [b.tags.name, b.tags['name:ja'], b.tags['name:en']].filter(Boolean).join(' / ');
      b.name = b.tags['name:ja'] || b.tags.name || '';
      b.override = overrides.find((o) => names && o.match.test(names)) || null;
    }
    return { buildings, pois };
  }

  function poiKind(tags) {
    if (tags.aerialway === 'station') return 'lift';
    if (/^(restaurant|cafe|fast_food|food_court|bar|pub)$/.test(tags.amenity)) return 'food';
    if (/^(hotel|guest_house|hostel|chalet|alpine_hut)$/.test(tags.tourism) || /^(hotel|hostel)$/.test(tags.building)) return 'hotel';
    if (tags.amenity === 'public_bath' || tags.building === 'bath') return 'onsen';
    if (tags.amenity === 'toilets') return 'toilet';
    if (/^(first_aid|clinic)$/.test(tags.amenity)) return 'firstaid';
    if (tags.amenity === 'information' || tags.tourism === 'information') return 'info';
    if (tags.shop || tags.building === 'retail') return 'shop';
    if (tags.amenity === 'parking') return 'parking';
    return null;
  }

  const POI_ICONS = {
    lift: '🚡', food: '🍴', hotel: '🏨', onsen: '♨️', toilet: '🚻', firstaid: '⛑️', info: 'ℹ️', shop: '🛍️', parking: '🅿️',
  };

  function centroidOf(ring) {
    let x = 0;
    let y = 0;
    for (const p of ring) {
      x += p[0];
      y += p[1];
    }
    return [x / ring.length, y / ring.length];
  }

  function pointInRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ------------------------------------------------------------------ 標高

  const demTiles = new Map();

  function demTile(x, y) {
    const key = `${x}/${y}`;
    if (!demTiles.has(key)) {
      const url = GSI_DEM_URL.replace('{z}', DEM_ZOOM).replace('{x}', x).replace('{y}', y);
      demTiles.set(
        key,
        fetch(url)
          .then(async (res) => {
            if (!res.ok) return null;
            const bitmap = await createImageBitmap(await res.blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bitmap, 0, 0);
            const src = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
            const h = new Float32Array(256 * 256);
            for (let i = 0; i < h.length; i++) {
              const v = src[i * 4] * 65536 + src[i * 4 + 1] * 256 + src[i * 4 + 2];
              h[i] = v === 8388608 ? 0 : v > 8388608 ? (v - 16777216) * 0.01 : v * 0.01;
            }
            return h;
          })
          .catch(() => {
            demTiles.delete(key); // 次の機会にもう一度読む
            return null;
          }),
      );
    }
    return demTiles.get(key);
  }

  function tileCoord([lng, lat]) {
    const n = 2 ** DEM_ZOOM;
    const s = Math.sin(toRad(lat));
    return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }

  // 点の標高 (m) を一度にまとめて求める。読めなかった点は null
  async function elevations(points) {
    const coords = points.map(tileCoord);
    const keys = new Set(coords.map(([x, y]) => `${Math.floor(x)}/${Math.floor(y)}`));
    const tiles = new Map();
    await Promise.all(
      [...keys].map(async (k) => {
        const [x, y] = k.split('/').map(Number);
        tiles.set(k, await demTile(x, y));
      }),
    );
    return coords.map(([x, y]) => {
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      const h = tiles.get(`${tx}/${ty}`);
      if (!h) return null;
      // 画素の中心どうしで双線形補間 (タイルの端は端の画素を使う)
      const px = Math.min(255, Math.max(0, (x - tx) * 256 - 0.5));
      const py = Math.min(255, Math.max(0, (y - ty) * 256 - 0.5));
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(255, x0 + 1);
      const y1 = Math.min(255, y0 + 1);
      const fx = px - x0;
      const fy = py - y0;
      const top = h[y0 * 256 + x0] * (1 - fx) + h[y0 * 256 + x1] * fx;
      const bottom = h[y1 * 256 + x0] * (1 - fx) + h[y1 * 256 + x1] * fx;
      return top * (1 - fy) + bottom * fy;
    });
  }

  // 建物ごとに、頂点と重心の地面の高さ (誇張なし) を求める
  async function groundOf(buildings) {
    const pts = [];
    for (const b of buildings) pts.push(centroidOf(b.outer), ...b.outer);
    const hs = await elevations(pts);
    let i = 0;
    return buildings.map((b) => {
      const center = hs[i++];
      const vs = hs.slice(i, i + b.outer.length).filter((v) => v != null);
      i += b.outer.length;
      if (center == null || !vs.length) return null;
      return { center, min: Math.min(...vs), max: Math.max(...vs) };
    });
  }

  // ------------------------------------------------------------------ 形を作る

  // [経度, 緯度] → 原点からの [東 m, 北 m] (メルカトル座標の差を原点での 1m の長さで割る。地図の描画と同じ平面)
  function makeProjector(o) {
    const base = maplibregl.MercatorCoordinate.fromLngLat(o);
    const scale = base.meterInMercatorCoordinateUnits();
    return ([lng, lat]) => {
      const m = maplibregl.MercatorCoordinate.fromLngLat([lng, lat]);
      return [(m.x - base.x) / scale, -(m.y - base.y) / scale];
    };
  }

  // 最小の外接長方形 (傾斜屋根を架けるのに使う)。凸包の辺の向きを全部試す
  function orientedBox(pts) {
    const hull = convexHull(pts);
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      const ux = (b[0] - a[0]) / len;
      const uy = (b[1] - a[1]) / len;
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const p of hull) {
        const u = p[0] * ux + p[1] * uy;
        const v = -p[0] * uy + p[1] * ux;
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) best = { area, ux, uy, minU, maxU, minV, maxV };
    }
    return best;
  }

  function convexHull(points) {
    const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (const p of pts.reverse()) {
      while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
      upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  const WALL_COLORS = ['#efe7da', '#e4d6bf', '#c9a57e', '#f2f2ee', '#d8cfc2', '#a8805c', '#e9e2d0'];
  const ROOF_COLORS = ['#6e2f2a', '#3b4658', '#4e5d45', '#5d4b3e', '#2e3440', '#7a5a3a'];
  const SNOW_ROOF = '#f4f7fb';

  // 1棟分の形の情報 (高さ・屋根) を決める
  function shapeOf(b, pts, g, exag) {
    const t = b.tags;
    const ov = b.override || {};
    const kind = t.building || t['building:part'] || 'yes';
    const area = Math.abs(ringArea(pts));
    const levels = ov.levels ?? (parseFloat(t['building:levels']) || guessLevels(kind, area, t));
    const levelHeight = ov.levelHeight ?? (kind === 'hotel' || t.tourism === 'hotel' ? 3.3 : 3.0);
    const minHeight = parseLength(t.min_height) ?? (parseFloat(t['building:min_level']) || 0) * levelHeight;

    // 屋根の形
    let roofShape = t['roof:shape'] || ov.roofShape;
    const box = orientedBox(pts);
    const boxW = box.maxU - box.minU;
    const boxD = box.maxV - box.minV;
    const rectangular = area / box.area > 0.82 && !b.inners.length;
    if (!roofShape) {
      const r = hash01(b.id);
      if (kind === 'roof' || kind === 'carport') roofShape = 'flat';
      else if (area < 600 && !(kind === 'hotel' || kind === 'apartments' || kind === 'retail')) {
        roofShape = r < 0.6 ? 'gabled' : 'hipped';
      } else roofShape = 'flat';
    }
    if (roofShape !== 'flat' && !rectangular) roofShape = 'flat';
    const short = Math.min(boxW, boxD);
    let roofHeight = 0;
    if (roofShape !== 'flat') {
      roofHeight = parseLength(t['roof:height']) ?? (parseFloat(t['roof:levels']) || 0) * levelHeight;
      if (!roofHeight) roofHeight = Math.min(6, Math.max(1.2, short * (roofShape === 'skillion' ? 0.2 : 0.32)));
    }

    let height = ov.height ?? parseLength(t.height);
    if (height == null) height = kind === 'roof' || kind === 'carport' ? 4 : levels * levelHeight + roofHeight;
    height = Math.max(height, minHeight + 1);

    // 斜面の建物は、上側の地面から見ても埋まらないよう少し高めの位置を基準にする
    const ref = g.min + 0.6 * (g.max - g.min);
    const ground = ref * exag;
    const top = Math.max(ground + height, g.max * exag + 2.5 + roofHeight);
    const wallTop = top - roofHeight;
    const base = minHeight > 0 ? ground + minHeight : g.min * exag - BURY;

    const r1 = hash01(b.id + 7);
    const r2 = hash01(b.id + 13);
    const wall = t['building:colour'] || ov.color || (kind === 'hotel' ? '#ece6da' : WALL_COLORS[Math.floor(r1 * WALL_COLORS.length)]);
    const roof = season === 'winter' ? SNOW_ROOF : t['roof:colour'] || ROOF_COLORS[Math.floor(r2 * ROOF_COLORS.length)];
    const windows = !SMALL_KINDS.test(kind) && kind !== 'roof' && kind !== 'carport';
    // 窓の段: 基準の地面から1階ずつ (地面より下の段も地下階として同じ模様)
    return { box, roofShape, roofHeight, wallTop, base, ground, levelHeight, wall, roof, windows, across: t['roof:orientation'] === 'across' };
  }

  // 頂点をためる入れ物
  function makeBuffer() {
    return { pos: [], nor: [], col: [], uv: [] };
  }

  function pushTri(buf, a, b, c, color, uvs) {
    // 面の向きは法線で決める (両面描画なので巻き方向は気にしない)
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    if (ny < -0.01) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const [i, p] of [a, b, c].entries()) {
      buf.pos.push(p[0], p[1], p[2]);
      buf.nor.push(nx, ny, nz);
      buf.col.push(color.r, color.g, color.b);
      const uv = uvs ? uvs[i] : [0.02, 0.02];
      buf.uv.push(uv[0], uv[1]);
    }
  }

  // 壁 (外側向きの法線を明示する)
  function pushWall(buf, p, q, bottom, top, color, s0, levelHeight, ground, windows, normal) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const u0 = windows ? s0 / 3.6 : 0.02;
    const u1 = windows ? (s0 + len) / 3.6 : 0.02;
    const v = (h) => (windows ? (h - ground) / levelHeight : 0.02);
    // ローカル座標: x = 東, y = 上, z = 南
    const A = [p[0], bottom, -p[1]];
    const B = [q[0], bottom, -q[1]];
    const C = [q[0], top, -q[1]];
    const D = [p[0], top, -p[1]];
    const quad = [
      [A, [u0, v(bottom)]],
      [B, [u1, v(bottom)]],
      [C, [u1, v(top)]],
      [A, [u0, v(bottom)]],
      [C, [u1, v(top)]],
      [D, [u0, v(top)]],
    ];
    for (const [pt, uv] of quad) {
      buf.pos.push(...pt);
      buf.nor.push(normal[0], 0, normal[1]);
      buf.col.push(color.r, color.g, color.b);
      buf.uv.push(uv[0], uv[1]);
    }
  }

  function addBuilding(walls, roofs, b, pts, holes, g, exag) {
    const s = shapeOf(b, pts, g, exag);
    const wallColor = new THREE.Color(s.wall);
    const roofColor = new THREE.Color(s.roof);
    if (!Number.isFinite(wallColor.r)) wallColor.set('#e8e2d6');

    // 壁: 外周は反時計回り、穴は時計回りにそろえると、辺の右手側が外になる
    const rings = [ringArea(pts) > 0 ? pts : [...pts].reverse(), ...holes.map((h) => (ringArea(h) < 0 ? h : [...h].reverse()))];
    for (const ring of rings) {
      let s0 = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const len = Math.hypot(dx, dy);
        if (len < 0.05) continue;
        // 外向きの法線 (東, 北) → ローカル座標 (x, z) = (東, -北)
        pushWall(walls, p, q, s.base, s.wallTop, wallColor, s0, s.levelHeight, s.ground, s.windows, [dy / len, dx / len]);
        s0 += len;
      }
    }

    if (s.roofShape === 'flat') {
      const contour = rings[0].map(([x, y]) => new THREE.Vector2(x, y));
      const holeVs = rings.slice(1).map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
      const all = [...rings[0], ...rings.slice(1).flat()];
      const y = s.wallTop + s.roofHeight;
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holeVs)) {
        pushTri(roofs, [all[i][0], y, -all[i][1]], [all[j][0], y, -all[j][1]], [all[k][0], y, -all[k][1]], roofColor);
      }
      return;
    }

    // 傾斜屋根: 外接長方形 (軒の分だけ広げる) に架ける
    const { box } = s;
    let ux = box.ux;
    let uy = box.uy;
    let minU = box.minU - EAVE;
    let maxU = box.maxU + EAVE;
    let minV = box.minV - EAVE;
    let maxV = box.maxV + EAVE;
    // 棟は長い辺の向き (roof:orientation=across なら短い辺の向き)
    const alongU = maxU - minU >= maxV - minV;
    if (alongU === s.across) {
      [ux, uy] = [-uy, ux];
      [minU, maxU, minV, maxV] = [minV, maxV, -maxU, -minU];
    }
    const at = (u, v, y) => {
      const e = u * ux - v * uy;
      const n = u * uy + v * ux;
      return [e, y, -n];
    };
    const y0 = s.wallTop - EAVE * 0.35; // 軒先は壁の上端より少し下がる
    const y1 = s.wallTop + s.roofHeight;
    const midV = (minV + maxV) / 2;
    const c1 = at(minU, minV, y0);
    const c2 = at(maxU, minV, y0);
    const c3 = at(maxU, maxV, y0);
    const c4 = at(minU, maxV, y0);
    const halfD = (maxV - minV) / 2;

    if (s.roofShape === 'pyramidal' || s.roofShape === 'dome') {
      const apex = at((minU + maxU) / 2, midV, y1);
      for (const [p, q] of [[c1, c2], [c2, c3], [c3, c4], [c4, c1]]) pushTri(roofs, p, q, apex, roofColor);
      return;
    }
    if (s.roofShape === 'skillion') {
      const h3 = at(maxU, maxV, y1);
      const h4 = at(minU, maxV, y1);
      pushTri(roofs, c1, c2, h3, roofColor);
      pushTri(roofs, c1, h3, h4, roofColor);
      pushTri(walls, at(minU, minV, y0), at(minU, maxV, y0), h4, wallColor);
      pushTri(walls, at(maxU, minV, y0), at(maxU, maxV, y0), h3, wallColor);
      return;
    }
    // 切妻 (gabled) と寄棟 (hipped など)
    const inset = s.roofShape === 'gabled' ? 0 : Math.min(halfD, (maxU - minU) / 2 - 0.1);
    const r1 = at(minU + inset, midV, y1);
    const r2 = at(maxU - inset, midV, y1);
    pushTri(roofs, c1, c2, r2, roofColor);
    pushTri(roofs, c1, r2, r1, roofColor);
    pushTri(roofs, c4, c3, r2, roofColor);
    pushTri(roofs, c4, r2, r1, roofColor);
    if (s.roofShape === 'gabled') {
      // 妻側の三角の壁 (軒の位置まで)
      pushTri(walls, c1, c4, r1, wallColor);
      pushTri(walls, c2, c3, r2, wallColor);
    } else {
      pushTri(roofs, c1, c4, r1, roofColor);
      pushTri(roofs, c2, c3, r2, roofColor);
    }
  }

  // 窓の模様 (1階分 × 3.6m を1枚にして繰り返す)。色は頂点色を掛ける
  function windowTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#66768a';
    ctx.fillRect(16, 18, 32, 22);
    ctx.fillStyle = '#8fa0b3'; // 空が映った上の方
    ctx.fillRect(16, 18, 32, 7);
    ctx.fillStyle = '#e4e0d8';
    ctx.fillRect(13, 40, 38, 3); // 窓の下の縁
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function toGeometry(buf) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    return geo;
  }

  let wallTexture = null;

  function rebuild() {
    if (!THREE || !scene) return;
    if (mesh) {
      scene.remove(mesh);
      mesh.traverse((o) => o.geometry?.dispose());
      mesh = null;
    }
    if (!state?.ground) {
      map.triggerRepaint();
      return;
    }
    const exag = map.getTerrain()?.exaggeration ?? 1;
    const project = makeProjector(origin);
    const walls = makeBuffer();
    const roofs = makeBuffer();
    state.parsed.buildings.forEach((b, i) => {
      const g = state.ground[i];
      if (!g) return;
      const pts = b.outer.map(project);
      const holes = b.inners.map((h) => h.map(project));
      addBuilding(walls, roofs, b, pts, holes, g, exag);
    });
    wallTexture ||= windowTexture();
    const group = new THREE.Group();
    group.add(
      new THREE.Mesh(toGeometry(walls), new THREE.MeshLambertMaterial({ vertexColors: true, map: wallTexture, side: THREE.DoubleSide })),
      new THREE.Mesh(toGeometry(roofs), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })),
    );
    mesh = group;
    scene.add(mesh);
    map.triggerRepaint();
  }

  // ------------------------------------------------------------------ 地図への重ね方

  const layer = {
    id: 'buildings-3d',
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      // 太陽は南西の空 (x = 東, y = 上, z = 南)
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(-0.45, 1, 0.7);
      scene.add(sun, new THREE.HemisphereLight(0xdfe8f5, 0x8a8f96, 1.5));
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      rebuild();
    },
    render(gl, args) {
      if (!mesh || map.getZoom() < 11.5) return;
      const vp = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
      const model = new THREE.Matrix4().fromArray(map.transform.getMatrixForModel(origin, 0));
      camera.projectionMatrix = vp.multiply(model);
      renderer.resetState();
      renderer.render(scene, camera);
    },
  };

  function ensureLayer() {
    if (!map.getLayer(layer.id)) map.addLayer(layer, map.getLayer('lift-labels') ? 'lift-labels' : undefined);
  }

  // ------------------------------------------------------------------ 施設のラベル

  function clearPois() {
    for (const m of poiMarkers) m.remove();
    poiMarkers = [];
  }

  function renderPois(pois) {
    clearPois();
    for (const p of pois) {
      const el = document.createElement('div');
      el.className = `poi-marker poi-${p.kind}`;
      el.innerHTML = '<span class="poi-icon"></span><span class="poi-name"></span>';
      el.children[0].textContent = POI_ICONS[p.kind];
      el.children[1].textContent = p.name;
      el.title = p.name;
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(p.lngLat).addTo(map);
      marker._poiKind = p.kind;
      poiMarkers.push(marker);
    }
    updatePoiVisibility();
  }

  // 大事な施設から順に置き、先に置いたラベルと重なるものは隠す
  const POI_PRIORITY = ['lift', 'food', 'onsen', 'hotel', 'info', 'firstaid', 'toilet', 'shop', 'parking'];
  function declutterPois() {
    if (!document.body.classList.contains('show-pois')) return;
    const placed = [];
    const order = [...poiMarkers].sort(
      (a, b) => POI_PRIORITY.indexOf(a._poiKind) - POI_PRIORITY.indexOf(b._poiKind),
    );
    for (const m of order) {
      const p = map.project(m.getLngLat());
      const w = m.getElement().offsetWidth || 80;
      const box = [p.x - w / 2, p.y - 24, p.x + w / 2, p.y];
      const hit = placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]);
      m.getElement().classList.toggle('poi-hidden', hit);
      if (!hit) placed.push(box);
    }
  }

  function updatePoiVisibility() {
    document.body.classList.toggle('show-pois', map.getZoom() >= POI_MIN_ZOOM);
    declutterPois();
  }
  map.on('moveend', updatePoiVisibility);
  map.on('zoomend', updatePoiVisibility);

  // ------------------------------------------------------------------ 公開する操作

  async function load(resort) {
    const my = ++token;
    clearPois();
    state = null;
    rebuild();
    if (!resort.buildings) return;
    let data;
    try {
      [data] = await Promise.all([fetchBundled(resort.id), loadThree()]);
    } catch (e) {
      console.warn('建物の表示を準備できませんでした', e);
      return;
    }
    if (my !== token || !data?.elements?.length) return;
    origin = resort.center;
    const parsed = parse(data.elements, resort);
    state = { resort, parsed, ground: null };
    ensureLayer();
    renderPois(parsed.pois);
    const ground = await groundOf(parsed.buildings);
    if (my !== token) return;
    state.ground = ground;
    rebuild();
  }

  return {
    load,
    refresh: rebuild, // 地形の誇張を変えたとき
    setSeason(name) {
      season = name;
      rebuild();
    },
    get count() {
      return state?.ground ? state.ground.filter(Boolean).length : 0;
    },
  };
})();
