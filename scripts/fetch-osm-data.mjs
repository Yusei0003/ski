// resorts.js の各エリアについて OpenStreetMap からコース・リフト・スキー場範囲を取得し、
// data/<id>.js に保存する。GitHub Actions (.github/workflows/update-osm-data.yml) から週1回実行される。
//
//   node scripts/fetch-osm-data.mjs            全エリア
//   node scripts/fetch-osm-data.mjs hakuba     指定したエリアだけ
//
// 取得に失敗したエリアは既存のファイルをそのまま残す。全エリア失敗したときだけ終了コード 1。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data');
const USER_AGENT = 'ski3d-data-updater (https://github.com/Yusei0003/ski)';
const TIMEOUT_MS = 180 * 1000;
const WAIT_MS = Number(process.env.WAIT_MS ?? 1000); // 待ち時間の単位 (テスト用に短くできる)

// ブラウザ用の resorts.js / osm-query.js をそのまま読み込む
async function loadBrowserScripts() {
  const context = { window: {} };
  vm.createContext(context);
  for (const file of ['resorts.js', 'osm-query.js']) {
    vm.runInContext(await readFile(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  return context.window;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFrom(endpoint, query) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark);
  if (!json.elements?.length) throw new Error('データが空です');
  return json;
}

// サーバーを順番に試し、全滅したら待ってからもう一周 (最大3周)
async function fetchWithRetry(endpoints, query) {
  const errors = [];
  for (let round = 0; round < 3; round++) {
    if (round > 0) await sleep(60 * WAIT_MS * round);
    for (const endpoint of endpoints) {
      try {
        return await fetchFrom(endpoint, query);
      } catch (e) {
        errors.push(`${endpoint}: ${e.message}`);
        console.warn(`  失敗 ${endpoint}: ${e.message}`);
      }
    }
  }
  throw new Error(errors.join('\n'));
}

// アプリが使う項目だけ残してファイルを小さくする
function slim(osm) {
  const geom = (g) => g?.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) }));
  return osm.elements.map((el) => {
    const out = { type: el.type, id: el.id, tags: el.tags };
    if (el.type === 'node') Object.assign(out, { lat: +el.lat.toFixed(6), lon: +el.lon.toFixed(6) });
    if (el.geometry) out.geometry = geom(el.geometry);
    if (el.members) {
      out.members = el.members
        .filter((m) => m.type === 'way' && m.geometry)
        .map((m) => ({ type: m.type, role: m.role, geometry: geom(m.geometry) }));
    }
    return out;
  });
}

// アプリがファイルを直接開いた (file://) ときも読めるよう、JSON ではなく <script> で読める形で保存する
function toDataScript(id, body, global = 'SKI_DATA') {
  return `window.${global} = window.${global} || {};\nwindow.${global}[${JSON.stringify(id)}] = ${JSON.stringify(body)};\n`;
}
function parseDataScript(text) {
  const start = text.indexOf('] = ') + 4;
  return JSON.parse(text.slice(start, text.lastIndexOf(';')));
}

const { RESORTS, OVERPASS_ENDPOINTS, buildOsmQuery, buildBuildingQuery } = await loadBrowserScripts();
const endpoints = process.env.OVERPASS_ENDPOINTS ? process.env.OVERPASS_ENDPOINTS.split(',') : OVERPASS_ENDPOINTS;
const only = process.argv.slice(2);
const targets = only.length ? RESORTS.filter((r) => only.includes(r.id)) : RESORTS;
await mkdir(OUT_DIR, { recursive: true });

// コース・リフト (data/<id>.js) と、buildings: true のエリアは建物・施設 (data/<id>-buildings.js)
const jobs = [];
for (const resort of targets) {
  jobs.push({ resort, label: 'コース・リフト', file: `${resort.id}.js`, global: 'SKI_DATA', query: buildOsmQuery(resort.bbox) });
  if (resort.buildings) {
    jobs.push({ resort, label: '建物・施設', file: `${resort.id}-buildings.js`, global: 'SKI_BUILDINGS', query: buildBuildingQuery(resort.bbox) });
  }
}

let ok = 0;
for (const [i, job] of jobs.entries()) {
  const { resort } = job;
  if (i > 0) await sleep(10 * WAIT_MS); // サーバーに負担をかけないよう間隔をあける
  console.log(`${resort.name} (${resort.id}) の${job.label}を取得中…`);
  try {
    const osm = await fetchWithRetry(endpoints, job.query);
    const elements = slim(osm);
    const file = path.join(OUT_DIR, job.file);
    const previous = await readFile(file, 'utf8').then(parseDataScript).catch(() => null);
    if (previous && JSON.stringify(previous.elements) === JSON.stringify(elements)) {
      console.log(`  変更なし: data/${job.file} (${elements.length} 件)`);
      ok++;
      continue;
    }
    const body = { generated: new Date().toISOString(), source: 'OpenStreetMap contributors (ODbL)', elements };
    await writeFile(file, toDataScript(resort.id, body, job.global));
    console.log(`  保存しました: data/${job.file} (${elements.length} 件)`);
    ok++;
  } catch (e) {
    console.error(`  ${resort.name} の${job.label}の取得に失敗しました。既存のファイルを残します。\n${e.message}`);
  }
}

console.log(`完了: ${ok}/${jobs.length} 件`);
if (ok === 0) process.exit(1);
