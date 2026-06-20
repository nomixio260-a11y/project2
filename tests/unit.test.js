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

test("FireSystem: 可燃地形のみ着火し、延焼して焼け地になる", () => {
  const Game = loadCore({ mapWidth: 20, mapHeight: 20 });
  const w = new Game.World(20, 20);
  w.terrain.fill(Game.TERRAIN.FOREST);
  const fire = new Game.FireSystem(w, { markDirty() {} });

  // 水には着火しない。
  w.setTerrain(2, 2, Game.TERRAIN.DEEP_WATER);
  assert.equal(fire.ignite(2, 2), false, "水に着火してはいけない");
  // 森には着火する。
  assert.equal(fire.ignite(10, 10), true);
  assert.equal(fire.active.length, 1);

  // 多数ティックで燃え広がり、やがて焼け地が現れる。
  let scorched = 0;
  for (let t = 0; t < 60; t++) fire.tick(w);
  for (let i = 0; i < w.terrain.length; i++) {
    if (w.terrain[i] === Game.TERRAIN.SCORCHED) scorched++;
  }
  assert.ok(scorched > 0, "焼け地が発生していない");
});

test("FireSystem: 水を越えて延焼しない", () => {
  const Game = loadCore({ mapWidth: 5, mapHeight: 1 });
  const w = new Game.World(5, 1);
  // [森][水][森][森][森] → 左の森に着火しても水を越えない。
  w.terrain.set([
    Game.TERRAIN.FOREST,
    Game.TERRAIN.DEEP_WATER,
    Game.TERRAIN.FOREST,
    Game.TERRAIN.FOREST,
    Game.TERRAIN.FOREST,
  ]);
  const fire = new Game.FireSystem(w, { markDirty() {} });
  fire.ignite(0, 0);
  for (let t = 0; t < 80; t++) fire.tick(w);
  // 右側3つの森は燃えず残る（水で遮断）。
  assert.equal(w.getTerrain(2, 0), Game.TERRAIN.FOREST);
  assert.equal(w.getTerrain(3, 0), Game.TERRAIN.FOREST);
  assert.equal(w.getTerrain(4, 0), Game.TERRAIN.FOREST);
});

test("FireSystem: active 集合が maxFires を超えない", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 40 });
  Game.config.sim.maxFires = 50;
  const w = new Game.World(40, 40);
  w.terrain.fill(Game.TERRAIN.JUNGLE);
  const fire = new Game.FireSystem(w, { markDirty() {} });
  fire.ignite(20, 20);
  for (let t = 0; t < 100; t++) {
    fire.tick(w);
    assert.ok(fire.active.length <= 50, "maxFires超過: " + fire.active.length);
  }
});

test("CivSystem: 建国で入植者が生まれ、歩いた陸地が領土になる（水は不可）", () => {
  const Game = loadCore({ mapWidth: 30, mapHeight: 30 });
  const w = new Game.World(30, 30);
  w.terrain.fill(Game.TERRAIN.GRASS);
  // 一部を海にして、領土が陸地に限られることを確認。
  for (let y = 0; y < 30; y++) w.setTerrain(15, y, Game.TERRAIN.DEEP_WATER);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });

  // 水には建国できない。
  assert.equal(civ.foundAt(15, 5), -1, "水に建国してはいけない");
  // 陸地に建国 → 入植者が湧く。
  const id = civ.foundAt(5, 5);
  assert.ok(id > 0, "建国できていない");
  assert.equal(w.getOwner(5, 5), id);
  assert.ok(civ.people.length >= 1, "入植者が生成されていない");

  const t0 = civ.kingdoms[id].tileCount;
  for (let t = 0; t < 120; t++) civ.tick(w);
  assert.ok(civ.kingdoms[id].tileCount > t0, "人間が歩いても領土が増えない");
  // 海(x=15列)は決して領有されない。
  for (let y = 0; y < 30; y++) {
    assert.equal(w.getOwner(15, y), 0, "海を領有してしまった");
  }
});

test("CivSystem: 王国数は maxKingdoms を超えない", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 40 });
  Game.config.sim.maxKingdoms = 5;
  const w = new Game.World(40, 40);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  let founded = 0;
  for (let i = 0; i < 20; i++) {
    if (civ.foundAt(i, 0) > 0) founded++;
  }
  assert.ok(founded <= 5, "maxKingdoms超過: " + founded);
  assert.equal(civ.kingdoms.length - 1, founded);
});

