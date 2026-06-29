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

test("CreatureSystem: 飽食した捕食者は狩らない（捕食の安定化）", () => {
  const Game = loadCore({ mapWidth: 16, mapHeight: 16 });
  const w = new Game.World(16, 16);
  w.terrain.fill(Game.TERRAIN.GRASS);
  w.elevation.fill(0.5);
  const ent = new Game.Entities(50);
  const sys = new Game.CreatureSystem(ent, w, { markDirty: function () {} });
  const P = Game.CreatureSystem.P;

  // 満腹（satiation 超）の捕食者は隣の獲物に手を出さない。
  const prey = ent.spawn(Game.SPECIES.HERBIVORE, 8, 8, 0.6);
  const fullPred = ent.spawn(Game.SPECIES.PREDATOR, 8.2, 8, 1.0);
  ent.energy[fullPred] = 1.0; // > P.satiation
  for (let t = 0; t < 5; t++) sys.tick(w);
  assert.equal(ent.alive[prey], 1, "飽食した捕食者は獲物を狩らない");

  // 空腹の捕食者は、いずれ獲物を仕留める（狩り成功は確率的なので多ティック観測）。
  const preys = [];
  for (let i = 0; i < 8; i++) preys.push(ent.spawn(Game.SPECIES.HERBIVORE, 4 + (i % 3) * 0.3, 4, 0.6));
  const hungry = ent.spawn(Game.SPECIES.PREDATOR, 4.1, 4, 0.5);
  ent.energy[hungry] = 0.5; // < P.satiation → 狩る
  let killed = false;
  for (let t = 0; t < 400 && !killed; t++) {
    ent.energy[hungry] = 0.5; // 飢餓死を防ぎ「狩れるか」のみを検証（狩り成功は確率的）
    sys.tick(w);
    for (const pi of preys) if (!ent.alive[pi]) killed = true;
  }
  assert.ok(killed, "空腹の捕食者は獲物を狩れる");
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

test("CivSystem: 言語が創発し、国ごとに分かれ通じ合いが変わる", () => {
  const Game = loadCore({ mapWidth: 60, mapHeight: 20, seed: 4242 });
  const w = new Game.World(60, 20);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const A = civ.foundAt(5, 10);
  const B = civ.foundAt(50, 10);
  assert.ok(A > 0 && B > 0, "建国できていない");

  // 建国者は言葉(lx,ly)を持つ。
  const pa = civ.people.find((p) => p.kid === A);
  assert.ok(pa && pa.lx != null && pa.ly != null, "人が言語を持たない");
  // 建国者の言葉は自国の言語の近傍にある（個体差 langJitter の範囲内）。
  const ka = civ.kingdoms[A];
  assert.ok(Math.abs(pa.lx - ka.langX) <= 0.1 && Math.abs(pa.ly - ka.langY) <= 0.1, "建国者の言葉が国の言語から離れすぎ");

  for (let t = 0; t < 200; t++) civ.tick(w);

  // 別々に興った国は異なる言語を持つ（langName が文字列で返る）。
  const nameA = civ.langNameOf(civ.kingdoms[A]);
  const nameB = civ.langNameOf(civ.kingdoms[B]);
  assert.equal(typeof nameA, "string");
  assert.ok(nameA.length > 0 && nameB.length > 0, "言語名が空");
  // 相互理解度は 0..1 に収まり、同一国内(自分自身)は最大1。
  const mi = civ.langMI(civ.kingdoms[A], civ.kingdoms[B]);
  assert.ok(mi >= 0 && mi <= 1, "相互理解度が範囲外");
  assert.equal(civ.langMI(civ.kingdoms[A], civ.kingdoms[A]), 1, "自国とは完全に通じるはず");
  // 人の言葉の名も得られる。
  const someone = civ.people.find((p) => p.lx != null);
  assert.equal(typeof civ.personLangName(someone), "string");

  // 言語ビューの色と凡例が得られる（描画・UI 用）。
  Game.state = Game.state || {};
  Game.state.mapView = "language";
  const col = civ.viewColorOf(A);
  assert.ok(Array.isArray(col) && col.length === 3, "言語ビュー色が不正");
  assert.ok(civ.viewLegend("language").length > 0, "言語凡例が空");
});

test("CivSystem: 金鉱石を集計し、鋳貨を得た国が貨幣を鋳造する", () => {
  const Game = loadCore({ mapWidth: 30, mapHeight: 30 });
  const w = new Game.World(30, 30);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const A = civ.foundAt(5, 5);
  assert.ok(A > 0);
  const k = civ.kingdoms[A];

  // 領内に金鉱石タイルを置く（worldgen を介さず直接）。
  w.resource[5 * 30 + 5] = Game.RESOURCE.GOLD;
  w.resourceList = [{ x: 5, y: 5, t: Game.RESOURCE.GOLD }];

  // 集計で金が国に計上される。
  civ._tallyResources();
  assert.ok(k.res.gold >= 1, "金鉱石が集計されていない");

  // 鋳貨技術が無いうちは物々交換（coin は増えない）。
  k.tech = 0; k.techBits = {};
  const coin0 = k.coin || 0;
  for (let t = 0; t < 50; t++) civ.tick(w);
  assert.ok((k.coin || 0) <= coin0 + 0.01, "鋳貨が無いのに貨幣が増えた");

  // 鋳貨技術を与えると、金鉱石から貨幣を鋳造し始める。
  k.techBits.coin = true;
  for (let t = 0; t < 300; t++) civ.tick(w);
  assert.ok(k.coin > 0, "鋳貨を得ても貨幣が鋳造されない");

  // 文明・時代が合わなくても貨幣は使える: 金鉱石が無くても、交易が盛んなら外国の
  // 貨幣が流通して貨幣を使える（商業を通じた貨幣の流入）。
  k.res.gold = 0; w.resource[5 * 30 + 5] = 0; w.resourceList = [];
  k.coin = 0; k.tradeVol = 50; // 活発な交易（外国貨幣の流入源）
  for (let t = 0; t < 200; t++) { k.tradeVol = 50; civ.tick(w); }
  assert.ok(k.coin > 0, "金鉱が無くても交易で貨幣が流通するはず");
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

test("CivSystem: 交易で双方が富み、余剰国から飢饉国へ食料が流れる", () => {
  const Game = loadCore({ mapWidth: 30, mapHeight: 30 });
  const w = new Game.World(30, 30);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const a = civ.foundAt(5, 5);
  const b = civ.foundAt(20, 5);
  const ka = civ.kingdoms[a], kb = civ.kingdoms[b];
  // 隣国として接触させる（平和・交易路あり）。
  ka.borders[b] = 0; kb.borders[a] = 0;
  // 比較優位: 産物を相補的に（a は鉱石、b は漁場）。
  ka.res = { ore: 10, fish: 0, gems: 0 };
  kb.res = { ore: 0, fish: 10, gems: 0 };
  ka.humanCount = 20; kb.humanCount = 20;

  const wa0 = ka.wealth, wb0 = kb.wealth;
  const traded = civ._trade(a, b, ka, kb);
  assert.ok(traded, "交易が成立しない");
  assert.ok(ka.wealth > wa0 && kb.wealth > wb0, "交易で双方が富まない（比較優位の利益）");
  assert.ok(ka.partners && ka.partners[b] > 0, "交易相手が記録されない");

  // 交易路の無い遠国（隣接せず・非同盟・航海術なし）とは交易できない。
  const c = civ.foundAt(28, 28);
  const kc = civ.kingdoms[c];
  assert.equal(civ._tradeRoute(a, c, ka, kc), null, "交易路が無いのに通商してしまう");

  // 食料: a に余剰・b は飢饉。交易で食料が b へ流れ、対価の富が a へ向かう。
  ka.food = 40; kb.food = 0; kb.famine = true; kb.wealth = 100;
  const fa0 = ka.food, fb0 = kb.food, wkb0 = kb.wealth, wka0 = ka.wealth;
  civ._trade(a, b, ka, kb);
  assert.ok(kb.food > fb0, "飢饉国へ食料が流れない");
  assert.ok(ka.food < fa0, "余剰国の食料が減らない");
  assert.ok(kb.wealth < wkb0 && ka.wealth > wka0, "食料の対価（富）が動かない");
});

test("CivSystem: 放浪者(人間)が集まって自ら国を興す", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 40 });
  const w = new Game.World(40, 40);
  w.terrain.fill(Game.TERRAIN.GRASS);
  w.fertility.fill(0.8);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  // 人間を一箇所に多めに撒く（国はまだ無い）。
  for (let n = 0; n < 12; n++) civ.spawnNomad(20 + ((n % 4) - 2), 20 + (((n / 4) | 0) - 1));
  assert.equal(civ.kingdoms.length - 1, 0, "最初は国が無い");
  assert.ok(civ.stats().nomads >= 10, "放浪者がいる");
  // しばらく動かすと、集団が建国する。
  let founded = false;
  for (let t = 0; t < 600 && !founded; t++) {
    civ.tick(w);
    if (civ.kingdoms.length - 1 > 0) founded = true;
  }
  assert.ok(founded, "放浪者が国を興さなかった");
  // 建国後は市民(人口)が存在する。
  assert.ok(civ.stats().population > 0, "市民がいない");
});

test("CivSystem: 他国領は歩いただけでは奪われない（兵士の前線のみ）", () => {
  const Game = loadCore({ mapWidth: 30, mapHeight: 30 });
  const w = new Game.World(30, 30);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  // 王国Aの領土を一帯に確保。
  const A = civ.foundAt(5, 15);
  // 王国Bの市民を1人、Aの真ん中に強制的に置く（歩いて侵入した想定）。
  const B = civ.foundAt(25, 15);
  // Bの全市民を非兵士(開拓者)にし、Aの領土の中心へワープ。
  const owner0 = w.getOwner(5, 15);
  assert.ok(owner0 === A);
  for (const p of civ.people) {
    if (p.kid === B) { p.role = Game.ROLE.EXPLORER; p.x = 6.5; p.y = 15.5; }
  }
  // Aタイル(5,15)を含む周辺がAのまま保たれる（非兵士は奪わない）。
  for (let t = 0; t < 60; t++) civ.tick(w);
  // (5,15) は決してBにならない（兵士でない侵入者は領土を奪えない）。
  assert.notEqual(w.getOwner(5, 15), B, "歩いただけで他国領が奪われた");
});

test("CivSystem: 外交（接触→開戦→講和→同盟）と getNations", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 40 });
  const w = new Game.World(40, 40);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const A = civ.foundAt(5, 5);
  const B = civ.foundAt(30, 5);

  // 接触で関係が生まれる。
  civ._contact(A, B);
  assert.notEqual(civ.kingdoms[A].relations[B], undefined, "接触で関係が生まれない");

  // 開戦は双方向。
  civ._declareWar(A, B);
  assert.ok(civ._atWar(A, B) && civ._atWar(B, A), "開戦が双方向でない");
  const nA = civ.getNations().find(function (n) { return n.id === A; });
  assert.ok(nA.wars.indexOf(civ.kingdoms[B].name) >= 0, "交戦相手が一覧に出ない");
  assert.ok(nA.ruler && nA.gov, "統治者/政体が無い");

  // 講和で戦争解除。
  civ._makePeace(A, B);
  assert.ok(!civ._atWar(A, B) && !civ._atWar(B, A), "講和できていない");

  // 同盟で戦争は無く、同盟一覧に出る。
  civ._formAlliance(A, B);
  assert.ok(!civ._atWar(A, B), "同盟したのに交戦中");
  const nA2 = civ.getNations().find(function (n) { return n.id === A; });
  assert.ok(nA2.allies.indexOf(civ.kingdoms[B].name) >= 0, "同盟国が一覧に出ない");
});

