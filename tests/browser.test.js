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
  // networkidle は描画ループでメインスレッドが飽和すると不安定なため、
  // DOM 構築完了で待ち、ブート完了は waitForFunction で確認する。
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.Game && Game.state && Game.state.world", { timeout: 10000 });
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
      cfgW: Game.config.mapWidth,
      cfgH: Game.config.mapHeight,
      terrainTypes: seen.size,
      hasCamera: !!Game.state.camera,
      hasRenderer: !!Game.state.renderer,
      canvasW: document.getElementById("game").width,
    };
  });

  assert.equal(info.width, info.cfgW, "world 幅が config と一致");
  assert.equal(info.height, info.cfgH, "world 高さが config と一致");
  assert.ok(info.width >= 256, "マップが十分大きい");
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

test("生物シミュレーション: spawn → tick で個体が動き繁殖/死亡する", async () => {
  const { page, errors } = await openPage({ width: 1280, height: 800 });

  const sim = await page.evaluate(async () => {
    const w = Game.state.world;
    const ent = Game.state.entities;
    const sys = Game.state.creatures;
    // 中央付近を草原で塗って食料を確保。
    const cx = (w.width / 2) | 0;
    const cy = (w.height / 2) | 0;
    for (let y = cy - 10; y < cy + 10; y++) {
      for (let x = cx - 10; x < cx + 10; x++) {
        w.setTerrain(x, y, Game.TERRAIN.GRASS);
        w.setElevation(x, y, 0.5);
      }
    }
    // 草食を多数スポーン。
    for (let i = 0; i < 30; i++) {
      ent.spawn(Game.SPECIES.HERBIVORE, cx + (i % 10) - 5, cy + ((i / 10) | 0) - 1, 0.9);
    }
    const x0 = ent.x[0];
    const y0 = ent.y[0];
    const liveStart = ent.live;
    // 数十ティック進める。
    for (let t = 0; t < 60; t++) sys.tick(w);
    return {
      moved: ent.x[0] !== x0 || ent.y[0] !== y0,
      liveStart,
      liveEnd: ent.live,
      cap: Game.config.sim.maxEntities,
      hasSpawnTool: !!Game.godpowers.get("herbivore"),
      hasPredatorTool: !!Game.godpowers.get("predator"),
    };
  });

  assert.ok(sim.moved, "生物が移動していない");
  assert.ok(sim.liveStart >= 30, "初期個体数が足りない");
  assert.ok(sim.liveEnd > 0, "全滅してしまった");
  assert.ok(sim.liveEnd <= sim.cap, "上限を超えた");
  assert.ok(sim.hasSpawnTool && sim.hasPredatorTool, "生物ツールが登録されていない");
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));
  await page.close();
});

test("炎の延焼: 着火 → 延焼して焼け地が残り、やがて鎮火する", async () => {
  const { page, errors } = await openPage({ width: 1280, height: 800 });

  const result = await page.evaluate(async () => {
    const w = Game.state.world;
    const fire = Game.state.fire;
    const cx = (w.width / 2) | 0;
    const cy = (w.height / 2) | 0;
    // 中央に森のパッチを作り、周囲を砂の防火帯で囲って延焼を封じ込める。
    for (let y = cy - 14; y < cy + 14; y++) {
      for (let x = cx - 14; x < cx + 14; x++) {
        const edge = x < cx - 11 || x >= cx + 11 || y < cy - 11 || y >= cy + 11;
        w.setTerrain(x, y, edge ? Game.TERRAIN.SAND : Game.TERRAIN.FOREST);
      }
    }
    // 中心に着火。
    fire.ignite(cx, cy);
    const litStart = fire.active.length;
    let maxActive = 0;
    for (let t = 0; t < 200; t++) {
      fire.tick(w);
      if (fire.active.length > maxActive) maxActive = fire.active.length;
    }
    let scorched = 0;
    for (let i = 0; i < w.terrain.length; i++) {
      if (w.terrain[i] === Game.TERRAIN.SCORCHED) scorched++;
    }
    return {
      litStart,
      maxActive,
      finalActive: fire.active.length,
      scorched,
      hasIgniteTool: !!Game.godpowers.get("ignite"),
    };
  });

  assert.equal(result.litStart, 1, "着火できていない");
  assert.ok(result.maxActive > 1, "延焼で炎が広がっていない");
  assert.ok(result.scorched > 5, "焼け地が残っていない: " + result.scorched);
  assert.equal(result.finalActive, 0, "鎮火していない");
  assert.ok(result.hasIgniteTool, "着火ツールが無い");
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));
  await page.close();
});

