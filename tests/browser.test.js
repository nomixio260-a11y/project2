// 実ブラウザ(Puppeteer)で index.html を読み込み、
// 実行時エラーが無いこと・ゲームが初期化されること・描画と編集が動くことを検証する。
//   node --test tests/browser.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

let server;
let baseURL;
let browser;
let puppeteer;

before(async () => {
  puppeteer = require("puppeteer");
  // 簡易静的サーバ。
  server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseURL = "http://127.0.0.1:" + server.address().port + "/";

  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

async function openPage(viewport) {
  const page = await browser.newPage();
  if (viewport) await page.setViewport(viewport);
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push("console.error: " + msg.text());
  });
  await page.goto(baseURL, { waitUntil: "networkidle0" });
  // ブートとループ開始を待つ。
  await page.waitForFunction("window.Game && Game.state && Game.state.world", { timeout: 5000 });
  return { page, errors };
}

test("デスクトップ: エラー無く初期化され地形が生成される", async () => {
  const { page, errors } = await openPage({ width: 1280, height: 800 });

  const info = await page.evaluate(() => {
    const w = Game.state.world;
    const seen = new Set();
    for (let i = 0; i < w.terrain.length; i++) seen.add(w.terrain[i]);
    return {
      width: w.width,
      height: w.height,
      terrainTypes: seen.size,
      hasCamera: !!Game.state.camera,
      hasRenderer: !!Game.state.renderer,
      canvasW: document.getElementById("game").width,
    };
  });

  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  assert.ok(info.terrainTypes >= 4, "地形の種類が少ない: " + info.terrainTypes);
  assert.ok(info.hasCamera && info.hasRenderer);
  assert.ok(info.canvasW > 0, "canvas未初期化");
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));

  await page.close();
});

test("ツール編集: 中心付近をクリックで地形が変化する", async () => {
  const { page, errors } = await openPage({ width: 1280, height: 800 });

  const changed = await page.evaluate(async () => {
    // 山ツールを選び、ブラシを大きくして中央に適用。
    Game.setActiveTool("mountain");
    Game.setBrushSize(8);
    const w = Game.state.world;
    const cam = Game.state.camera;
    const cfg = Game.config;
    // ワールド中央タイル
    const tx = (cfg.mapWidth / 2) | 0;
    const ty = (cfg.mapHeight / 2) | 0;
    // そのタイルのスクリーン座標を求める
    const sx = cam.worldToScreenX((tx + 0.5) * cfg.tilePx);
    const sy = cam.worldToScreenY((ty + 0.5) * cfg.tilePx);
    const before = w.getTerrain(tx, ty);
    Game.state.input.applyAt(sx, sy);
    const after = w.getTerrain(tx, ty);
    return { before, after, mountain: Game.TERRAIN.MOUNTAIN };
  });

  assert.equal(changed.after, changed.mountain, "山に変化していない");
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));
  await page.close();
});

test("レスポンシブ: スマホ縦サイズでcanvasが画面いっぱいになる", async () => {
  const { page, errors } = await openPage({
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

  const layout = await page.evaluate(() => {
    const canvas = document.getElementById("game");
    const toggle = document.getElementById("toolbar-toggle");
    return {
      cssW: canvas.clientWidth,
      cssH: canvas.clientHeight,
      // 高DPI: 実バッファは CSS の deviceScaleFactor 倍
      bufW: canvas.width,
      toggleVisible: getComputedStyle(toggle).display !== "none",
      innerW: window.innerWidth,
      innerH: window.innerHeight,
    };
  });

  assert.equal(layout.cssW, layout.innerW, "canvas幅が画面に合っていない");
  assert.equal(layout.cssH, layout.innerH, "canvas高さが画面に合っていない");
  assert.ok(layout.bufW >= layout.cssW * 2, "高DPIバッファになっていない: " + layout.bufW);
  assert.ok(layout.toggleVisible, "モバイルのツールバートグルが表示されていない");
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));
  await page.close();
});

test("タッチ操作: 1本指タップで地形が変化する", async () => {
  const { page, errors } = await openPage({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });

  const result = await page.evaluate(async () => {
    Game.setActiveTool("water");
    Game.setBrushSize(6);
    const w = Game.state.world;
    const cam = Game.state.camera;
    const cfg = Game.config;
    const tx = (cfg.mapWidth / 2) | 0;
    const ty = (cfg.mapHeight / 2) | 0;
    const sx = cam.worldToScreenX((tx + 0.5) * cfg.tilePx);
    const sy = cam.worldToScreenY((ty + 0.5) * cfg.tilePx);

    const canvas = document.getElementById("game");
    const before = w.getTerrain(tx, ty);
    // タッチイベントを合成
    function makeTouch(id, x, y) {
      return new Touch({ identifier: id, target: canvas, clientX: x, clientY: y });
    }
    const t = makeTouch(1, sx, sy);
    canvas.dispatchEvent(
      new TouchEvent("touchstart", { touches: [t], changedTouches: [t], bubbles: true, cancelable: true })
    );
    canvas.dispatchEvent(
      new TouchEvent("touchend", { touches: [], changedTouches: [t], bubbles: true, cancelable: true })
    );
    const after = w.getTerrain(tx, ty);
    return { before, after, deepWater: Game.TERRAIN.DEEP_WATER };
  });

  assert.equal(result.after, result.deepWater, "タッチで水に変化していない");
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));
  await page.close();
});

test("再生成: 新しい世界ボタンでマップが変わる", async () => {
  const { page, errors } = await openPage({ width: 1024, height: 768 });

  const diff = await page.evaluate(() => {
    const w = Game.state.world;
    const before = Array.from(w.terrain.slice(0, 2000));
    Game.regenerate();
    const w2 = Game.state.world;
    const after = Array.from(w2.terrain.slice(0, 2000));
    let differences = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) differences++;
    return differences;
  });

  assert.ok(diff > 0, "再生成してもマップが変わらない");
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));
  await page.close();
});