test("CivSystem: 技術が進歩し時代が進む / 宗教・時代が getNations に出る", () => {
  const Game = loadCore({ mapWidth: 30, mapHeight: 30 });
  const w = new Game.World(30, 30);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const id = civ.foundAt(15, 15);
  const k = civ.kingdoms[id];
  assert.ok(k.religion, "宗教が無い");
  assert.equal(k.tech, 0, "初期技術は0");
  // 外交評価を繰り返すと技術が伸びる。
  for (let t = 0; t < 30; t++) civ._diplomacy();
  assert.ok(k.tech > 0, "技術が進歩していない");
  const n = civ.getNations().find(function (x) { return x.id === id; });
  assert.ok(n.era && n.era.length > 0, "時代が出ない");
  assert.equal(n.religion, k.religion, "宗教が一致しない");
});

test("CivSystem: 軍事力・同盟参戦・講和", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 40 });
  const w = new Game.World(40, 40);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const A = civ.foundAt(8, 8);
  const B = civ.foundAt(20, 8);
  const C = civ.foundAt(32, 8);
  // 軍事力: 兵士が多いほど強い。
  civ.kingdoms[A].roleCount[Game.ROLE.SOLDIER] = 10;
  civ.kingdoms[B].roleCount[Game.ROLE.SOLDIER] = 1;
  assert.ok(civ._military(civ.kingdoms[A]) > civ._military(civ.kingdoms[B]), "軍事力が兵士数を反映しない");

  // A と C は同盟。A が B に宣戦 → 同盟国 C も B と交戦（呼びかけ）。
  civ._contact(A, B); civ._contact(A, C); civ._contact(B, C);
  civ._formAlliance(A, C);
  civ._declareWar(A, B);
  assert.ok(civ._atWar(A, B), "A-B が交戦していない");
  assert.ok(civ._atWar(C, B), "同盟国Cが参戦していない");

  // 講和で解除。
  civ._makePeace(A, B);
  assert.ok(!civ._atWar(A, B), "講和できていない");
});