test("CivSystem: 二国の入植者が広がり、やがて大半の土地が領有される", () => {
  const Game = loadCore({ mapWidth: 24, mapHeight: 16 });
  const w = new Game.World(24, 16);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const a = civ.foundAt(3, 8);
  const b = civ.foundAt(20, 8);
  for (let t = 0; t < 700; t++) civ.tick(w);
  const ka = civ.kingdoms[a];
  const kb = civ.kingdoms[b];
  assert.ok(ka.tileCount > 20 && kb.tileCount > 20, "両国が十分広がっていない: " + ka.tileCount + "/" + kb.tileCount);
  let owned = 0;
  for (let i = 0; i < w.owner.length; i++) if (w.owner[i] !== 0) owned++;
  assert.ok(owned > w.owner.length * 0.4, "領土が広がっていない: " + owned);
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

test("ClimateSystem: ティックで日・季節・年が進む", () => {
  const Game = loadCore();
  const clim = new Game.ClimateSystem();
  const cfg = Game.config.sim;
  // 1日 = ticksPerDay ティック。1季節 = daysPerSeason 日。
  const ticksPerYear = cfg.ticksPerDay * cfg.daysPerSeason * 4;
  for (let i = 0; i < ticksPerYear; i++) clim.tick();
  const clk = Game.state.clock;
  assert.equal(clk.year, 2, "1年経過で year=2");
  assert.equal(clk.seasonIndex, 0, "1年後は春に戻る");
  assert.ok(clk.season && clk.season.name === "春");
});

test("ClimateSystem: 季節が春→夏→秋→冬と巡る", () => {
  const Game = loadCore();
  const clim = new Game.ClimateSystem();
  const perSeason = Game.config.sim.ticksPerDay * Game.config.sim.daysPerSeason;
  const seen = [];
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < perSeason; i++) clim.tick();
    seen.push(Game.state.clock.seasonIndex);
  }
  // 各季節末で index が 1,2,3,0 を踏む。
  assert.deepEqual(seen, [1, 2, 3, 0]);
});

test("lighting: 正午は明るく深夜は暗い、朝夕は暖色", () => {
  const Game = loadCore();
  const per = Game.config.sim.ticksPerDay;
  // 正午(tod≈0.5)。
  const noon = Game.lighting({ tick: Math.round(per * 0.5) });
  assert.ok(noon.darkness < 0.02, "正午は暗くない: " + noon.darkness);
  // 深夜(tod≈0)。
  const midnight = Game.lighting({ tick: 0 });
  assert.ok(midnight.darkness > 0.4, "深夜は暗い: " + midnight.darkness);
  // 日の出(tod≈0.25)は暖色(twilight)が立つ。
  const dawn = Game.lighting({ tick: Math.round(per * 0.25) });
  assert.ok(dawn.twilight > 0.4, "朝は暖色: " + dawn.twilight);
  assert.ok(dawn.darkness < 0.05, "朝は明るい寄り: " + dawn.darkness);
});

test("CivSystem: 人間が自律的に動き、王国の消滅で人も消える", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 40 });
  const w = new Game.World(40, 40);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const id = civ.foundAt(20, 20);
  assert.ok(civ.people.length > 0, "入植者がいない");
  // 位置を記録し、ティックで実際に移動することを確認。
  const before = civ.people.map((p) => p.x + "," + p.y);
  for (let t = 0; t < 30; t++) civ.tick(w);
  let moved = 0;
  for (let i = 0; i < Math.min(before.length, civ.people.length); i++) {
    if (civ.people[i].x + "," + civ.people[i].y !== before[i]) moved++;
  }
  assert.ok(moved > 0, "人間が動いていない");
  // すべて当該王国所属で、マップ内。
  for (const p of civ.people) {
    assert.equal(p.kid, id);
    assert.ok(p.x >= 0 && p.x < 40 && p.y >= 0 && p.y < 40, "範囲外の人間");
  }
  // 王国が滅べば人も消える。
  civ.kingdoms[id].alive = false;
  for (let t = 0; t < 5; t++) civ.tick(w);
  assert.equal(civ.people.length, 0, "滅亡後も人が残る");
});

