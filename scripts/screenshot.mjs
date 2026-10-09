// 本物の地図タイルでアプリの画面を撮影する (GitHub Actions の「画面の撮影」から実行)。
//   node scripts/screenshot.mjs <URL> <出力フォルダ> <撮影内容 JSON>
// 撮影内容: [{ "name": "appi-base", "resort": "appi", "center": [経度, 緯度], "zoom": 16, "pitch": 60, "bearing": 0,
//              "season": "winter", "width": 1280, "height": 800 }]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const [base, outDir, specJson] = process.argv.slice(2);
const shots = JSON.parse(specJson);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const idle = (page, ms) =>
  page.evaluate((ms) => new Promise((r) => { const t = setTimeout(r, ms); map.once('idle', () => { clearTimeout(t); r(); }); map.triggerRepaint(); }), ms);

for (const s of shots) {
  const page = await (await browser.newContext({ viewport: { width: s.width || 1280, height: s.height || 800 } })).newPage();
  page.on('pageerror', (e) => console.log(`  [${s.name}] pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && console.log(`  [${s.name}] console: ${m.text()}`));
  console.log(`撮影: ${s.name}`);
  await page.goto(`${base}/index.html?resort=${s.resort}`);
  await page.waitForFunction(() => /スキー場 \d+ か所/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 180000 });
  if (s.buildings) await page.waitForFunction(() => buildings3d.count > 0, null, { timeout: 120000 });
  if (s.season) await page.$eval(`[data-season=${s.season}]`, (b) => b.click());
  if (s.hidePanel) await page.evaluate(() => document.getElementById('panel').classList.add('collapsed'));
  await page.evaluate((s) => map.jumpTo({ center: s.center, zoom: s.zoom, pitch: s.pitch ?? 60, bearing: s.bearing ?? 0 }), s);
  // タイルの読み込みを待つ (ソフトウェア描画なので遅い)
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(4000);
    await idle(page, 90000);
  }
  if (s.buildings) console.log(`  建物 ${await page.evaluate(() => buildings3d.count)} 棟`);
  await page.screenshot({ path: `${outDir}/${s.name}.png` });
  await page.close();
}
await browser.close();