test("CivSystem: 指導者の性格・富・交易・反乱", () => {
  const Game = loadCore({ mapWidth: 60, mapHeight: 60 });
  const w = new Game.World(60, 60);
  w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  const A = civ.foundAt(15, 30);
  const B = civ.foundAt(45, 30);
  const ka = civ.kingdoms[A];
  assert.ok(ka.trait && ka.trait.name, "指導者の性格が無い");
  assert.equal(ka.wealth, 0, "初期の富は0");
  // 領土を与えて外交評価 → 富が蓄積する。
  ka.tileCount = 200; civ.kingdoms[B].tileCount = 200;
  civ._contact(A, B); // 交易相手として認知
  for (let t = 0; t < 20; t++) civ._diplomacy();
  assert.ok(ka.wealth > 0, "富が蓄積していない");
  const n = civ.getNations().find(function (x) { return x.id === A; });
  assert.ok(n.trait && typeof n.wealth === "number" && typeof n.unrest === "number", "getNationsに社会指標が無い");

  // 反乱: 2都市・高い不満 → 地方が独立して国が増える。
  const before = civ.getNations().length;
  ka.cities.push({ x: 22, y: 30, capital: false, level: 1 });
  // 22,30 周辺をAの領土に。
  for (let y = 25; y <= 35; y++) for (let x = 18; x <= 26; x++) w.owner[y * 60 + x] = A;
  ka.unrest = 100;
  civ._rebellion(ka);
  assert.ok(civ.getNations().length > before, "反乱で国家が増えていない");
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

test("CivSystem: 人間が自律的に動き、王国の消滅で住民は難民化する", () => {
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
  for (const p of civ.people) {
    assert.equal(p.kid, id);
    assert.ok(p.x >= 0 && p.x < 40 && p.y >= 0 && p.y < 40, "範囲外の人間");
  }
  // 王国が滅んでも住民は死なず、難民(無所属)として生き延びる。
  const pop = civ.people.length;
  civ.kingdoms[id].alive = false;
  for (let t = 0; t < 5; t++) civ.tick(w);
  assert.ok(civ.people.length >= pop - 2, "難民が消えてしまった");
  for (const p of civ.people) {
    assert.equal(p.kid, 0, "滅亡国の住民が市民のまま残っている");
  }
});

test("WeatherSystem: 雨が湿度と植生を潤す", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 40 });
  const w = new Game.World(40, 40);
  w.terrain.fill(Game.TERRAIN.GRASS);
  w.moisture.fill(0);
  w.fertility.fill(0);
  const weather = new Game.WeatherSystem(w, null);
  // 中央に停止した大きな雲を1つだけ置く。
  weather.clouds = [{ x: 20, y: 20, vx: 0, vy: 0, r: 12 }];
  for (let t = 0; t < 200; t++) weather.tick(w);
  // 雲の下の領域で湿度・植生が上がっている。
  let wet = 0, fert = 0;
  for (let y = 12; y < 28; y++) {
    for (let x = 12; x < 28; x++) {
      const i = y * 40 + x;
      if (w.moisture[i] > 0) wet++;
      if (w.fertility[i] > 0) fert++;
    }
  }
  assert.ok(wet > 20, "雨で湿度が上がっていない: " + wet);
  assert.ok(fert > 20, "雨で植生が回復していない: " + fert);
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

test("DisasterSystem: 干ばつ・地震・洪水が被害を与える", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 40, seed: 13 });
  const w = new Game.World(40, 40);
  w.terrain.fill(Game.TERRAIN.GRASS);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 4; x++) w.setTerrain(x, y, Game.TERRAIN.MOUNTAIN);
  for (let y = 0; y < 40; y++) w.setTerrain(15, y, Game.TERRAIN.SHALLOW_WATER); // 陸に挟まれた浅瀬列
  if (w.fertility) w.fertility.fill(1);
  if (w.moisture) w.moisture.fill(0.1);

  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  Game.state = Game.state || {};
  Game.state.civ = civ;
  Game.state.clock = { warmth: 0, wetness: 0, season: { name: "夏" } };

  const A = civ.foundAt(25, 20);
  const k = civ.kingdoms[A];
  k.cities[0].buildings = [
    { x: 25, y: 20, t: 3 }, // KEEP（砦）
    { x: 26, y: 20, t: 5 }, { x: 27, y: 20, t: 6 }, { x: 25, y: 21, t: 7 },
  ];
  for (let t = 0; t < 60; t++) civ.tick(w);

  const ds = new Game.DisasterSystem(w);

  // 干ばつ: 肥沃度の帯が半減する。
  let before = 0; for (let i = 0; i < w.fertility.length; i++) before += w.fertility[i];
  ds._drought(w);
  let after = 0; for (let i = 0; i < w.fertility.length; i++) after += w.fertility[i];
  assert.ok(after < before, "干ばつで肥沃度が減るはず");

  // 地震: 砦以外の建物が倒壊し、不満が上がる。
  const bCount = k.cities[0].buildings.length;
  const u0 = k.unrest || 0;
  ds._earthquake(w);
  assert.ok(k.cities[0].buildings.length < bCount, "地震で建物が倒壊するはず");
  assert.ok((k.unrest || 0) > u0, "地震で不満が上がるはず");
  assert.ok(k.cities[0].buildings.some((b) => b.t === 3), "砦(KEEP)は倒壊しないはず");

  // 洪水: 浅瀬付近の陸地の湿度が上がる。
  ds._flood(w);
  let wet = 0;
  for (let i = 0; i < w.moisture.length; i++) if (w.moisture[i] > 0.1 && Game.tile.isLand(w.terrain[i])) wet++;
  assert.ok(wet > 0, "洪水で湿った陸地が生じるはず");
});