test("文明: 建国 → 領土が拡張し、territoryオーバーレイが更新される", async () => {
  const { page, errors } = await openPage({ width: 1280, height: 800 });

  const result = await page.evaluate(async () => {
    const w = Game.state.world;
    const civ = Game.state.civ;
    const cx = (w.width / 2) | 0;
    const cy = (w.height / 2) | 0;
    // 中央周辺を草原にして拡張余地を作り、既存（初期生成）の領有を一旦消して場を空ける。
    for (let y = cy - 30; y < cy + 30; y++) {
      for (let x = cx - 30; x < cx + 30; x++) {
        w.setTerrain(x, y, Game.TERRAIN.GRASS);
        w.owner[y * w.width + x] = 0;
      }
    }
    const kBefore = civ.kingdoms.length - 1;
    const a = civ.foundAt(cx - 15, cy);
    const b = civ.foundAt(cx + 15, cy);
    for (let t = 0; t < 160; t++) civ.tick(w);
    let owned = 0;
    for (let i = 0; i < w.owner.length; i++) if (w.owner[i] !== 0) owned++;
    return {
      a, b,
      added: (civ.kingdoms.length - 1) - kBefore,
      ownedTiles: owned,
      hasTerritoryCanvas: !!Game.state.renderer.territoryCanvas,
      hasHumanTool: !!Game.godpowers.get("human"),
    };
  });

  assert.ok(result.a > 0 && result.b > 0, "建国に失敗");
  assert.ok(result.added >= 2, "新たな建国が反映されない: " + result.added);
  assert.ok(result.ownedTiles > 50, "領土が拡張していない: " + result.ownedTiles);
  assert.ok(result.hasTerritoryCanvas, "領土オーバーレイが無い");
  assert.ok(result.hasHumanTool, "人間ツールが無い");
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));
  await page.close();
});

test("シミュレーション制御: 一時停止と速度変更が反映される", async () => {
  const { page, errors } = await openPage({ width: 1280, height: 800 });

  const ctrl = await page.evaluate(() => {
    Game.setPaused(true);
    const paused = Game.config.sim.running === false;
    Game.setPaused(false);
    const resumed = Game.config.sim.running === true;
    Game.setSpeed(4);
    const speed = Game.config.sim.speed;
    return { paused, resumed, speed };
  });

  assert.ok(ctrl.paused, "一時停止が効かない");
  assert.ok(ctrl.resumed, "再生が効かない");
  assert.equal(ctrl.speed, 4, "速度が反映されない");
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));
  await page.close();
});

test("再生成: 新しい世界ボタンでマップが変わる", async () => {
  const { page, errors } = await openPage({ width: 1024, height: 768 });

  const diff = await page.evaluate(() => {
    const w = Game.state.world;
    // マップ全体を比較する（島マップの上端は一様に海なので、先頭だけの比較では
    //   新シードでも差が出ず不安定になる。全タイルで比べれば内陸が必ず変わる）。
    const before = Uint8Array.from(w.terrain);
    Game.regenerate();
    const after = Game.state.world.terrain;
    let differences = 0;
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i++) if (before[i] !== after[i]) differences++;
    return differences;
  });

  assert.ok(diff > 100, "再生成してもマップが変わらない: " + diff);
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));
  await page.close();
});

test("セーブ/ロード: 世界状態を保存して復元できる", async () => {
  const { page, errors } = await openPage({ width: 1280, height: 800 });
  const res = await page.evaluate(() => {
    const civ = Game.state.civ, w = Game.state.world, cfg = Game.config;
    let founded = 0;
    for (let a = 0; a < 6000 && founded < 4; a++) {
      const x = (Math.random() * cfg.mapWidth) | 0, y = (Math.random() * cfg.mapHeight) | 0;
      const t = w.terrain[y * cfg.mapWidth + x];
      if (t >= 3 && t <= 5 && civ.foundAt(x, y) > 0) founded++;
    }
    for (let i = 0; i < 300; i++) {
      const x = (Math.random() * cfg.mapWidth) | 0, y = (Math.random() * cfg.mapHeight) | 0;
      if (Game.tile.isEdible(w.terrain[y * cfg.mapWidth + x])) Game.state.entities.spawn(0, x + 0.5, y + 0.5, 0.7);
    }
    for (let tk = 0; tk < 200; tk++) for (const sy of Game.state.engine.systems) if (sy.tick) sy.tick(Game.state.world);
    let osum = 0; for (let i = 0; i < w.owner.length; i++) osum += w.owner[i];
    const before = { kingdoms: civ.kingdoms.length, pop: civ.stats().population, live: Game.state.entities.live, seed: cfg.seed, osum: osum };
    const json = JSON.stringify(Game.persistence.serialize());
    Game.regenerate();
    Game.persistence.deserialize(JSON.parse(json));
    const w2 = Game.state.world; let osum2 = 0; for (let i = 0; i < w2.owner.length; i++) osum2 += w2.owner[i];
    let partnerOk = true;
    for (const p of civ.people) { if (p._partnerPid !== undefined) partnerOk = false; if (p.partner && (typeof p.partner !== "object" || !p.partner.pid)) partnerOk = false; }
    const after = { kingdoms: civ.kingdoms.length, pop: civ.stats().population, live: Game.state.entities.live, seed: cfg.seed, osum: osum2 };
    return { before, after, jsonLen: json.length, partnerOk };
  });
  assert.ok(res.before.kingdoms >= 2, "建国できていない: " + res.before.kingdoms);
  assert.equal(res.after.kingdoms, res.before.kingdoms, "復元後の国数が一致");
  assert.equal(res.after.pop, res.before.pop, "復元後の人口が一致");
  assert.equal(res.after.live, res.before.live, "復元後の生物数が一致");
  assert.equal(res.after.seed, res.before.seed, "seedが一致");
  assert.equal(res.after.osum, res.before.osum, "領有が一致");
  assert.ok(res.partnerOk, "参照(partner)が復元されていない");
  assert.ok(res.jsonLen > 100, "スナップショットが空");
  assert.deepEqual(errors, [], "実行時エラー: " + errors.join("\n"));
  await page.close();
});
