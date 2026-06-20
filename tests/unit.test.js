// コアロジックのユニットテスト（DOM不要）。`node --test tests/unit.test.js`
const { test } = require("node:test");
const assert = require("node:assert");
const { loadCore } = require("./load-core");

test("utils: clamp / lerp / mapRange / smoothstep", () => {
  const Game = loadCore();
  const u = Game.utils;
  assert.equal(u.clamp(5, 0, 3), 3);
  assert.equal(u.clamp(-1, 0, 3), 0);
  assert.equal(u.clamp(2, 0, 3), 2);
  assert.equal(u.lerp(0, 10, 0.5), 5);
  assert.equal(u.mapRange(5, 0, 10, 0, 100), 50);
  assert.equal(u.smoothstep(0, 1, 0), 0);
  assert.equal(u.smoothstep(0, 1, 1), 1);
});

test("mulberry32: 決定的で再現性がある", () => {
  const Game = loadCore();
  const a = Game.utils.mulberry32(42);
  const b = Game.utils.mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test("noise: simplex2D は概ね [-1,1] に収まる", () => {
  const Game = loadCore();
  const n = new Game.Noise(123);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 5000; i++) {
    const v = n.simplex2D(i * 0.137, (i % 71) * 0.291);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert.ok(min >= -1.001 && min < 0, "min=" + min);
  assert.ok(max <= 1.001 && max > 0, "max=" + max);
});

test("noise: fbm は 0..1 を返す", () => {
  const Game = loadCore();
  const n = new Game.Noise(7);
  for (let i = 0; i < 1000; i++) {
    const v = n.fbm(i * 0.05, i * 0.03, { octaves: 5, frequency: 1.5, lacunarity: 2, gain: 0.5 });
    assert.ok(v >= 0 && v <= 1, "fbm out of range: " + v);
  }
});

test("noise: 同じシードは同じ結果、別シードは別結果", () => {
  const Game = loadCore();
  const a = new Game.Noise(99);
  const b = new Game.Noise(99);
  const c = new Game.Noise(100);
  assert.equal(a.simplex2D(1.5, 2.5), b.simplex2D(1.5, 2.5));
  assert.notEqual(a.simplex2D(1.5, 2.5), c.simplex2D(1.5, 2.5));
});

test("tile.classify: 標高で正しく地形が決まる（温帯）", () => {
  const Game = loadCore();
  const T = Game.TERRAIN;
  const TEMPERATE = 0.5;
  assert.equal(Game.tile.classify(0.0, 0.5, TEMPERATE), T.DEEP_WATER);
  assert.equal(Game.tile.classify(0.35, 0.5, TEMPERATE), T.SHALLOW_WATER);
  assert.equal(Game.tile.classify(0.42, 0.5, TEMPERATE), T.SAND);
  assert.equal(Game.tile.classify(0.95, 0.5, TEMPERATE), T.SNOW);
  // grass帯: 温帯では湿度で grass/forest 分岐
  const mid = (Game.config.thresholds.sand + Game.config.thresholds.grass) / 2;
  assert.equal(Game.tile.classify(mid, 0.0, TEMPERATE), T.GRASS);
  assert.equal(Game.tile.classify(mid, 0.6, TEMPERATE), T.FOREST);
  // 温度省略時は温帯(0.5)扱い → 旧2引数互換
  assert.equal(Game.tile.classify(mid, 0.0), T.GRASS);
  assert.equal(Game.tile.classify(mid, 0.6), T.FOREST);
});

test("tile.classify: 温度でバイオームが分岐する", () => {
  const Game = loadCore();
  const T = Game.TERRAIN;
  const th = Game.config.thresholds;
  const mid = (th.sand + th.grass) / 2;
  // 高温・乾燥 → 砂漠 / 高温・多湿 → ジャングル / 高温・中間 → サバンナ
  assert.equal(Game.tile.classify(mid, 0.1, 0.9), T.DESERT);
  assert.equal(Game.tile.classify(mid, 0.9, 0.9), T.JUNGLE);
  assert.equal(Game.tile.classify(mid, 0.5, 0.9), T.SAVANNA);
  // 寒冷 → ツンドラ
  assert.equal(Game.tile.classify(mid, 0.5, 0.1), T.TUNDRA);
  // 温帯・多湿・低地 → 湿地
  const low = (th.sand + th.swampElevation) / 2;
  assert.equal(Game.tile.classify(low, 0.9, 0.5), T.SWAMP);
});

test("World: get/set/raise が境界クランプ込みで動く", () => {
  const Game = loadCore();
  const w = new Game.World(10, 8);
  assert.equal(w.width, 10);
  assert.equal(w.inBounds(9, 7), true);
  assert.equal(w.inBounds(10, 7), false);
  assert.equal(w.inBounds(-1, 0), false);

  w.setElevation(3, 3, 0.5);
  assert.equal(w.getElevation(3, 3), 0.5);
  // raise はクランプされる
  assert.equal(w.raise(3, 3, 1.0), 1.0);
  assert.equal(w.raise(3, 3, -5.0), 0.0);

  w.setTerrain(3, 3, Game.TERRAIN.FOREST);
  assert.equal(w.getTerrain(3, 3), Game.TERRAIN.FOREST);
});

test("worldgen: 生成すると複数の地形タイプが現れる", () => {
  const Game = loadCore({ mapWidth: 96, mapHeight: 96 });
  const w = new Game.World(96, 96);
  Game.worldgen.generate(w, 2024);
  const seen = new Set();
  for (let i = 0; i < w.terrain.length; i++) seen.add(w.terrain[i]);
  // 海と陸が最低限あること
  assert.ok(seen.size >= 4, "種類が少なすぎ: " + seen.size);
  assert.ok(seen.has(Game.TERRAIN.DEEP_WATER), "深海が無い");
  // 標高・温度は全タイル 0..1
  for (let i = 0; i < w.elevation.length; i++) {
    assert.ok(w.elevation[i] >= 0 && w.elevation[i] <= 1);
    assert.ok(w.temperature[i] >= 0 && w.temperature[i] <= 1, "temp out of range");
  }
});

test("worldgen: 川(carveRivers)はシードで再現的", () => {
  const Game = loadCore({ mapWidth: 96, mapHeight: 96 });
  const a = new Game.World(96, 96);
  const b = new Game.World(96, 96);
  const c = new Game.World(96, 96);
  Game.worldgen.generate(a, 31337);
  Game.worldgen.generate(b, 31337);
  Game.worldgen.generate(c, 31338);
  // 同一シードは温度も地形(川含む)も完全一致。
  assert.deepEqual(Array.from(a.terrain), Array.from(b.terrain));
  assert.deepEqual(Array.from(a.temperature), Array.from(b.temperature));
  assert.notDeepEqual(Array.from(a.terrain), Array.from(c.terrain));
});

test("worldgen: 同じシードは同一マップ、別シードは別マップ", () => {
  const Game = loadCore({ mapWidth: 64, mapHeight: 64 });
  const a = new Game.World(64, 64);
  const b = new Game.World(64, 64);
  const c = new Game.World(64, 64);
  Game.worldgen.generate(a, 555);
  Game.worldgen.generate(b, 555);
  Game.worldgen.generate(c, 556);
  assert.deepEqual(Array.from(a.terrain), Array.from(b.terrain));
  assert.notDeepEqual(Array.from(a.terrain), Array.from(c.terrain));
});

test("Entities: spawn/kill が free-list で再利用される", () => {
  const Game = loadCore();
  const e = new Game.Entities(3);
  const a = e.spawn(0, 1, 1);
  const b = e.spawn(0, 2, 2);
  const c = e.spawn(1, 3, 3);
  assert.equal(e.live, 3);
  assert.equal(e.spawn(0, 4, 4), -1, "上限超過は -1");
  e.kill(b);
  assert.equal(e.live, 2);
  assert.equal(e.alive[b], 0);
  // 解放スロットを再利用する。
  const d = e.spawn(1, 5, 5);
  assert.equal(d, b, "解放スロットを再利用");
  assert.equal(e.live, 3);
  // clear で全消去。
  e.clear();
  assert.equal(e.live, 0);
  assert.equal(e.count, 0);
});

test("CreatureSystem: 採食でエネルギーが増え、餓死で死ぬ", () => {
  const Game = loadCore({ mapWidth: 16, mapHeight: 16 });
  const w = new Game.World(16, 16);
  // 全面を草原にして温度・標高も埋める。
  w.terrain.fill(Game.TERRAIN.GRASS);
  w.elevation.fill(0.5);
  const ent = new Game.Entities(50);
  const stubRenderer = { markDirty: function () {} };
  const sys = new Game.CreatureSystem(ent, w, stubRenderer);

  // 草原上の草食はエネルギーが回復していく。
  const h = ent.spawn(Game.SPECIES.HERBIVORE, 8, 8, 0.3);
  const before = ent.energy[h];
  sys.tick(w);
  assert.ok(ent.energy[h] > before, "草上で採食して増える");

  // エネルギー0の個体は死ぬ。
  const starving = ent.spawn(Game.SPECIES.HERBIVORE, 4, 4, 0.005);
  // 草上だと回復するので、代謝だけで枯れるよう水面に置く想定の代わりに
  // 直接 energy を負へ近づけてからtick。
  ent.energy[starving] = 0.001;
  w.setTerrain(4, 4, Game.TERRAIN.SAND); // 採食できない地形
  sys.tick(w);
  assert.equal(ent.alive[starving], 0, "餓死で kill");
});

test("CreatureSystem: 上限を超えて繁殖しない", () => {
  const Game = loadCore({ mapWidth: 8, mapHeight: 8 });
  Game.config.sim.maxEntities = 6;
  const w = new Game.World(8, 8);
  w.terrain.fill(Game.TERRAIN.GRASS);
  w.elevation.fill(0.5);
  const ent = new Game.Entities(6);
  const sys = new Game.CreatureSystem(ent, w, { markDirty() {} });
  for (let i = 0; i < 6; i++) ent.spawn(Game.SPECIES.HERBIVORE, 4, 4, 1);
  for (let t = 0; t < 30; t++) sys.tick(w);
  assert.ok(ent.live <= 6, "maxEntities を超えない: " + ent.live);
});

test("Camera: screenToWorld と worldToScreen は逆変換", () => {
  const Game = loadCore();
  const cam = new Game.Camera(800, 600);
  cam.x = 120;
  cam.y = 80;
  cam.zoom = 2;
  const sx = 345;
  const sy = 210;
  const wx = cam.screenToWorldX(sx);
  const wy = cam.screenToWorldY(sy);
  assert.ok(Math.abs(cam.worldToScreenX(wx) - sx) < 1e-6);
  assert.ok(Math.abs(cam.worldToScreenY(wy) - sy) < 1e-6);
});

test("Camera: zoomAt はカーソル下のワールド点を保つ", () => {
  const Game = loadCore({ mapWidth: 512, mapHeight: 512, tilePx: 8 });
  const cam = new Game.Camera(800, 600);
  cam.x = 100;
  cam.y = 100;
  cam.zoom = 1;
  const sx = 400;
  const sy = 300;
  const beforeWX = cam.screenToWorldX(sx);
  const beforeWY = cam.screenToWorldY(sy);
  cam.zoomAt(sx, sy, 1.5);
  const afterWX = cam.screenToWorldX(sx);
  const afterWY = cam.screenToWorldY(sy);
  // クランプの影響が出ない中央付近なので不変のはず
  assert.ok(Math.abs(beforeWX - afterWX) < 0.5, "wx drift " + (beforeWX - afterWX));
  assert.ok(Math.abs(beforeWY - afterWY) < 0.5, "wy drift " + (beforeWY - afterWY));
});

test("Camera: zoom は min/max にクランプされる", () => {
  const Game = loadCore();
  const cam = new Game.Camera(800, 600);
  for (let i = 0; i < 100; i++) cam.zoomAt(400, 300, 2);
  assert.ok(cam.zoom <= Game.config.maxZoom + 1e-9);
  for (let i = 0; i < 100; i++) cam.zoomAt(400, 300, 0.5);
  assert.ok(cam.zoom >= Game.config.minZoom - 1e-9);
});

test("Camera: visibleTileRange はマップ範囲内に収まる", () => {
  const Game = loadCore({ mapWidth: 200, mapHeight: 150, tilePx: 8 });
  const cam = new Game.Camera(800, 600);
  cam.fitToMap();
  const r = cam.visibleTileRange();
  assert.ok(r.x0 >= 0 && r.y0 >= 0);
  assert.ok(r.x1 <= 200 && r.y1 <= 150);
  assert.ok(r.x1 >= r.x0 && r.y1 >= r.y0);
});