test("CivSystem: 信仰が育ち結束を生む / 宗派も地図色を持つ", () => {
  const Game = loadCore({ mapWidth: 30, mapHeight: 30 });
  const w = new Game.World(30, 30); w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  Game.state = Game.state || {}; Game.state.civ = civ;
  const A = civ.foundAt(15, 15);
  const k = civ.kingdoms[A];
  const f0 = k.faith;
  // 神殿(TEMPLE=4)を備える → 信仰が育つはず。
  k.cities[0].buildings.push({ x: 15, y: 15, t: 4 }, { x: 16, y: 15, t: 4 }, { x: 14, y: 15, t: 4 }, { x: 15, y: 16, t: 4 });
  for (let t = 0; t < 600; t++) civ.tick(w);
  assert.ok(k.faith >= 0 && k.faith <= 1, "信仰は0..1の範囲");
  assert.ok(k.faith > f0, "神殿で信仰が育つはず: " + k.faith);
  // 宗派(派生宗教)も宗教ビューで色を持つ（クラッシュしない）。
  Game.state.mapView = "religion";
  k.religion = "太陽信仰・異端";
  const col = civ.viewColorOf(A);
  assert.ok(Array.isArray(col) && col.length === 3, "宗派の地図色が得られる");
});

test("CivSystem: クラフトは金属の有無で質が変わる（工芸システム）", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 20 });
  const w = new Game.World(40, 20);
  w.terrain.fill(Game.TERRAIN.GRASS);
  w.elevation.fill(0.5);
  if (w.fertility) w.fertility.fill(0.7);
  // 左側に鉱石（金属あり）、右側は草原のみ（金属なし）。
  for (let y = 4; y < 16; y++) for (let x = 2; x < 8; x++) w.setTerrain(x, y, Game.TERRAIN.HILL);
  w.resource = new Uint8Array(40 * 20);
  const rl = [];
  for (let y = 5; y < 15; y += 2) for (let x = 3; x < 7; x += 2) { w.resource[y * 40 + x] = Game.RESOURCE.ORE; rl.push({ x: x, y: y, t: Game.RESOURCE.ORE }); }
  w.resourceList = rl;

  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  Game.state = Game.state || {}; Game.state.civ = civ;
  const A = civ.foundAt(5, 10);   // 鉱石地帯
  const B = civ.foundAt(34, 10);  // 草原のみ
  const ka = civ.kingdoms[A], kb = civ.kingdoms[B];
  // 両国とも鉄器時代相当へ（材料が許せば高い段階を作れる状況）。
  ka.tech = kb.tech = 200; ka.techBits.iron = kb.techBits.iron = true;

  for (let t = 0; t < 500; t++) civ.tick(w);

  // 鉱石地帯は金属を扱え、craftTier が高い。草原のみは石器どまり。
  const ciA = civ.craftInfo(ka), ciB = civ.craftInfo(kb);
  assert.ok(ka.res.ore > 0, "鉱石地帯に鉱石があるはず");
  assert.equal(kb.res.ore, 0, "草原国に鉱石は無いはず");
  assert.ok(ciA.tier >= 2, "金属のある国は金属装備を作れるはず: " + ciA.tier);
  assert.equal(ciB.tier, 1, "金属の無い国は石器どまりのはず: " + ciB.tier);
  // 工芸力は金属＋鍛冶のある国の方が高い。
  assert.ok((ka.craft || 0) > (kb.craft || 0), "鉱石地帯の方が工芸力が高いはず");
  // craftInfo は名前と段階を返す。
  assert.equal(typeof ciA.name, "string");
  assert.ok(civ.gearName(6).length > 0, "装備名が得られる");
});