test("VegetationSystem: 焼け地が再成長して草原に回復する", () => {
  const Game = loadCore({ mapWidth: 20, mapHeight: 20 });
  const w = new Game.World(20, 20);
  w.terrain.fill(Game.TERRAIN.SCORCHED);
  w.moisture.fill(0.6);
  w.temperature.fill(0.5);
  const veg = new Game.VegetationSystem(w, { markDirty() {} });
  veg.seed(w);
  Game.state.clock.season = Game.SEASONS[1]; // 夏（成長旺盛）
  // 十分な回数ティック（バンドが全面を何周もする）。
  for (let t = 0; t < 200; t++) veg.tick(w);
  let grass = 0;
  for (let i = 0; i < w.terrain.length; i++) {
    if (w.terrain[i] === Game.TERRAIN.GRASS || w.terrain[i] === Game.TERRAIN.FOREST) grass++;
  }
  assert.ok(grass > w.terrain.length * 0.5, "焼け地が回復していない: " + grass);
});

test("VegetationSystem: graze で fertility が減り、空なら 0 を返す", () => {
  const Game = loadCore({ mapWidth: 8, mapHeight: 8 });
  const w = new Game.World(8, 8);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const veg = new Game.VegetationSystem(w, { markDirty() {} });
  veg.seed(w);
  const i = 3 * 8 + 3;
  const before = w.fertility[i];
  const eaten = veg.graze(i);
  assert.ok(eaten > 0, "採食量が正");
  assert.ok(w.fertility[i] < before, "fertility が減る");
  // 枯らし切ると 0 を返す。
  for (let k = 0; k < 50; k++) veg.graze(i);
  assert.equal(veg.graze(i), 0, "枯渇時は 0");
});

test("CivSystem: 確保した土地に応じて人口が増え、stats を集計できる", () => {
  const Game = loadCore({ mapWidth: 60, mapHeight: 60 });
  const w = new Game.World(60, 60);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const id = civ.foundAt(30, 30);
  const k = civ.kingdoms[id];
  assert.ok(k.name && k.name.length > 0, "王国名が付く");
  assert.equal(k.cities.length, 1, "首都が1つ");
  assert.ok(k.cities[0].capital, "首都フラグ");
  const pop0 = k.humanCount; // = popStart
  // 領土が十分広がるまで動かすと、容量が増え人口も増える。
  for (let t = 0; t < 900; t++) civ.tick(w);
  assert.ok(k.tileCount > 100, "領土が広がっていない: " + k.tileCount);
  assert.ok(k.humanCount > pop0, "人口が増えていない: " + k.humanCount);
  const s = civ.stats();
  assert.equal(s.kingdoms, 1);
  assert.equal(s.population, k.humanCount, "総人口=人間数");
  assert.equal(s.cities, k.cities.length);
});

test("godpowers: 災害・生態ツールが登録されている", () => {
  const Game = loadCore();
  for (const id of ["earthquake", "meteor", "flood", "plague", "fertilize"]) {
    assert.ok(Game.godpowers.get(id), "ツール未登録: " + id);
  }
  // disaster グループに分類されている。
  assert.equal(Game.godpowers.get("meteor").group, "disaster");
  assert.equal(Game.godpowers.get("fertilize").group, "life");
});

test("Hud.sample: 個体数・王国・延焼を集計する", () => {
  const Game = loadCore({ mapWidth: 20, mapHeight: 20 });
  const S = Game.SPECIES;

  // 生物: 草食2・肉食1、1体は kill 済みで除外される。
  const e = new Game.Entities(10);
  e.spawn(S.HERBIVORE, 1, 1);
  e.spawn(S.HERBIVORE, 2, 2);
  e.spawn(S.PREDATOR, 3, 3);
  const dead = e.spawn(S.HERBIVORE, 4, 4);
  e.kill(dead);

  // 王国: 2国、うち1国は滅亡（alive=false）。
  const w = new Game.World(20, 20);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const a = civ.foundAt(2, 2);
  const b = civ.foundAt(15, 2);
  civ.kingdoms[b].alive = false;

  // 炎: 2タイル着火。
  const fire = new Game.FireSystem(w, { markDirty() {} });
  fire.ignite(5, 5);
  fire.ignite(6, 5);

  Game.state.entities = e;
  Game.state.civ = civ;
  Game.state.fire = fire;

  const s = Game.hud.sample();
  assert.equal(s.herb, 2, "草食数");
  assert.equal(s.pred, 1, "肉食数");
  assert.equal(s.pop, 3, "総個体数");
  assert.equal(s.kingdoms, 1, "生存王国数");
  assert.equal(s.fires, 2, "延焼数");
});