test("CivSystem: 鉄の製錬には燃料(森)が要る（冶金の連鎖）", () => {
  const Game = loadCore({ mapWidth: 50, mapHeight: 20 });
  const w = new Game.World(50, 20);
  w.terrain.fill(Game.TERRAIN.GRASS); w.elevation.fill(0.5);
  if (w.fertility) w.fertility.fill(0.7);
  if (w.moisture) w.moisture.fill(0.7);
  w.resource = new Uint8Array(50 * 20);
  const rl = [];
  // A 地域: 鉱石＋森（鉄・鋼が作れる）。
  for (let y = 4; y < 16; y++) for (let x = 2; x < 10; x++) w.setTerrain(x, y, x < 5 ? Game.TERRAIN.HILL : Game.TERRAIN.FOREST);
  for (let y = 5; y < 15; y += 2) for (let x = 2; x < 5; x++) { w.resource[y * 50 + x] = Game.RESOURCE.ORE; rl.push({ x: x, y: y, t: Game.RESOURCE.ORE }); }
  // B 地域: 鉱石のみ（森が無い → 青銅どまり）。
  for (let y = 4; y < 16; y++) for (let x = 40; x < 48; x++) w.setTerrain(x, y, Game.TERRAIN.HILL);
  for (let y = 5; y < 15; y += 2) for (let x = 40; x < 43; x++) { w.resource[y * 50 + x] = Game.RESOURCE.ORE; rl.push({ x: x, y: y, t: Game.RESOURCE.ORE }); }
  w.resourceList = rl;

  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  Game.state = Game.state || {}; Game.state.civ = civ;
  const A = civ.foundAt(4, 10), B = civ.foundAt(44, 10);
  const ka = civ.kingdoms[A], kb = civ.kingdoms[B];
  ka.tech = kb.tech = 260; // 鉄器時代相当（青銅・鉄は評価で自動獲得）

  for (let t = 0; t < 400; t++) civ.tick(w);

  assert.ok(ka.fuel > 0, "森のある国は燃料(森)を持つはず");
  assert.equal(kb.fuel, 0, "森の無い国は燃料ゼロのはず");
  const ciA = civ.craftInfo(ka), ciB = civ.craftInfo(kb);
  assert.ok(ciA.tier >= 3, "鉱石＋燃料＋鉄器技術 → 鉄器以上のはず: " + ciA.tier);
  assert.equal(ciB.tier, 2, "鉱石はあるが燃料が無い → 青銅どまりのはず: " + ciB.tier);
});

test("CivSystem: 生物群系の資源が集計され軍事に効く（馬＝騎兵ほか）", () => {
  const Game = loadCore({ mapWidth: 30, mapHeight: 20 });
  const w = new Game.World(30, 20);
  w.terrain.fill(Game.TERRAIN.GRASS); w.elevation.fill(0.5);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {} });
  Game.state = Game.state || {}; Game.state.civ = civ;
  const A = civ.foundAt(15, 10);
  const k = civ.kingdoms[A];

  // 首都タイル（建国時に領有）に複数の新資源を置く。
  w.resource = new Uint8Array(30 * 20);
  const rl = [];
  function put(x, y, t) { w.resource[y * 30 + x] = t; rl.push({ x: x, y: y, t: t }); }
  put(15, 10, Game.RESOURCE.HORSES);
  put(15, 10, Game.RESOURCE.HORSES); // 同タイルは1つだが、別タイルも owned 化のため首都中心のみで検証
  w.resourceList = [{ x: 15, y: 10, t: Game.RESOURCE.HORSES }];
  civ._tallyResources();
  assert.ok(k.res.horses >= 1, "馬が集計されるはず");

  // 馬（騎兵）があると軍事力が上がる。
  // （_military はティック内でメモ化されるため、評価ごとに _tickN を進めて再計算させる）
  k.res.horses = 8;
  civ._tickN = (civ._tickN || 0) + 1;
  const milWith = civ._military(k);
  k.res.horses = 0;
  civ._tickN = (civ._tickN || 0) + 1;
  const milNo = civ._military(k);
  assert.ok(milWith > milNo, "馬(騎兵)で軍事力が増すはず");

  // 資源名テーブルが揃っている。
  assert.equal(Game.RESOURCE_NAMES[Game.RESOURCE.SPICE], "香辛料");
  assert.equal(Game.RESOURCE_NAMES[Game.RESOURCE.SALT], "塩");
  assert.equal(Game.RESOURCE_NAMES[Game.RESOURCE.TIMBER], "良材");
});

test("worldgen: 生物群系ごとの資源（馬・良材など）が配置される", () => {
  const Game = loadCore({ mapWidth: 200, mapHeight: 150 });
  const w = new Game.World(200, 150);
  Game.worldgen.generate(w, 4242);
  const kinds = new Set();
  for (const r of w.resourceList) kinds.add(r.t);
  // 鉱石/漁場に加え、草原・森由来の資源（馬・良材）も現れる。
  assert.ok(kinds.has(Game.RESOURCE.HORSES) || kinds.has(Game.RESOURCE.TIMBER), "生物群系資源が配置されていない");
  // 同一シードで再現的。
  const w2 = new Game.World(200, 150);
  Game.worldgen.generate(w2, 4242);
  assert.equal(w.resourceList.length, w2.resourceList.length, "資源配置がシードで再現的でない");
});

test("CivSystem: 黄金/暗黒時代は強制ではなく実測の活力(fortune)から創発する", () => {
  // 既定シードは乱数依存なので、再現性のためシードを固定する。
  const Game = loadCore({ mapWidth: 64, mapHeight: 64, seed: 20260628 });
  const w = new Game.World(64, 64);
  Game.worldgen.generate(w, 7);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {}, markDirty() {} });
  const A = civ.foundAt(20, 20);
  assert.ok(A >= 0, "建国できるはず");
  const k = civ.kingdoms[A];

  // 繁栄・安定・平和・名君を実測値として与え、評価を重ねると活力が上がり黄金時代を「認識」する。
  let recognizedGolden = false;
  const origLog = civ._logEvent.bind(civ);
  civ._logEvent = (m) => { if (m.indexOf("黄金時代を迎えた") >= 0) recognizedGolden = true; return origLog(m); };
  for (let t = 0; t < 1200; t++) {
    k.wealth = Math.max(k.wealth, k.tileCount * 1.2 + 200);
    k.unrest = 4;
    if (k.rulerRef) { k.rulerRef.wit = 1.4; k.rulerRef.dili = 1.4; k.rulerRef.alive = true; }
    civ.tick(w);
  }
  assert.equal(typeof k.fortune, "number", "活力(fortune)が算出されているはず");
  assert.ok(k.fortune > 0.5, "繁栄・安定が続けば活力は高いはず: " + k.fortune);
  assert.ok(recognizedGolden && k.goldenAge, "繁栄が続けば黄金時代が認識されるはず");

  // 産出に黄金時代の人為補正がかかっていないこと: 旧来の強制倍率フィールドは存在しない。
  // 活力は記述（年代記/UI）に用いられるのみで、富・技術は既存の因果系がそのまま生み出す。
  assert.equal(k.goldenAge, 1, "黄金時代フラグは記述的な真偽(1)であるべき");

  // 危機（戦乱・不満・暗君）が続けば活力は下がり、黄金時代は自然に去る。
  for (let t = 0; t < 1500; t++) {
    k.wealth = 0; k.unrest = 95;
    if (k.rulerRef) { k.rulerRef.wit = 0.6; k.rulerRef.dili = 0.6; }
    civ.tick(w);
  }
  assert.ok(k.fortune < 0.5, "危機が続けば活力は下がるはず: " + k.fortune);
  assert.ok(!k.goldenAge, "活力が下がれば黄金時代は自然に終わるはず");
});

test("CivSystem: 創造システム — 人の閃きが文明を内側から進め、創造性は遺伝・淘汰される", () => {
  // 既定シードは乱数依存なので、再現性のためシードを固定する。
  const Game = loadCore({ mapWidth: 48, mapHeight: 48, seed: 20260628 });
  const w = new Game.World(48, 48);
  Game.worldgen.generate(w, 11);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {}, markDirty() {} });
  const A = civ.foundAt(24, 24);
  assert.ok(A >= 0, "建国できるはず");
  const k = civ.kingdoms[A];

  // 「創造」の志が新設され公開されている。
  assert.equal(civ.aspireName(5), "創造");

  // 生まれた人には創造性(creat)が授けられている。
  const h = civ.people.find((p) => p.kid === A);
  assert.equal(typeof h.creat, "number", "創造性が授けられているはず");

  // 高い創造力の大人が閃きを重ねると、国の知(insight)と本人の名声が育ち、
  //   やがて画期的発明か不朽の傑作が現れる（系の強制ではなく人から湧く）。
  h.age = 900; h.creat = 1.35; h.wit = 1.3; h.skill = 0.9; h.mood = 0.95; h.food = 0.95; h.aspire = 5;
  const p0 = h.prestige || 0;
  let creations = 0;
  const orig = civ._logEvent.bind(civ);
  civ._logEvent = (m) => { if (m.indexOf("生み出した") >= 0 || m.indexOf("傑作") >= 0) creations++; return orig(m); };
  for (let i = 0; i < 20000; i++) civ._invent(h, k, 2);
  assert.ok((k.insight || 0) > 0, "閃きが国の知を蓄積するはず: " + (k.insight || 0));
  assert.ok((h.prestige || 0) > p0, "創造は名声を高めるはず");
  assert.ok(creations > 0, "繰り返せば発明・傑作が歴史に刻まれるはず");
  assert.ok((h.invention || h.masterwork), "創造者にその産物が記録されるはず");

  // 強化＝創造が分野ごとの永続的な「強み」(革新)として国に根づく。
  assert.ok(k.innov && k.innov.some((v) => v > 0), "革新が分野水準として蓄積されるはず");

  // より広く＝革新は接触する文明へ伝播する（知は世界へ広がる）。
  w.terrain[10 * 48 + 10] = Game.TERRAIN.GRASS; // 建国地を確実に陸地に
  const B = civ.foundAt(10, 10);
  assert.ok(B >= 0, "二国目を建国できるはず");
  const kb = civ.kingdoms[B];
  kb.innov = [0, 0, 0, 0, 0, 0];
  k.innov = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8]; // 先進国
  // 接触（交易相手）として扱わせ、文化交流で伝播させる。
  k.partners = {}; k.partners[B] = 5; kb.partners = {}; kb.partners[A] = 5;
  for (let t = 0; t < 8; t++) civ._culturalExchange(A, B, k, kb);
  assert.ok(kb.innov.some((v) => v > 0.01), "革新が接触相手へ伝播するはず: " + kb.innov.join(","));

  // 蓄積された知は技術へ転化される（成長ループを跨ぐ）。
  const t0 = k.tech;
  k.insight = (k.insight || 0) + 5;
  for (let t = 0; t < 200; t++) civ.tick(w);
  assert.ok(k.tech > t0, "蓄積された知が技術へ転化されるはず");

  // 創造性は遺伝する: 創造力の高い親同士からは創造的な子が生まれやすい（自律進化の土台）。
  const pa = { creat: 1.3 }, pb = { creat: 1.3 };
  let sum = 0, n = 0;
  for (let i = 0; i < 50; i++) {
    const c = civ._spawnHuman(k, 24, 24, h.clan, 0, 0.7, pa, pb);
    if (c) { sum += c.creat; n++; }
  }
  assert.ok(n > 0 && sum / n > 1.05, "高創造の親からは創造性の高い子が生まれやすいはず: " + (sum / n));
});

test("VegetationSystem: 水循環 — 湿度は蒸発で乾き、水辺で潤い、基準へ均衡する", () => {
  const Game = loadCore({ mapWidth: 20, mapHeight: 20 });
  const w = new Game.World(20, 20);
  w.terrain.fill(Game.TERRAIN.GRASS);
  // 中央に水たまり（染み出しの源）。
  w.setTerrain(10, 10, Game.TERRAIN.SHALLOW_WATER);
  w.temperature.fill(0.8); // 高温＝蒸発が強い
  w.moisture.fill(0.9);    // 飽和状態から始める
  Game.state.clock = { warmth: 0, wetness: 0, season: Game.SEASONS[1] }; // 夏

  const veg = new Game.VegetationSystem(w, null);
  veg.seed(w); // moistureBase を生成時の湿度(0.9)で固定
  // 乾いた気候の基準にするため moistureBase を下げ、蒸発で乾くことを見る。
  w.moistureBase.fill(0.4);

  // 乾いた内陸タイル（水から離れた所）。
  const dryIdx = 2 * 20 + 2;
  const m0 = w.moisture[dryIdx];
  // 全帯を処理するのに十分な回数だけ tick（bandRows で分割走査されるため）。
  for (let t = 0; t < 40; t++) veg.tick(w);
  assert.ok(w.moisture[dryIdx] < m0, "高温・低基準では蒸発で湿度が下がるはず: " + w.moisture[dryIdx] + " < " + m0);
  assert.ok(w.moisture[dryIdx] > 0.2, "基準(0.4)付近へ均衡し、ゼロまで干上がらないはず: " + w.moisture[dryIdx]);

  // 水辺に隣接するタイルは染み出しで潤いを保つ（seepMoisture 以上）。
  const nearWaterIdx = 10 * 20 + 9; // (9,10) は水(10,10)の隣
  assert.ok(w.moisture[nearWaterIdx] >= Game.config.sim.seepMoisture - 0.05,
    "水辺は染み出しで潤うはず: " + w.moisture[nearWaterIdx]);
});

test("DisasterSystem: 干ばつは湿度を奪い、洪水は低地を伝って広がる（物理的）", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 40, seed: 99 });
  const w = new Game.World(40, 40);
  w.terrain.fill(Game.TERRAIN.GRASS);
  w.moisture.fill(0.7);
  if (w.fertility) w.fertility.fill(0.8);
  Game.state = Game.state || {};
  Game.state.clock = { warmth: 0, wetness: 0, season: { name: "夏" } };
  const ds = new Game.DisasterSystem(w);

  // 干ばつ: 湿度の総量が減る（物理的な乾燥）。
  let mBefore = 0; for (let i = 0; i < w.moisture.length; i++) mBefore += w.moisture[i];
  ds._drought(w);
  let mAfter = 0; for (let i = 0; i < w.moisture.length; i++) mAfter += w.moisture[i];
  assert.ok(mAfter < mBefore, "干ばつで湿度が奪われるはず: " + mAfter + " < " + mBefore);

  // 洪水: 起点から低地（同標高の連続した陸）へ広がり、複数タイルが冠水する。
  // 平地(elevation 0)なので増水位以下が連続して広がる。
  w.setTerrain(20, 20, Game.TERRAIN.SHALLOW_WATER);
  let wetBefore = 0; for (let i = 0; i < w.moisture.length; i++) if (w.moisture[i] > 0.95) wetBefore++;
  ds._flood(w, 20, 20);
  let wetAfter = 0; for (let i = 0; i < w.moisture.length; i++) if (w.moisture[i] > 0.95) wetAfter++;
  assert.ok(wetAfter > wetBefore, "洪水で冠水した（高湿度の）陸地が増えるはず: " + wetAfter);
});

test("CivSystem: 建物は段階(lvl)で育ち、状態(cond)で傷み・直る、荒廃で倒壊する", () => {
  const Game = loadCore({ mapWidth: 40, mapHeight: 40, seed: 555 });
  const w = new Game.World(40, 40); w.terrain.fill(Game.TERRAIN.GRASS);
  const civ = new Game.CivSystem(w, { markTerritoryDirty() {}, markDirty() {} });
  Game.state = Game.state || {}; Game.state.civ = civ;
  const A = civ.foundAt(20, 20);
  const k = civ.kingdoms[A];
  const ROLE = Game.ROLE;

  // 新築の建物は段階1・状態1（基準＝従来どおりの寄与）。
  const keep = k.cities[0].buildings[0];
  assert.equal(keep.lvl || 1, 1, "新築は段階1");
  assert.equal(keep.cond == null ? 1 : keep.cond, 1, "新築は状態1");

  // 機能建築（鍛冶場）を1棟置く。重み集計では新築1棟＝ちょうど1.0。
  k.cities[0].buildings.push({ x: 21, y: 20, t: 6, lvl: 1, cond: 1 });
  civ._recountFacilities(k);
  assert.ok(Math.abs(k.facilities.smithy - 1) < 1e-6, "新築の鍛冶場は重み1.0: " + k.facilities.smithy);

  // 普請で段階が育つ（古典期＝era2 以上で lvl2 可）。技術を与えて格上げ。
  k.tech = (Game.TECH_PER_ERA || 1000) * 2.5;
  const smithy = k.cities[0].buildings[1];
  const upgraded = civ._upgrade(k, k.cities[0]);
  assert.ok(upgraded, "格上げできるはず");
  assert.ok((smithy.lvl || 1) >= 2, "鍛冶場の段階が上がるはず: " + smithy.lvl);
  civ._recountFacilities(k);
  assert.ok(k.facilities.smithy > 1.2, "育った鍛冶場は重みが増す: " + k.facilities.smithy);

  // 戦時は建物が傷む（状態が下がる）。
  smithy.cond = 1;
  k.wars = { 99: 0 };                 // 交戦中
  k.wealth = 0; k.roleCount[ROLE.BUILDER] = 0; // 直す地力なし
  for (let i = 0; i < 5; i++) civ._maintain(k);
  assert.ok(smithy.cond < 0.95, "戦時に建物が傷むはず: " + smithy.cond);

  // 平時で富と建築家があれば直る（状態が1へ回復する）。
  k.wars = {};
  k.wealth = 5000; k.roleCount[ROLE.BUILDER] = 20;
  const before = smithy.cond;
  for (let i = 0; i < 10; i++) civ._maintain(k);
  assert.ok(smithy.cond > before, "平時に建物が直るはず: " + smithy.cond + " > " + before);

  // 荒廃しきった建物は倒壊して取り除かれる（砦＝核は残る）。
  k.cities[0].buildings.push({ x: 19, y: 20, t: 7, lvl: 1, cond: 0.01 });
  const n0 = k.cities[0].buildings.length;
  let collapsed = false;
  for (let i = 0; i < 40 && !collapsed; i++) {
    k.wars = { 99: 0 }; k.wealth = 0; k.roleCount[ROLE.BUILDER] = 0;
    civ._maintain(k);
    if (k.cities[0].buildings.length < n0) collapsed = true;
  }
  assert.ok(collapsed, "荒廃した建物は倒壊するはず");
  assert.ok(k.cities[0].buildings.some((b) => b.t === 3), "砦(KEEP)は倒壊しない");
});
