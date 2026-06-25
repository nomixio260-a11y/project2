// 文明シミュレーション（人間主導 / エージェントAI + 社会システム）。
//
// 各人間は「AI を積んだ自律エージェント」:
//  - 欲求: 空腹(food)・社交(social)・加齢(age)を持ち、優先度で行動を決める。
//  - 職業(role): 開拓者/農民/建築家/兵士。役割ごとに目的地と振る舞いが異なる。
//  - 社会関係: 氏族(clan=血統)と王国(in-group)で結びつき、同胞の近くに集う。
//    ペア（成人2人）で子をなし家族が増える。他王国は敵(out-group)で兵士が戦う。
// 領土・人口・都市・食料は、これら人間の行動から創発する（抽象的な自動拡張は無い）。
//
// 効率化:
//  - 近傍探索は一様グリッド（毎ティック1回構築）で O(1) 近傍に。
//  - 重い思考(_think)は thinkInterval ティックに1回だけ（人ごとに位相をずらす）。
//    移動・採食・領有といった軽い処理のみ毎ティック。
//  - 死亡は dead フラグ→末尾コンパクションでまとめ処理（途中 swap を避ける）。
(function (Game) {
  "use strict";

  const tile = Game.tile;

  // 職業（役割）。0-3 は従来互換、4-6 は専門職（工房・市場・神殿で働く）。
  const ROLE = { EXPLORER: 0, FARMER: 1, BUILDER: 2, SOLDIER: 3, SMITH: 4, MERCHANT: 5, PRIEST: 6 };
  const ROLE_COUNT = 7;
  // 建物タイプ（描画 sprites.building と対応）。
  // 0=小屋,1=家,2=邸宅,3=砦,4=神殿,5=農場,6=鍛冶場,7=市場,8=兵舎,9=穀倉,10=鉱山。
  const BUILDING = { HUT: 0, HOUSE: 1, MANOR: 2, KEEP: 3, TEMPLE: 4, FARM: 5, SMITHY: 6, MARKET: 7, BARRACKS: 8, GRANARY: 9, MINE: 10 };
  const MAX_BUILDINGS = 22; // 1都市の建物上限
  // 生産施設（住居・砦以外の機能建築）。役割の職場になる。
  const FACILITY_KEYS = ["temple", "farm", "smithy", "market", "barracks", "granary"];

  // 時代に応じた住居の種別（石器=小屋 / 青銅・鉄=家 / 古典以降=邸宅）。
  function dwellingTier(tech) {
    const era = (tech / TECH_PER_ERA) | 0;
    if (era <= 0) return BUILDING.HUT;
    if (era <= 2) return BUILDING.HOUSE;
    return BUILDING.MANOR;
  }

  // 時代に応じた装備の段階（0=無し,1=石器,2=青銅,3=鉄,4=鋼…）。
  function gearTier(tech) {
    return Math.min(5, 1 + ((tech / TECH_PER_ERA) | 0));
  }

  const CP = {
    popStart: 5,
    tilesPerHuman: 6,    // 人口容量の分母（確保した土地 / これ）
    baseCap: 10,         // 最低人口容量（建国直後でも成長して開拓者を出せる）
    perKingdomCap: 130,
    speed: 0.22,
    metab: 0.0016,       // 1ティックの食料消費
    eatGain: 0.05,       // 可食地での食料回復
    harvest: 0.05,       // 採食時に減る fertility（あれば）
    adultAge: 200,
    elderAge: 2600,
    maxAge: 3600,
    reproFood: 0.58,     // この食料以上で繁殖可
    reproCost: 0.34,
    reproCooldown: 240,
    reproRadius: 6,
    thinkInterval: 22,   // 重い意思決定の間隔(ティック)。大きいほど低負荷
    joinRadius: 12,      // 放浪者が既存国を見つけて加入を目指す範囲
    tether: 26,          // 開拓者・兵士の行動範囲
    tetherSettled: 13,   // 農民・建築家は自分の町の近くに定住
    seekRange: 3,
    conflictChance: 0.06,
    newTownDist: 18,     // この距離を超える自国領で新集落を興す（支配を延伸）
    foundRate: 0.02,
    maxSettlements: 10,
    controlRadius: 28,   // 都市が支配を及ぼす半径（これを超える辺境は手放す）
    controlPerLevel: 3,  // 都市の発展度1あたりの支配半径の増分
    maintainBand: 32,    // 領土メンテのローリング走査の行数/ティック
    socialRise: 0.003,
    socialRadius: 5,
    socialNeed: 5,       // 周囲の同胞がこれ未満だと孤独
    cultivate: 0.03,     // 農民が高める fertility
    attack: 0.05,        // 兵士が敵に与える食料ダメージ
    cellSize: 6,
    nomadFoundBand: 4,   // 建国に必要な近隣の放浪者数
    nomadFoundChance: 0.04,
    nomadFoundRadius: 6,
    nomadClusterRadius: 8,
    // 外交
    diploInterval: 90,  // 外交を評価する間隔(ティック)
    warThreshold: -50,   // 関係がこれ以下で開戦しうる
    allyThreshold: 60,   // これ以上で同盟しうる
    warChance: 0.35,
    peaceChance: 0.16,
    allyChance: 0.18,
    borderWindow: 400,   // この tick 数以内に接触があれば「隣国」とみなす
    warPressure: 0.55,   // 土地不足の隣国どうしは領土紛争で開戦しやすい
    maxAllies: 3,        // 1国が結べる同盟の上限（同盟の乱立を防ぐ）
    decisiveRatio: 2.3,  // 軍事力比がこれ以上なら決定的（賠償・併合を強いる）
    tributeFrac: 0.45,   // 敗戦国が支払う富の割合
    annexRadius: 18,     // 併合時に割譲される都市周辺の半径
    // 生産・装備（専門職が施設で働いて生み出す）
    workRadius: 3,       // 施設からこの距離以内なら「就労中」
    toolRate: 0.02,      // 鍛冶が1ティックに作る道具・武具
    marketRate: 0.06,    // 商人が1ティックに生む富
    templeCalm: 0.02,    // 神官が1ティックに鎮める不満
    equipChance: 0.08,   // 就労時に在庫から装備を受け取る確率
    // 航海・植民（時代1以降、沿岸の開拓者が海を越えて新天地に植民する）
    embarkChance: 0.16,  // 近くに未開の陸が無い沿岸の開拓者が船出する確率
    sailSpeed: 0.5,      // 航海速度（陸の移動より速い）
    maxSailRange: 40,    // 船出して到達を試みる最大距離
    minSailGap: 6,       // 目的地まで最低この距離（海を隔てた別の陸）
    sailMetab: 0.004,    // 航海中の食料消費（海難のリスク）
    // 疫病（過密・低技術の都市で発生し、隣国へ伝播する）
    plagueChance: 0.05,    // 過密国で外交評価ごとに発生しうる確率
    plagueDuration: 7,     // 外交評価（diploInterval）何回ぶん続くか
    plagueMortality: 0.0006, // 流行中の1ティックあたり病没率
    plagueSpread: 0.25,    // 隣国へ広がる確率
  };

  const RULER_NAMES = ["Alaric", "Brana", "Cedric", "Dara", "Eirik", "Freya", "Galen", "Hilda", "Ivar", "Juno", "Kael", "Lyra", "Magnus", "Nadia", "Osric", "Petra", "Rurik", "Sigrid", "Tarek", "Ulla", "Viktor", "Wrenn"];
  const GOV_TYPES = ["君主制", "共和制", "部族連合", "神権制", "氏族制"];
  // 政体ごとの振る舞い補正（指導者の性格 TRAITS と乗算して用いる）。
  // war=好戦性 ally=同盟志向 trade=交易 tech=技術 unrest=不満の溜まりやすさ
  // faith=布教力 expand=入植・拡張意欲
  const GOV_MODS = [
    { war: 1.2, ally: 1.0, trade: 1.0, tech: 1.0, unrest: 0.85, faith: 1.0, expand: 1.25 }, // 君主制: 中央集権・拡張的
    { war: 0.7, ally: 1.25, trade: 1.4, tech: 1.3, unrest: 1.0, faith: 0.9, expand: 0.9 },  // 共和制: 交易・技術重視
    { war: 1.5, ally: 0.9, trade: 0.8, tech: 0.8, unrest: 1.2, faith: 1.0, expand: 1.1 },   // 部族連合: 好戦・不安定
    { war: 1.0, ally: 1.0, trade: 0.9, tech: 0.85, unrest: 0.8, faith: 1.8, expand: 1.0 },  // 神権制: 信仰・安定
    { war: 1.15, ally: 1.4, trade: 1.0, tech: 0.9, unrest: 1.0, faith: 1.0, expand: 1.05 }, // 氏族制: 血縁同盟
  ];
  const RELIGIONS = ["太陽信仰", "月の教団", "大地母神", "風の精霊", "祖霊崇拝", "星辰教"];
  const ERAS = ["石器時代", "青銅器時代", "鉄器時代", "古典時代", "中世", "啓蒙時代"];
  const TECH_PER_ERA = 60;

  // 指導者の性格（国家の振る舞いを変調する）。
  const TRAITS = [
    { name: "好戦的", war: 1.9, ally: 0.5, trade: 0.8, tech: 1.0, unrest: 1.1, faith: 1.0 },
    { name: "温厚", war: 0.4, ally: 1.8, trade: 1.1, tech: 1.0, unrest: 0.7, faith: 1.0 },
    { name: "商才", war: 0.9, ally: 1.3, trade: 1.9, tech: 1.1, unrest: 0.9, faith: 1.0 },
    { name: "敬虔", war: 0.9, ally: 1.1, trade: 1.0, tech: 0.9, unrest: 0.8, faith: 2.0 },
    { name: "賢明", war: 0.8, ally: 1.2, trade: 1.1, tech: 1.6, unrest: 0.7, faith: 1.0 },
  ];

  function eraOf(tech) {
    let i = (tech / TECH_PER_ERA) | 0;
    if (i >= ERAS.length) i = ERAS.length - 1;
    return ERAS[i];
  }

  function CivSystem(world, renderer) {
    this.world = world;
    this.renderer = renderer;
    this.rand = Game.utils.mulberry32((Game.config.seed ^ 0x5bd1e995) >>> 0);
    this.kingdoms = [null];
    this.people = [];   // 人間エージェント
    this._births = [];  // 当ティックに生まれた子（次ティックから処理）
    this._tickN = 0;
    this._tcursor = 0; // 領土メンテ走査の行カーソル
    this.events = [];  // 年代記（世界の主要な出来事のログ）
    this.marks = [];   // 戦場の痕跡（戦死地点。時間で薄れて消える）
    // 近傍探索グリッド。
    this._cap = Game.config.sim.maxPeople;
    this._next = new Int32Array(this._cap);
    this._head = null;
    this._gw = 0;
    this._gh = 0;
  }

  // 年代記に出来事を記録する（新しいものを末尾に、上限つき）。
  CivSystem.prototype._logEvent = function (text) {
    const clk = Game.state.clock;
    this.events.push({ year: clk ? clk.year : 0, text: text });
    if (this.events.length > 80) this.events.shift();
  };

  // 戦場の痕跡を残す（戦死地点。描画でしばらく赤黒く残り薄れていく）。
  CivSystem.prototype._addMark = function (x, y) {
    const m = this.marks;
    m.push({ x: x, y: y, ttl: 360, life: 360 });
    if (m.length > 240) m.shift();
  };

  // UI 用: 直近の出来事（新しい順）。
  CivSystem.prototype.getEvents = function (n) {
    const out = [];
    const ev = this.events;
    const m = Math.min(n || 12, ev.length);
    for (let i = 0; i < m; i++) out.push(ev[ev.length - 1 - i]);
    return out;
  };

  CivSystem.prototype.setWorld = function (world) {
    this.world = world;
    this.people.length = 0;
    this._births.length = 0;
  };

  CivSystem.prototype.clear = function () {
    this.kingdoms = [null];
    this.people.length = 0;
    this._births.length = 0;
    this.events.length = 0;
    this.marks.length = 0;
    if (this.world) this.world.owner.fill(0);
  };

  CivSystem.prototype.colorOf = function (id) {
    const k = this.kingdoms[id];
    return k ? k.color : null;
  };

  const NAME_A = ["Ar", "Bel", "Cor", "Dra", "El", "Fen", "Gor", "Hal", "Ish", "Kor", "Lor", "Mor", "Nor", "Or", "Per", "Quel", "Rho", "Syl", "Tor", "Ul", "Var", "Wyn", "Xan", "Yor", "Zar"];
  const NAME_B = ["a", "e", "i", "o", "u", "ae", "ia", "or", "en", "an"];
  const NAME_C = ["dor", "gard", "heim", "land", "mar", "nia", "ria", "thal", "vale", "wick", "stead", "moor", "fell", "reach"];
  function makeName(rand) {
    return NAME_A[(rand() * NAME_A.length) | 0] +
      NAME_B[(rand() * NAME_B.length) | 0] +
      NAME_C[(rand() * NAME_C.length) | 0];
  }

  function makeColor(rand) {
    const h = rand() * 360;
    const s = 0.65, l = 0.55;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = l - c / 2;
    return [((r + m) * 255) | 0, ((g + m) * 255) | 0, ((b + m) * 255) | 0];
  }

  // 陸地かつ無所属の (x,y) に新王国レコードを作り、首都タイルを領有する。
  // 成否は王国 k を返す / null。住人の用意は呼び出し側。
  CivSystem.prototype._newKingdom = function (x, y) {
    const world = this.world;
    if (!world.inBounds(x, y)) return null;
    const i = y * world.width + x;
    if (world.owner[i] !== 0) return null;
    if (!tile.isLand(world.terrain[i])) return null;
    if (this.kingdoms.length - 1 >= Game.config.sim.maxKingdoms) return null;

    const id = this.kingdoms.length;
    const govIdx = (this.rand() * GOV_TYPES.length) | 0;
    const k = {
      id: id,
      name: makeName(this.rand),
      ruler: RULER_NAMES[(this.rand() * RULER_NAMES.length) | 0],
      gov: GOV_TYPES[govIdx],
      govMod: GOV_MODS[govIdx], // 政体の振る舞い補正
      color: makeColor(this.rand),
      cities: [{ x: x, y: y, capital: true, level: 1, buildings: [{ x: x, y: y, t: BUILDING.KEEP }] }],
      tileCount: 1,
      humanCount: 0,
      roleCount: [0, 0, 0, 0, 0, 0, 0],
      facilities: { temple: 0, farm: 0, smithy: 0, market: 0, barracks: 0, granary: 0 }, // 機能建築の総数
      tools: 0,      // 道具・武具の備蓄（鍛冶が生産・住民が装備）
      clanSeq: 0,
      relations: {}, // 既知の他国 id → 関係値(-100..100)
      borders: {},   // 隣接した他国 id → 最後に接触した tick（隣国判定）
      wars: {},      // 交戦中の id → 開戦 tick
      allies: {},    // 同盟中の id → true
      tech: 0,       // 技術力（時代の指標）
      religion: RELIGIONS[(this.rand() * RELIGIONS.length) | 0],
      trait: TRAITS[(this.rand() * TRAITS.length) | 0], // 指導者の性格
      wealth: 0,     // 富（交易・領土から蓄積）
      unrest: 0,     // 不満（戦争・過密・貧困で上昇 → 反乱）
      plague: 0,     // 疫病の残り評価回数（>0 で流行中）
      res: { ore: 0, fish: 0, gems: 0 }, // 領有資源（_tallyResources が更新）
      alive: true,
    };
    this.kingdoms.push(k);
    world.owner[i] = id;
    if (this.renderer) this.renderer.markTerritoryDirty(x, y);
    return k;
  };

  // 直接建国（テスト/内部用）。入植者集団も同時に置く。王国IDを返す（失敗時 -1）。
  CivSystem.prototype.foundAt = function (x, y) {
    const k = this._newKingdom(x, y);
    if (!k) return -1;
    const clan = ++k.clanSeq;
    for (let n = 0; n < CP.popStart; n++) {
      const h = this._spawnHuman(k, x + 0.5, y + 0.5, clan, this._assignRole(k), 0.9);
      if (h) this.people.push(h);
    }
    return k.id;
  };

  // 放浪者（無所属の人間, kid=0）を置く。彼らが集まり、やがて国を興す。
  CivSystem.prototype.spawnNomad = function (x, y) {
    const world = this.world;
    if (!world.inBounds(x, y)) return false;
    if (!tile.isLand(world.getTerrain(x, y))) return false;
    if (this.people.length + this._births.length >= Game.config.sim.maxPeople) return false;
    this.people.push({
      x: x + 0.5, y: y + 0.5, hx: 0, hy: 0,
      kid: 0, clan: 0,
      age: 0, food: 0.9,
      role: ROLE.EXPLORER, state: 0,
      gx: x, gy: y, work: null, gear: 0,
      repro: CP.reproCooldown, social: 0, alive: true,
    });
    return true;
  };

  // 王国の現状に応じて職業を割り当てる。食料を支える農民を確保しつつ、
  // 対応施設（鍛冶場・市場・神殿）があれば専門職を、戦時は兵士を多く育てる。
  CivSystem.prototype._assignRole = function (k) {
    const total = k.humanCount + 1;
    if (k.roleCount[ROLE.FARMER] / total < 0.34) return ROLE.FARMER;
    const f = k.facilities || {};
    const atWar = this._count(k.wars) > 0;
    const r = this.rand();
    // 専門職: 職場となる施設があり、まだ足りていなければ就かせる。
    if (f.smithy > 0 && k.roleCount[ROLE.SMITH] < f.smithy * 3 && r < 0.14) return ROLE.SMITH;
    if (f.market > 0 && k.roleCount[ROLE.MERCHANT] < f.market * 3 && r < 0.26) return ROLE.MERCHANT;
    if (f.temple > 0 && k.roleCount[ROLE.PRIEST] < f.temple * 2 && r < 0.34) return ROLE.PRIEST;
    if (atWar) {
      // 動員: 新たに育つ世代の多くが兵士になる。
      if (r < 0.6) return ROLE.SOLDIER;
      if (r < 0.8) return ROLE.EXPLORER;
      return ROLE.BUILDER;
    }
    if (r < 0.55) return ROLE.EXPLORER;
    if (r < 0.72) return ROLE.SOLDIER;
    return ROLE.BUILDER;
  };

  // 全都市の建物から機能建築の数を集計する（建設・占領・反乱で変動するため）。
  CivSystem.prototype._recountFacilities = function (k) {
    const f = k.facilities || (k.facilities = { temple: 0, farm: 0, smithy: 0, market: 0, barracks: 0, granary: 0 });
    f.temple = f.farm = f.smithy = f.market = f.barracks = f.granary = 0;
    for (let c = 0; c < k.cities.length; c++) {
      const bs = k.cities[c].buildings;
      if (!bs) continue;
      for (let i = 0; i < bs.length; i++) {
        switch (bs[i].t) {
          case BUILDING.TEMPLE: f.temple++; break;
          case BUILDING.FARM: f.farm++; break;
          case BUILDING.SMITHY: f.smithy++; break;
          case BUILDING.MARKET: f.market++; break;
          case BUILDING.BARRACKS: f.barracks++; break;
          case BUILDING.GRANARY: f.granary++; break;
        }
      }
    }
  };

  // (x,y) から最も近い type の機能建築の座標を返す（職場探し）。
  CivSystem.prototype._nearestFacility = function (k, x, y, type) {
    let best = null, bd = 1e18;
    for (let c = 0; c < k.cities.length; c++) {
      const bs = k.cities[c].buildings;
      if (!bs) continue;
      for (let i = 0; i < bs.length; i++) {
        if (bs[i].t !== type) continue;
        const dx = bs[i].x - x, dy = bs[i].y - y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = bs[i]; }
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  };

  // 指導者の性格(TRAITS)と政体(GOV_MODS)を合成した実効補正値。
  CivSystem.prototype._eff = function (k, f) {
    const t = k.trait ? (k.trait[f] || 1) : 1;
    const g = k.govMod ? (k.govMod[f] || 1) : 1;
    return t * g;
  };

  // ka が b を「隣国」とみなすか（直近 borderWindow tick 以内に接触）。
  CivSystem.prototype._isNeighbor = function (ka, b) {
    if (!ka.borders) return false;
    const t = ka.borders[b];
    return t !== undefined && (this._tickN - t) <= CP.borderWindow;
  };

  CivSystem.prototype._spawnHuman = function (k, x, y, clan, role, food) {
    if (this.people.length + this._births.length >= Game.config.sim.maxPeople) return null;
    if (k.humanCount >= CP.perKingdomCap) return null;
    const home = this._nearestCity(k, x, y);
    const h = {
      x: x, y: y, hx: 0, hy: 0,
      kid: k.id, clan: clan,
      age: 0, food: food,
      role: role, state: 0,
      gx: x, gy: y,        // 現在の目標タイル
      home: home,          // 所属する町（定住の拠点）
      farm: null,          // 農民の耕作地
      work: null,          // 専門職の職場（施設座標）
      gear: 0,             // 装備・道具の段階（0=素手）
      repro: CP.reproCooldown,
      social: 0,
      alive: true,
    };
    k.humanCount++;
    k.roleCount[role]++;
    return h;
  };

  // 国の人口容量（確保した土地に比例。建国直後でも成長できる下限つき）。
  CivSystem.prototype._capacity = function (k) {
    // 漁場は食料を増やし、扶養できる人口を押し上げる。
    const fishBonus = k.res ? k.res.fish * 4 : 0;
    return Math.min(CP.perKingdomCap, Math.max(CP.baseCap, ((k.tileCount / CP.tilesPerHuman) | 0) + fishBonus));
  };

  // 領有する資源タイルを集計し各国の res（鉱石/漁場/宝石）に反映する。
  // 資源は少数なので resourceList を一巡するだけで全国まとめて数えられる。
  CivSystem.prototype._tallyResources = function () {
    const ks = this.kingdoms, world = this.world;
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id];
      if (!k || !k.alive) continue;
      if (!k.res) k.res = { ore: 0, fish: 0, gems: 0 };
      else { k.res.ore = 0; k.res.fish = 0; k.res.gems = 0; }
    }
    const list = world.resourceList;
    if (!list || !list.length) return;
    const W = world.width, H = world.height, owner = world.owner;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const x = r.x, y = r.y;
      let o = owner[y * W + x];
      // 漁場は水上にあり領有されない → 隣接する自国の陸タイルの所有者に帰属させる。
      if (r.t === 2 && o === 0) {
        if (x > 0 && owner[y * W + x - 1]) o = owner[y * W + x - 1];
        else if (x < W - 1 && owner[y * W + x + 1]) o = owner[y * W + x + 1];
        else if (y > 0 && owner[(y - 1) * W + x]) o = owner[(y - 1) * W + x];
        else if (y < H - 1 && owner[(y + 1) * W + x]) o = owner[(y + 1) * W + x];
      }
      if (o === 0) continue;
      const k = ks[o];
      if (!k || !k.alive || !k.res) continue;
      if (r.t === 1) k.res.ore++;
      else if (r.t === 2) k.res.fish++;
      else k.res.gems++;
    }
  };

  // (x,y) に最も近い k の都市座標 {x,y} を返す。
  CivSystem.prototype._nearestCity = function (k, x, y) {
    let bx = k.cities[0].x, by = k.cities[0].y, bd = 1e9;
    for (let c = 0; c < k.cities.length; c++) {
      const dx = k.cities[c].x - x, dy = k.cities[c].y - y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bx = k.cities[c].x; by = k.cities[c].y; }
    }
    return { x: bx, y: by };
  };

  CivSystem.prototype.stats = function () {
    let kingdoms = 0, population = 0, cities = 0;
    for (let id = 1; id < this.kingdoms.length; id++) {
      const k = this.kingdoms[id];
      if (!k || !k.alive) continue;
      kingdoms++;
      population += k.humanCount;
      cities += k.cities.length;
    }
    // 放浪者（無所属）の数。
    let nomads = 0;
    const people = this.people;
    for (let p = 0; p < people.length; p++) {
      if (people[p].alive && people[p].kid === 0) nomads++;
    }
    return {
      kingdoms: kingdoms, population: population, cities: cities,
      nomads: nomads, total: population + nomads,
    };
  };

  // ===== 近傍グリッド =====
  CivSystem.prototype._buildGrid = function () {
    const W = this.world.width, H = this.world.height;
    const cs = CP.cellSize;
    const gw = Math.ceil(W / cs), gh = Math.ceil(H / cs);
    if (!this._head || this._gw !== gw || this._gh !== gh) {
      this._head = new Int32Array(gw * gh);
      this._gw = gw; this._gh = gh;
    }
    this._head.fill(-1);
    const people = this.people;
    const next = this._next;
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      const cx = (p.x / cs) | 0, cy = (p.y / cs) | 0;
      const c = cy * gw + cx;
      next[i] = this._head[c];
      this._head[c] = i;
    }
  };

  // 半径内で predicate(other) を満たす同胞/敵を数える / 最寄りを返す。
  CivSystem.prototype._scan = function (px, py, radius, want) {
    const cs = CP.cellSize, gw = this._gw, gh = this._gh;
    const r = Math.ceil(radius / cs);
    const cx = (px / cs) | 0, cy = (py / cs) | 0;
    const r2 = radius * radius;
    const people = this.people, next = this._next, head = this._head;
    let count = 0, count2 = 0, best = null, bestD = r2;
    for (let gy = cy - r; gy <= cy + r; gy++) {
      if (gy < 0 || gy >= gh) continue;
      for (let gx = cx - r; gx <= cx + r; gx++) {
        if (gx < 0 || gx >= gw) continue;
        let i = head[gy * gw + gx];
        while (i !== -1) {
          const o = people[i];
          if (o && o.alive) {
            const dx = o.x - px, dy = o.y - py;
            const d = dx * dx + dy * dy;
            if (d <= r2) {
              const m = want(o, d);
              if (m === 1) count++;
              else if (m === 2) { count2++; if (d < bestD) { bestD = d; best = o; } }
            }
          }
          i = next[i];
        }
      }
    }
    return { count: count, count2: count2, best: best };
  };

  CivSystem.prototype.tick = function (world) {
    this._tickN++;
    const tN = this._tickN;
    const people = this.people;
    const kingdoms = this.kingdoms;
    const rand = this.rand;
    // 昼夜の判定（夜は人々が帰宅して休む）。描画の昼夜と同じ周期を tick 数から算出し、
    // 気候時計が進まないヘッドレス環境でも正しく循環する。
    const tpd = (Game.config.sim && Game.config.sim.ticksPerDay) || 0;
    const dnOn = !Game.config.settings || Game.config.settings.dayNight !== false;
    if (tpd > 0 && dnOn) {
      const tod = (tN % tpd) / tpd;
      this._night = Math.sin((tod - 0.25) * Math.PI * 2) < -0.12;
    } else {
      this._night = false;
    }

    this._buildGrid();

    for (let i = 0; i < people.length; i++) {
      const h = people[i];
      if (!h.alive) continue;

      // 放浪者（無所属）: 集まり、やがて国を興す。
      if (h.kid === 0) { this._tickNomad(h, world, tN, i); continue; }

      // 航海中の入植者: 海を渡って新天地を目指す（専用の更新）。
      if (h.sailing) { this._tickSail(h, world); continue; }

      const k = kingdoms[h.kid];
      if (!k || !k.alive) {
        // 国が滅んだ → 難民（流民）として生き延び、別の国へ加入/再建を目指す。
        h.kid = 0; h.role = ROLE.EXPLORER;
        h.home = null; h.farm = null; h.clan = 0;
        continue;
      }

      // ---- 軽量・毎ティック ----
      h.age++;
      h.food -= CP.metab;
      h.social += CP.socialRise;
      if (h.repro > 0) h.repro--;

      const tx = h.x | 0, ty = h.y | 0;
      const ti = ty * world.width + tx;
      const terr = world.terrain[ti];
      // 採食。
      if (tile.isEdible(terr)) {
        let gain = CP.eatGain;
        if (world.fertility) {
          const f = world.fertility[ti];
          gain *= 0.5 + 0.5 * (f > 1 ? 1 : f);
          world.fertility[ti] = f > CP.harvest ? f - CP.harvest : 0;
        }
        h.food += gain;
        if (h.food > 1) h.food = 1;
      }
      // 足下タイルを確保（自国領に地続きの未開地のみ＝領土を連続させる）。
      const o0 = world.owner[ti];
      if (o0 === 0) {
        if (tile.isLand(terr) && this._adjacentOwner(world, tx, ty, h.kid)) {
          world.owner[ti] = h.kid; k.tileCount++;
          if (this.renderer) this.renderer.markTerritoryDirty(tx, ty);
        }
      } else if (o0 !== h.kid) {
        this._contact(h.kid, o0);
      }

      // ---- 重い意思決定は thinkInterval ごと（位相分散）----
      if (((tN + i) % CP.thinkInterval) === 0) {
        this._think(h, k, world);
      }

      // 移動 + 軽量な役割効果。
      this._move(h, null, world);
      this._roleTick(h, k, world, ti);

      // 死亡（餓死・老衰・疫病）。
      if (h.food <= 0 || h.age > CP.maxAge) {
        h.alive = false;
      } else if (k.plague > 0 && this.rand() < CP.plagueMortality) {
        h.alive = false; // 疫病で病没
      }
    }

    // 死者を除去 + 役割カウント/人口を更新。
    let w = 0;
    for (let r = 0; r < people.length; r++) {
      const p = people[r];
      if (p.alive) { people[w++] = p; }
      else {
        const k = kingdoms[p.kid];
        if (k) { k.humanCount--; k.roleCount[p.role]--; }
      }
    }
    people.length = w;

    // 出生を追加。
    if (this._births.length) {
      for (let b = 0; b < this._births.length; b++) people.push(this._births[b]);
      this._births.length = 0;
    }

    // 領土メンテナンス（支配限界の収縮・亡霊領土の消去・飛び地の穴埋め）。
    this._maintainTerritory(world);

    // 戦場の痕跡を時間で薄れさせ、消えたものを除く。
    if (this.marks.length) {
      let w2 = 0;
      const marks = this.marks;
      for (let m = 0; m < marks.length; m++) {
        if (--marks[m].ttl > 0) marks[w2++] = marks[m];
      }
      marks.length = w2;
    }

    // 外交（間引いて評価）。
    if ((tN % CP.diploInterval) === 0) this._diplomacy();
  };

  // 都市 c 群のいずれかの支配圏内に (x,y) があるか。
  CivSystem.prototype._withinControl = function (k, x, y) {
    const cities = k.cities;
    for (let c = 0; c < cities.length; c++) {
      const r = CP.controlRadius + (cities[c].level || 1) * CP.controlPerLevel;
      const dx = cities[c].x - x, dy = cities[c].y - y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  };

  // 未開の陸地 (x,y) が単一国に囲まれていればその国IDを返す（飛び地の穴埋め用）。
  CivSystem.prototype._enclaveOwner = function (world, x, y) {
    const W = world.width, H = world.height, owner = world.owner, terr = world.terrain;
    let p = -1, landN = 0;
    const nb = [x - 1, y, x + 1, y, x, y - 1, x, y + 1];
    for (let n = 0; n < 8; n += 2) {
      const nx = nb[n], ny = nb[n + 1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return 0;
      const ni = ny * W + nx;
      if (!tile.isLand(terr[ni])) continue;
      landN++;
      const o = owner[ni];
      if (o === 0) return 0;
      if (p < 0) p = o; else if (o !== p) return 0;
    }
    return landN >= 3 && p > 0 ? p : 0;
  };

  // 領土メンテ: ローリング走査で支配圏外の辺境を手放し、亡霊領土を消し、飛び地を埋める。
  CivSystem.prototype._maintainTerritory = function (world) {
    const W = world.width, H = world.height, owner = world.owner;
    const ks = this.kingdoms;
    const rndr = this.renderer;
    const y0 = this._tcursor;
    const y1 = Math.min(H, y0 + CP.maintainBand);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const o = owner[i];
        if (o > 0) {
          const k = ks[o];
          if (!k || !k.alive) { // 滅亡国の亡霊領土を消す
            owner[i] = 0; if (rndr) rndr.markTerritoryDirty(x, y);
          } else if (!this._withinControl(k, x, y)) { // 支配限界を超えた辺境を手放す
            owner[i] = 0; k.tileCount--; if (rndr) rndr.markTerritoryDirty(x, y);
          }
        } else if (tile.isLand(world.terrain[i])) {
          const fill = this._enclaveOwner(world, x, y); // 単一国に囲まれた飛び地を吸収
          if (fill > 0) { owner[i] = fill; ks[fill].tileCount++; if (rndr) rndr.markTerritoryDirty(x, y); }
        }
      }
    }
    this._tcursor = y1 >= H ? 0 : y1;
  };

  // ===== 外交（国システム）=====
  CivSystem.prototype._contact = function (a, b) {
    if (a === b || a === 0 || b === 0) return;
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    if (!ka || !kb || !ka.alive || !kb.alive) return;
    // 国境接触の鮮度を記録（隣国判定・領土紛争の根拠）。
    if (!ka.borders) ka.borders = {};
    if (!kb.borders) kb.borders = {};
    const t = this._tickN;
    ka.borders[b] = t; kb.borders[a] = t;
    if (ka.relations[b] === undefined) {
      // 初対面の印象（多少のばらつき）。
      const r = (this.rand() * 50 - 25) | 0;
      ka.relations[b] = r; kb.relations[a] = r;
    }
  };

  CivSystem.prototype._atWar = function (a, b) {
    const ka = this.kingdoms[a];
    return !!(ka && ka.wars[b]);
  };

  CivSystem.prototype._setRel = function (a, b, v) {
    v = v < -100 ? -100 : v > 100 ? 100 : v;
    this.kingdoms[a].relations[b] = v;
    this.kingdoms[b].relations[a] = v;
  };

  // 国の軍事力。兵士数を基礎に、技術・兵舎・武装度（道具/武具の備蓄）で底上げ。
  CivSystem.prototype._military = function (k) {
    const soldiers = k.roleCount[ROLE.SOLDIER] + 1;
    const barracks = k.facilities ? k.facilities.barracks : 0;
    const armed = 1 + Math.min(1, (k.tools || 0) / soldiers) * 0.6; // 武装した兵ほど強い
    return soldiers * (1 + k.tech * 0.0025) * (1 + barracks * 0.18) * armed;
  };

  // a と b を交戦状態にする（開戦時刻を記録、同盟は解消、関係悪化）。
  CivSystem.prototype._engage = function (a, b) {
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    if (!ka || !kb || !ka.alive || !kb.alive) return;
    if (ka.wars[b]) return;
    const t = this._tickN || 1;
    if (ka.relations[b] === undefined) { ka.relations[b] = 0; kb.relations[a] = 0; }
    ka.wars[b] = t; kb.wars[a] = t;
    delete ka.allies[b]; delete kb.allies[a];
    this._setRel(a, b, -80);
  };

  CivSystem.prototype._declareWar = function (a, b) {
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    if (ka && kb) this._logEvent("⚔ " + ka.name + " が " + kb.name + " に宣戦布告");
    this._engage(a, b);
    // 同盟への呼びかけ（ブロック戦争）: 双方の同盟国も参戦する。
    for (const c in ka.allies) { const ci = +c; if (ci !== b) this._engage(ci, b); }
    for (const c in kb.allies) { const ci = +c; if (ci !== a) this._engage(ci, a); }
  };

  CivSystem.prototype._makePeace = function (a, b) {
    delete this.kingdoms[a].wars[b];
    delete this.kingdoms[b].wars[a];
    this._setRel(a, b, -8);
  };

  // 決定的勝利の講和: 敗者は賠償金を払い、複数都市を持つなら係争都市を割譲する。
  CivSystem.prototype._imposePeace = function (s, w) {
    const ks = this.kingdoms[s], kw = this.kingdoms[w];
    if (!ks || !kw || !ks.alive || !kw.alive) return;
    // 賠償金（敗者の富の一部を勝者へ）。
    const trib = kw.wealth * CP.tributeFrac;
    if (trib > 0) { kw.wealth -= trib; ks.wealth += trib; }
    // 併合: 敗者が複数都市を持ち、勝者が隣国なら係争都市を奪う。
    if (kw.cities.length >= 2 && this._isNeighbor(ks, w)) this._annexNearestCity(ks, kw);
    this._makePeace(s, w);
    this._setRel(s, w, -25); // 遺恨は残る
    kw.unrest = Math.min(100, kw.unrest + 20); // 敗戦で国内動揺
    ks.unrest = Math.max(0, ks.unrest - 10);   // 戦勝で求心力
  };

  // 勝者の首都に最も近い敗者都市を、その周辺領土・住民ごと併合する。
  CivSystem.prototype._annexNearestCity = function (winner, loser) {
    if (loser.cities.length <= 1) return; // 最後の都市は戦場でしか落ちない
    const wc = winner.cities[0];
    let idx = -1, bd = 1e18;
    for (let c = 0; c < loser.cities.length; c++) {
      const dx = loser.cities[c].x - wc.x, dy = loser.cities[c].y - wc.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; idx = c; }
    }
    if (idx < 0) return;
    const city = loser.cities[idx];
    const wasCapital = idx === 0;
    loser.cities.splice(idx, 1);
    city.capital = false;
    winner.cities.push(city);
    if (wasCapital && loser.cities.length) loser.cities[0].capital = true;

    // 周辺領土の割譲。
    const world = this.world, W = world.width, H = world.height, owner = world.owner;
    const R = CP.annexRadius, R2 = R * R;
    for (let y = Math.max(0, city.y - R); y <= Math.min(H - 1, city.y + R); y++) {
      for (let x = Math.max(0, city.x - R); x <= Math.min(W - 1, city.x + R); x++) {
        const i = y * W + x;
        if (owner[i] !== loser.id) continue;
        const dx = x - city.x, dy = y - city.y;
        if (dx * dx + dy * dy > R2) continue;
        owner[i] = winner.id; loser.tileCount--; winner.tileCount++;
        if (this.renderer) this.renderer.markTerritoryDirty(x, y);
      }
    }
    // 住民の移管（その都市を本拠とする者）。
    const people = this.people, clan = ++winner.clanSeq;
    for (let p = 0; p < people.length; p++) {
      const o = people[p];
      if (!o.alive || o.kid !== loser.id) continue;
      const hx = o.home ? o.home.x : o.x, hy = o.home ? o.home.y : o.y;
      const dx = hx - city.x, dy = hy - city.y;
      if (dx * dx + dy * dy > R2) continue;
      loser.humanCount--; loser.roleCount[o.role]--;
      o.kid = winner.id; o.clan = clan; o.home = { x: city.x, y: city.y }; o.farm = null;
      winner.humanCount++; winner.roleCount[o.role]++;
    }
    this._logEvent("🏰 " + winner.name + " が " + loser.name + " の都市を併合した");
    if (loser.cities.length === 0 || loser.tileCount <= 0) {
      loser.alive = false;
      this._logEvent("☠ " + loser.name + " が滅亡した");
    }
  };

  CivSystem.prototype._formAlliance = function (a, b) {
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    ka.allies[b] = true; kb.allies[a] = true;
    delete ka.wars[b]; delete kb.wars[a];
    this._setRel(a, b, 70);
  };

  // イベント駆動の外交・経済・社会評価。
  CivSystem.prototype._diplomacy = function () {
    const ks = this.kingdoms;

    // 領有資源を集計（鉱石・漁場・宝石）。
    this._tallyResources();

    // --- 国家ごと: 経済(富・技術) と 社会(不満) ---
    for (let a = 1; a < ks.length; a++) {
      const ka = ks[a];
      if (!ka || !ka.alive) continue;
      // 無人・無領土の国は消滅。
      if (ka.humanCount <= 0 || ka.tileCount <= 0) {
        ka.alive = false;
        this._logEvent("☠ " + ka.name + " が滅亡した");
        continue;
      }
      // 機能建築の数を集計（市場・鍛冶場・神殿などの効果に使う）。
      this._recountFacilities(ka);
      const fac = ka.facilities;
      const res = ka.res || { ore: 0, fish: 0, gems: 0 };
      // 富: 領土・都市・市場・宝石から収入（商才・政体で増す）。
      ka.wealth += (ka.tileCount * 0.02 + ka.cities.length * 0.6 + fac.market * 2.5 + res.gems * 2.0) * this._eff(ka, "trade");
      // 技術: 都市・人口・富・鍛冶場・鉱石で進歩（賢明・政体で加速）。
      ka.tech += (ka.cities.length * 0.4 + ka.humanCount * 0.01 + ka.wealth * 0.001 + fac.smithy * 0.6 + res.ore * 0.5) * this._eff(ka, "tech");
      // 鉱石は武具の備蓄を増やす。備蓄は人口を上限に飽和（武装度の指標）。
      ka.tools += res.ore * 0.3;
      if (ka.tools > ka.humanCount) ka.tools = ka.humanCount;
      // 時代の進歩を年代記に記録（初到達のみ）。
      const eidx = Math.min(ERAS.length - 1, (ka.tech / TECH_PER_ERA) | 0);
      if (ka._eraIdx === undefined) ka._eraIdx = eidx;
      else if (eidx > ka._eraIdx) { ka._eraIdx = eidx; this._logEvent("✦ " + ka.name + " が" + ERAS[eidx] + "を迎えた"); }

      // 不満: 戦争・過密・貧困で上昇、平和・繁栄・神殿・穀倉で低下（性格・政体で変調）。
      const cap = this._capacity(ka);
      let dU = -1.5;
      const warCount = this._count(ka.wars);
      dU += warCount * 2.6;
      if (ka.humanCount > cap) dU += 3;
      if (ka.wealth < ka.tileCount * 0.4) dU += 1.5; else dU -= 1.2;
      dU -= fac.temple * 0.7 + fac.granary * 0.4 + res.fish * 0.3; // 信仰・食料・漁場で安定
      dU *= this._eff(ka, "unrest");
      ka.unrest = Math.max(0, Math.min(100, ka.unrest + dU));

      // 疫病: 過密で技術・衛生（神殿）が乏しい国に発生し、社会を動揺させやがて収束する。
      if (ka.plague > 0) {
        ka.plague--;
        ka.unrest = Math.min(100, ka.unrest + 6);
        if (ka.plague === 0) this._logEvent("✚ " + ka.name + " の疫病が収束した");
      } else {
        const crowd = ka.humanCount / Math.max(1, cap);
        const resist = 1 + Math.min(1.5, ka.tech * 0.004) + fac.temple * 0.4; // 技術・神殿で抵抗
        if (crowd > 0.6 && this.rand() < CP.plagueChance * crowd / resist) {
          ka.plague = CP.plagueDuration;
          this._plagues = (this._plagues || 0) + 1;
          this._logEvent("☣ " + ka.name + " で疫病が発生した");
        }
      }

      // 反乱: 不満が高く、複数都市を持つ国は地方が独立しうる。
      if (ka.unrest > 80 && ka.cities.length >= 2 &&
          this.kingdoms.length - 1 < Game.config.sim.maxKingdoms && this.rand() < 0.18) {
        this._rebellion(ka);
      }
    }

    // --- 国家ペア: 文化伝播・交易・開戦/同盟/講和 ---
    for (let a = 1; a < ks.length; a++) {
      const ka = ks[a];
      if (!ka || !ka.alive) continue;
      for (const bStr in ka.relations) {
        const b = +bStr;
        if (b <= a) continue;
        const kb = ks[b];
        if (!kb || !kb.alive) continue;
        const rel = ka.relations[b];

        // 文化的影響: 国力で勝る国の宗教が広まる（敬虔さ・政体で強まる）。
        if (ka.religion !== kb.religion) {
          if (ka.humanCount > kb.humanCount * 1.6 && this.rand() < 0.1 * this._eff(ka, "faith")) kb.religion = ka.religion;
          else if (kb.humanCount > ka.humanCount * 1.6 && this.rand() < 0.1 * this._eff(kb, "faith")) ka.religion = kb.religion;
        }

        // 疫病の伝播: 流行国に国境を接する隣国へ広がる。
        if (this._isNeighbor(ka, b)) {
          if (ka.plague > 0 && !(kb.plague > 0) && this.rand() < CP.plagueSpread) {
            kb.plague = CP.plagueDuration; this._logEvent("☣ " + kb.name + " にも疫病が広がった");
          } else if (kb.plague > 0 && !(ka.plague > 0) && this.rand() < CP.plagueSpread) {
            ka.plague = CP.plagueDuration; this._logEvent("☣ " + ka.name + " にも疫病が広がった");
          }
        }

        // 交易: 戦争でなければ双方が富む（同盟は倍。商才・政体で増す）。少し友好も育む。
        if (!ka.wars[b]) {
          const trade = Math.min(ka.tileCount, kb.tileCount) * 0.012 *
            (ka.allies[b] ? 2 : 1) * ((this._eff(ka, "trade") + this._eff(kb, "trade")) * 0.5);
          ka.wealth += trade; kb.wealth += trade;
          if (!ka.allies[b]) this._setRel(a, b, rel + 0.4);
        }

        if (ka.wars[b]) {
          // 戦争疲弊: 長期化・劣勢ほど講和しやすい。
          const dur = (this._tickN || 1) - ka.wars[b];
          const m1 = this._military(ka), m2 = this._military(kb);
          // 決定的な軍事差 → 強国が講和条件（賠償・併合）を強いる。
          if (m1 >= m2 * CP.decisiveRatio) { this._imposePeace(a, b); }
          else if (m2 >= m1 * CP.decisiveRatio) { this._imposePeace(b, a); }
          else {
            let pc = CP.peaceChance * (1 + dur / 3000);
            if (m1 < m2 * 0.6 || m2 < m1 * 0.6) pc *= 2; // 大差がつけば手打ち
            if (this.rand() < pc) this._makePeace(a, b);
          }
        } else if (ka.allies[b]) {
          // 同盟解消: 国境を接し互いに土地不足だと利害が衝突し決裂しやすい。
          let breakC = 0.05;
          if (this._isNeighbor(ka, b) &&
              ka.humanCount >= this._capacity(ka) * 0.9 && kb.humanCount >= this._capacity(kb) * 0.9) {
            breakC = 0.15;
          }
          if (this.rand() < breakC) { delete ka.allies[b]; delete kb.allies[a]; this._setRel(a, b, 5); }
        } else {
          // 開戦は隣国どうしのみ（前近代は国境を接さない国へ兵を送れない）。
          // 同盟は遠国とも結べる（婚姻・通商同盟）。
          const neighbor = this._isNeighbor(ka, b);
          const sameFaith = ka.religion === kb.religion;
          const warF = (this._eff(ka, "war") + this._eff(kb, "war")) * 0.5 * (sameFaith ? 0.6 : 1.4);
          const allyF = (this._eff(ka, "ally") + this._eff(kb, "ally")) * 0.5 * (sameFaith ? 1.4 : 0.6);
          // 土地不足の隣国どうしは領土紛争で開戦しやすい（信仰に左右されない casus belli）。
          let territorial = 0;
          if (neighbor) {
            const needA = ka.humanCount >= this._capacity(ka) * 0.9;
            const needB = kb.humanCount >= this._capacity(kb) * 0.9;
            if (needA || needB) territorial = CP.warPressure * 0.18;
          }
          const warP = (neighbor ? (0.06 + (rel < 0 ? (-rel / 100) * 0.25 : 0)) * warF : 0) + territorial;
          const allyP = (0.05 + (rel > 0 ? (rel / 100) * 0.2 : 0)) * allyF;
          // 同盟上限に達していれば新たな同盟は結べない（同盟の乱立を防ぐ）。
          const canAlly = this._count(ka.allies) < CP.maxAllies && this._count(kb.allies) < CP.maxAllies;
          const r = this.rand();
          if (r < warP) this._declareWar(a, b);
          else if (canAlly && r < warP + allyP) this._formAlliance(a, b);
          else {
            // 平時のゆらぎ。異教は緊張（悪化寄り）、同教は親和（改善寄り）。
            // 国境を接さない国とは関係が徐々に中立へ薄れる。
            if (!neighbor && Math.abs(rel) > 4) this._setRel(a, b, rel * 0.85);
            else {
              const drift = sameFaith ? (this.rand() * 8 - 3) : (this.rand() * 8 - 5.5);
              this._setRel(a, b, rel + drift);
            }
          }
        }
      }
    }
  };

  CivSystem.prototype._count = function (obj) {
    let n = 0;
    for (const k in obj) n++;
    return n;
  };

  // 反乱: 最も首都から遠い地方都市が独立し、周辺領土と住民を奪って新国家になる。
  CivSystem.prototype._rebellion = function (parent) {
    if (parent.cities.length < 2) return;
    const cap = parent.cities[0];
    // 独立する都市（首都から最も遠い非首都都市）。
    let idx = -1, bd = -1;
    for (let c = 1; c < parent.cities.length; c++) {
      const dx = parent.cities[c].x - cap.x, dy = parent.cities[c].y - cap.y;
      const d = dx * dx + dy * dy;
      if (d > bd) { bd = d; idx = c; }
    }
    if (idx < 0) return;
    const city = parent.cities[idx];

    // 新国家レコード（独立都市を首都に）。
    const id = this.kingdoms.length;
    const govIdx = (this.rand() * GOV_TYPES.length) | 0;
    const nk = {
      id: id,
      name: makeName(this.rand),
      ruler: RULER_NAMES[(this.rand() * RULER_NAMES.length) | 0],
      gov: GOV_TYPES[govIdx],
      govMod: GOV_MODS[govIdx],
      color: makeColor(this.rand),
      cities: [{ x: city.x, y: city.y, capital: true, level: city.level || 1, buildings: (city.buildings || []) }],
      tileCount: 0, humanCount: 0, roleCount: [0, 0, 0, 0, 0, 0, 0], clanSeq: 0,
      facilities: { temple: 0, farm: 0, smithy: 0, market: 0, barracks: 0, granary: 0 },
      tools: parent.tools * 0.3,
      relations: {}, borders: {}, wars: {}, allies: {},
      tech: parent.tech * 0.7, religion: parent.religion,
      trait: TRAITS[(this.rand() * TRAITS.length) | 0],
      wealth: 0, unrest: 30, plague: 0, res: { ore: 0, fish: 0, gems: 0 }, alive: true,
    };
    this.kingdoms.push(nk);
    parent.cities.splice(idx, 1);

    // 周辺領土を割譲（独立都市の周囲 R タイル）。
    const world = this.world, W = world.width, H = world.height, owner = world.owner;
    const R = 22;
    for (let y = city.y - R; y <= city.y + R; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = city.x - R; x <= city.x + R; x++) {
        if (x < 0 || x >= W) continue;
        const i = y * W + x;
        if (owner[i] === parent.id) {
          owner[i] = id;
          parent.tileCount--; nk.tileCount++;
          if (this.renderer) this.renderer.markTerritoryDirty(x, y);
        }
      }
    }
    if (nk.tileCount === 0) { owner[city.y * W + city.x] = id; nk.tileCount = 1; }

    // 独立都市を home とする住民を新国家へ。
    const clan = ++nk.clanSeq;
    const R2 = R * R;
    const people = this.people;
    for (let p = 0; p < people.length; p++) {
      const o = people[p];
      if (!o.alive || o.kid !== parent.id) continue;
      const hx = o.home ? o.home.x : o.x, hy = o.home ? o.home.y : o.y;
      const dx = hx - city.x, dy = hy - city.y;
      if (dx * dx + dy * dy > R2) continue;
      parent.humanCount--; parent.roleCount[o.role]--;
      o.kid = id; o.clan = clan; o.home = { x: city.x, y: city.y }; o.farm = null;
      nk.humanCount++; nk.roleCount[o.role]++;
    }

    // 独立戦争（親国と交戦）。親の不満は少し晴れる。
    const t = this._tickN || 1;
    nk.relations[parent.id] = -70; parent.relations[id] = -70;
    nk.wars[parent.id] = t; parent.wars[id] = t;
    parent.unrest = 45;
    this._logEvent("✊ " + nk.name + " が " + parent.name + " から独立した");
  };

  // UI 用: 各国の要約（人口降順）。
  CivSystem.prototype.getNations = function () {
    const ks = this.kingdoms;
    const out = [];
    for (let a = 1; a < ks.length; a++) {
      const k = ks[a];
      if (!k || !k.alive) continue;
      const wars = [], allies = [];
      for (const b in k.wars) if (ks[b] && ks[b].alive) wars.push(ks[b].name);
      for (const b in k.allies) if (ks[b] && ks[b].alive) allies.push(ks[b].name);
      out.push({
        id: a, name: k.name, ruler: k.ruler, gov: k.gov, color: k.color,
        pop: k.humanCount, cities: k.cities.length, tiles: k.tileCount,
        capital: k.cities[0], wars: wars, allies: allies,
        religion: k.religion, era: eraOf(k.tech), tech: Math.round(k.tech),
        trait: k.trait.name, wealth: Math.round(k.wealth), unrest: Math.round(k.unrest),
        tools: Math.round(k.tools || 0), facilities: k.facilities,
      });
    }
    out.sort(function (x, y) { return y.pop - x.pop; });
    return out;
  };

  // 放浪者の1ティック: 採食・移動・繁殖。仲間と肥沃地に集まれば国を興す。
  CivSystem.prototype._tickNomad = function (h, world, tN, i) {
    h.age++;
    h.food -= CP.metab;
    if (h.repro > 0) h.repro--;

    // 採食。
    const tx = h.x | 0, ty = h.y | 0;
    const ti = ty * world.width + tx;
    if (tile.isEdible(world.terrain[ti])) {
      let gain = CP.eatGain;
      if (world.fertility) {
        const f = world.fertility[ti];
        gain *= 0.5 + 0.5 * (f > 1 ? 1 : f);
        world.fertility[ti] = f > CP.harvest ? f - CP.harvest : 0;
      }
      h.food += gain;
      if (h.food > 1) h.food = 1;
    }

    // 思考（重い処理は間引き）: 加入・建国・定住地探し・繁殖。
    if (((tN + i) % CP.thinkInterval) === 0) {
      // 1) 加入: 足下が既存国の領土なら、その国に加わる（最優先）。
      const o = world.owner[ti];
      if (o !== 0) {
        const k = this.kingdoms[o];
        if (k && k.alive && k.humanCount < CP.perKingdomCap) { this._joinKingdom(h, k); return; }
      }
      // 2) 近くに国の民がいれば、そこへ向かって加入を目指す。
      const citizen = this._scan(h.x, h.y, CP.joinRadius, function (oo) {
        return (oo.kid !== 0 && oo.alive) ? 2 : 0;
      }).best;
      if (citizen) {
        const dx = citizen.x - h.x, dy = citizen.y - h.y;
        if (dx * dx + dy * dy < 6) {
          const k = this.kingdoms[citizen.kid];
          if (k && k.alive && k.humanCount < CP.perKingdomCap) { this._joinKingdom(h, k); return; }
        }
        h.gx = citizen.x | 0; h.gy = citizen.y | 0; h.state = 9;
      } else {
        // 3) 定住先（肥沃な無所属地）を探す。無ければ仲間と群れる/徘徊。
        const spot = this._nearestTile(h, world, 5, function (terr, ow) {
          return ow === 0 && tile.isEdible(terr);
        });
        if (spot) { h.gx = spot.x; h.gy = spot.y; h.state = 10; }
        else {
          const mate = this._scan(h.x, h.y, CP.nomadClusterRadius, function (oo) { return oo.kid === 0 && oo.alive ? 2 : 0; }).best;
          if (mate) { h.gx = mate.x | 0; h.gy = mate.y | 0; }
          else { h.gx = (h.x + (this.rand() - 0.5) * 8) | 0; h.gy = (h.y + (this.rand() - 0.5) * 8) | 0; }
          h.state = 11;
        }

        // 4) 建国: 無所属の可食地に仲間が集まっていれば国を興す（近くに国が無いときのみ）。
        if (world.owner[ti] === 0 && tile.isEdible(world.terrain[ti]) &&
            this.kingdoms.length - 1 < Game.config.sim.maxKingdoms) {
          const band = this._scan(h.x, h.y, CP.nomadFoundRadius, function (oo) { return oo.kid === 0 && oo.alive ? 1 : 0; });
          if (band.count >= CP.nomadFoundBand && this.rand() < CP.nomadFoundChance) {
            this._foundFromNomads(h, tx, ty);
            return;
          }
        }
      }

      // 繁殖（放浪者同士）。
      this._tryReproduceNomad(h);
    }

    this._move(h, null, world);

    if (h.food <= 0 || h.age > CP.maxAge) h.alive = false;
  };

  // 放浪者が既存の国に加入して市民になる。
  CivSystem.prototype._joinKingdom = function (h, k) {
    h.kid = k.id;
    h.clan = ++k.clanSeq;
    h.role = this._assignRole(k);
    h.home = this._nearestCity(k, h.x, h.y);
    h.farm = null;
    h.gx = h.home.x; h.gy = h.home.y;
    h.repro = CP.reproCooldown;
    h.social = 0;
    k.humanCount++;
    k.roleCount[h.role]++;
  };

  // 過密＋飢餓の市民は国を離れて流民になり、よりよい土地を求める（移民）。
  CivSystem.prototype._leaveKingdom = function (h, k) {
    k.humanCount--;
    k.roleCount[h.role]--;
    h.kid = 0;
    h.clan = 0;
    h.role = ROLE.EXPLORER;
    h.home = null;
    h.farm = null;
    h.repro = CP.reproCooldown;
  };

  // 市民が状況に応じて転職する（飢饉で農民へ、戦時に兵士へ等の適応行動）。
  CivSystem.prototype._switchRole = function (h, k, role) {
    if (h.role === role) return;
    k.roleCount[h.role]--;
    h.role = role;
    k.roleCount[role]++;
    h.farm = null; h.work = null; h._enemy = null;
  };

  // 放浪者の集団が建国: 中心の人とその周囲の放浪者が新王国の住人になる。
  CivSystem.prototype._foundFromNomads = function (h, tx, ty) {
    const k = this._newKingdom(tx, ty);
    if (!k) return;
    const clan = ++k.clanSeq;
    const people = this.people;
    const r = CP.nomadFoundRadius;
    const r2 = r * r;
    // 中心の人＋周囲の放浪者を市民に転向。
    for (let p = 0; p < people.length; p++) {
      const o = people[p];
      if (!o.alive || o.kid !== 0) continue;
      const dx = o.x - h.x, dy = o.y - h.y;
      if (dx * dx + dy * dy > r2) continue;
      if (k.humanCount >= CP.perKingdomCap) break;
      o.kid = k.id;
      o.clan = clan;
      o.role = this._assignRole(k);
      o.home = { x: tx, y: ty };
      o.farm = null;
      o.gx = tx; o.gy = ty;
      o.repro = CP.reproCooldown;
      o.social = 0;
      k.humanCount++;
      k.roleCount[o.role]++;
    }
    this._logEvent("⚑ " + k.name + " が建国された");
  };

  CivSystem.prototype._tryReproduceNomad = function (h) {
    if (h.age < CP.adultAge || h.age > CP.elderAge) return;
    if (h.food < CP.reproFood || h.repro > 0) return;
    if (this.people.length + this._births.length >= Game.config.sim.maxPeople) return;
    const partner = this._scan(h.x, h.y, CP.reproRadius, function (o) {
      return (o.kid === 0 && o !== h && o.alive && o.age >= CP.adultAge && o.food >= CP.reproFood && o.repro <= 0) ? 2 : 0;
    }).best;
    if (!partner) return;
    h.repro = CP.reproCooldown; partner.repro = CP.reproCooldown;
    h.food -= CP.reproCost; partner.food -= CP.reproCost;
    this._births.push({
      x: h.x, y: h.y, hx: 0, hy: 0,
      kid: 0, clan: 0, age: 0, food: 0.7,
      role: ROLE.EXPLORER, state: 0, gx: h.x | 0, gy: h.y | 0,
      repro: CP.reproCooldown, social: 0, alive: true,
    });
  };

  // 自国領に地続きの未開地のみ確保する（足下が自国領のときだけ周囲へ拡張）。
  // これにより領土は都市から連続した塊として広がる（斑点・飛び地を防ぐ）。
  CivSystem.prototype._claimNeighbors = function (h, k, world) {
    const W = world.width, H = world.height, owner = world.owner, id = k.id;
    const cx = h.x | 0, cy = h.y | 0;
    // 足下が自国領でなければ拡張しない（連続性の担保）。
    if (owner[cy * W + cx] !== id) return;
    const nb = [cx - 1, cy, cx + 1, cy, cx, cy - 1, cx, cy + 1];
    for (let n = 0; n < 8; n += 2) {
      const x = nb[n], y = nb[n + 1];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const ni = y * W + x;
      if (!tile.isLand(world.terrain[ni])) continue;
      const o = owner[ni];
      if (o === 0) {
        owner[ni] = id; k.tileCount++;
        if (this.renderer) this.renderer.markTerritoryDirty(x, y);
      } else if (o !== id) {
        this._contact(id, o);
      }
    }
  };

  // (x,y) の4近傍に id の領土があるか（前線判定）。
  CivSystem.prototype._adjacentOwner = function (world, x, y, id) {
    const W = world.width, H = world.height, owner = world.owner;
    if (x > 0 && owner[y * W + x - 1] === id) return true;
    if (x < W - 1 && owner[y * W + x + 1] === id) return true;
    if (y > 0 && owner[(y - 1) * W + x] === id) return true;
    if (y < H - 1 && owner[(y + 1) * W + x] === id) return true;
    return false;
  };

  // 最寄り集落への方向・距離2乗を返す。
  CivSystem.prototype._home = function (h, k) {
    let dx = 0, dy = 0, d2 = 1e9;
    for (let c = 0; c < k.cities.length; c++) {
      const ddx = k.cities[c].x + 0.5 - h.x;
      const ddy = k.cities[c].y + 0.5 - h.y;
      const d = ddx * ddx + ddy * ddy;
      if (d < d2) { d2 = d; dx = ddx; dy = ddy; }
    }
    return { dx: dx, dy: dy, d2: d2 };
  };

  // AI: 欲求と役割を勘案して目標(gx,gy)を決める「熟考」。thinkInterval 毎にのみ実行。
  CivSystem.prototype._think = function (h, k, world) {
    const self = this;
    // 近傍の土地を確保（足下は毎ティック）。
    this._claimNeighbors(h, k, world);
    // 繁殖（成人・食料十分・近くに同胞成人がいれば家族を作る）。
    this._tryReproduce(h, k);

    // 0) 移民: 国が過密で食料も乏しければ、町を捨て流民となり新天地を探す。
    const capacity = this._capacity(k);
    if (h.food < 0.3 && k.humanCount > capacity && this.rand() < 0.12) {
      this._leaveKingdom(h, k); return;
    }

    // 0.2) 適応: 慢性的な飢えで農民が手薄なら食料生産へ転職。戦時に兵が手薄なら民間人が
    //      武器を取る（緊急徴募）。状況に応じて職を変える＝賢い集団としての振る舞い。
    if (h.role !== ROLE.FARMER && h.food < 0.25 &&
        k.roleCount[ROLE.FARMER] < k.humanCount * 0.3 && this.rand() < 0.12) {
      this._switchRole(h, k, ROLE.FARMER);
    } else if ((h.role === ROLE.EXPLORER || h.role === ROLE.BUILDER) && this._count(k.wars) > 0 &&
        k.roleCount[ROLE.SOLDIER] < k.humanCount * 0.12 && this.rand() < 0.06) {
      this._switchRole(h, k, ROLE.SOLDIER);
    }

    // 自分の町（home）への方向・距離。
    const hcx = (h.home ? h.home.x : k.cities[0].x);
    const hcy = (h.home ? h.home.y : k.cities[0].y);
    const hdx = hcx + 0.5 - h.x, hdy = hcy + 0.5 - h.y;
    const hd2 = hdx * hdx + hdy * hdy;

    // 0.5) 戦時の民間人は侵入してきた敵兵から逃げる（賢い回避行動）。
    if (h.role !== ROLE.SOLDIER && this._count(k.wars) > 0) {
      const foe = this._scan(h.x, h.y, 6, function (o) {
        return (o.kid !== h.kid && o.kid !== 0 && o.role === ROLE.SOLDIER && self._atWar(h.kid, o.kid)) ? 2 : 0;
      }).best;
      if (foe) {
        // 敵から離れる向き＋自国の町方向へ退避。
        const ax = h.x - foe.x, ay = h.y - foe.y;
        h.gx = Game.utils.clamp((h.x + ax + (hcx - h.x) * 0.3) | 0, 0, world.width - 1);
        h.gy = Game.utils.clamp((h.y + ay + (hcy - h.y) * 0.3) | 0, 0, world.height - 1);
        h.state = 8; return;
      }
    }

    // 1) 強い空腹 → 近くの可食地へ。
    if (h.food < 0.4) {
      const t = this._nearestTile(h, world, 5, function (terr) { return tile.isEdible(terr); });
      if (t) { h.gx = t.x; h.gy = t.y; h.state = 1; return; }
    }
    // 1.2) 狩り: 開拓者・兵士は近くの野生動物を仕留めて食料にする（人と動物の関わり）。
    if ((h.role === ROLE.EXPLORER || h.role === ROLE.SOLDIER) && h.food < 0.75) {
      const cr = Game.state.creatures, ents = Game.state.entities;
      if (cr && ents && cr.nearestAnimal) {
        const prey = cr.nearestAnimal(h.x, h.y, Game.SPECIES.HERBIVORE, 5);
        if (prey !== -1 && ents.alive[prey]) {
          const dx = ents.x[prey] - h.x, dy = ents.y[prey] - h.y;
          if (dx * dx + dy * dy < 1.8) {
            ents.kill(prey);                       // 仕留めた
            h.food = h.food + 0.5 > 1 ? 1 : h.food + 0.5; // 肉で回復
            h.state = 16;
          } else {
            h.gx = ents.x[prey] | 0; h.gy = ents.y[prey] | 0; h.state = 16; return; // 追跡
          }
        }
      }
    }
    // 1.5) 夜は帰宅して休む（戦時の兵士は夜も戦う）。昼は働き夜は静まる生活リズムを作る。
    if (this._night && !(h.role === ROLE.SOLDIER && this._count(k.wars) > 0)) {
      if (hd2 > 9) { h.gx = hcx; h.gy = hcy; }            // 町へ帰る
      else { this._ringGoal(h, world, hcx, hcy, 0, 2); }  // 家の周りで休む
      h.state = 13; return;
    }
    // 2) 孤独 → 同胞のもとへ集まる。
    if (h.social > 1) {
      const soc = this._scan(h.x, h.y, CP.socialRadius, function (o) { return o.kid === h.kid ? 1 : 0; });
      if (soc.count >= CP.socialNeed) h.social = 0;
      else { h.gx = hcx; h.gy = hcy; h.state = 2; return; }
    }
    // 3) 行動範囲外 → 自分の町へ帰る（農民・建築家は狭く定住、開拓者・兵士は広く）。
    const tether = (h.role === ROLE.EXPLORER || h.role === ROLE.SOLDIER) ? CP.tether : CP.tetherSettled;
    if (hd2 > tether * tether) {
      h.gx = hcx; h.gy = hcy; h.state = 3; return;
    }

    // 4) 役割ごとの目的地・判断（各自ばらけた行動圏を巡回する）。
    if (h.role === ROLE.SOLDIER) {
      // 周囲の戦力を把握（味方=count, 敵=count2, 最寄りの交戦相手=best）。
      const scan = this._scan(h.x, h.y, 9, function (o) {
        if (o.role !== ROLE.SOLDIER || o.kid === 0) return 0;
        if (o.kid === h.kid) return 1;            // 味方兵
        return self._atWar(h.kid, o.kid) ? 2 : 0; // 交戦中の敵兵
      });
      const e = scan.best;
      h._enemy = e;
      // 士気: 局所的に大きく劣勢なら退却して味方と合流する（無謀な突撃を避ける）。
      if (e && scan.count2 > scan.count + 1) {
        h.gx = hcx; h.gy = hcy; h.state = 14; return;
      }
      // 敵が見えれば交戦。
      if (e) { h.gx = e.x | 0; h.gy = e.y | 0; h.state = 5; return; }
      // 敵影が無ければ前線（交戦国の領土）へ前進する。
      const t = this._nearestTile(h, world, 7, function (terr, ow) {
        return ow !== 0 && ow !== h.kid && self._atWar(h.kid, ow);
      });
      if (t) { h.gx = t.x; h.gy = t.y; h.state = 5; return; }
      // 平時は領内を広く警邏（外周寄りを巡回）。
      this._ringGoal(h, world, hcx, hcy, CP.tether * 0.4, CP.tether);
      h.state = 5; return;
    }
    if (h.role === ROLE.EXPLORER) {
      this._maybeFoundTown(h, k); // 遠地で新集落
      const t = this._nearestTile(h, world, CP.seekRange + 1, function (terr, ow) { return ow === 0 && tile.isLand(terr); });
      if (t) { h.gx = t.x; h.gy = t.y; h.state = 4; return; }
      // 近くに未開の陸が無い → 海を越える植民を試みる（時代1以降・沿岸・確率）。
      if (k.tech >= TECH_PER_ERA && this.rand() < CP.embarkChance && this._coastal(world, h.x | 0, h.y | 0)) {
        const tgt = this._findOverseasLand(world, h.x | 0, h.y | 0);
        if (tgt) {
          h.sailing = true; h.sea = tgt; h.gx = tgt.x; h.gy = tgt.y; h.state = 15;
          this._embarks = (this._embarks || 0) + 1;
          this._logEvent(k.name + "の入植者が海へ船出した");
          return;
        }
      }
      this._ringGoal(h, world, hcx, hcy, 4, CP.tether); // 未開地が無ければ領内を広く移動
      h.state = 4; return;
    }
    if (h.role === ROLE.BUILDER) {
      // 町に居れば実際に建設・建て替え。遠地に出たら新集落を興す。
      if (hd2 < 36) {
        const city = this._cityAt(k, hcx, hcy);
        if (city) this._construct(k, city, world);
      } else {
        this._maybeFoundTown(h, k);
      }
      // 工事現場（町なか）をうろつく。
      this._ringGoal(h, world, hcx, hcy, 0, 5);
      h.state = 6; return;
    }
    // 専門職（鍛冶・商人・神官）: 対応する施設へ出勤して働く。職場のある町に定住する
    // （職場が遠い町に属していると行動範囲外で働けないため、職場へ住み替える）。
    if (h.role === ROLE.SMITH || h.role === ROLE.MERCHANT || h.role === ROLE.PRIEST) {
      const ftype = h.role === ROLE.SMITH ? BUILDING.SMITHY
        : h.role === ROLE.MERCHANT ? BUILDING.MARKET : BUILDING.TEMPLE;
      if (!h.work || this.rand() < 0.03) h.work = this._nearestFacility(k, h.x, h.y, ftype);
      if (h.work) {
        h.home = { x: h.work.x, y: h.work.y }; // 職場の都市に通勤定住
        if (this.rand() < 0.7) { h.gx = h.work.x; h.gy = h.work.y; } // 出勤
        else { this._ringGoal(h, world, h.work.x, h.work.y, 0, 4); }  // 職場周辺
      } else {
        // 職場がまだ無ければ町なかで待機（やがて建築家が施設を建てる）。
        this._ringGoal(h, world, hcx, hcy, 0, 5);
      }
      h.state = 12; return;
    }
    // FARMER（既定）: 町の周りに自分の畑を持ち、出勤して耕し、たまに帰宅する（職住近接）。
    if (!h.farm) {
      const ang = this.rand() * Math.PI * 2;
      const dr = 3 + this.rand() * (CP.tetherSettled - 3);
      h.farm = {
        x: Game.utils.clamp((hcx + Math.cos(ang) * dr) | 0, 0, world.width - 1),
        y: Game.utils.clamp((hcy + Math.sin(ang) * dr) | 0, 0, world.height - 1),
      };
    }
    if (this.rand() < 0.25) { h.gx = hcx; h.gy = hcy; } // 帰宅
    else { h.gx = h.farm.x; h.gy = h.farm.y; }          // 畑へ出勤
    h.state = 7;
  };

  // (x,y) が海に接する沿岸タイルか（4近傍に水）。
  CivSystem.prototype._coastal = function (world, x, y) {
    const W = world.width, H = world.height, terr = world.terrain;
    if (x > 0 && tile.isWater(terr[y * W + x - 1])) return true;
    if (x < W - 1 && tile.isWater(terr[y * W + x + 1])) return true;
    if (y > 0 && tile.isWater(terr[(y - 1) * W + x])) return true;
    if (y < H - 1 && tile.isWater(terr[(y + 1) * W + x])) return true;
    return false;
  };

  // 海を隔てた未開の陸地を探す。中点が海であること（=海路で渡る）を条件に、
  // minSailGap〜maxSailRange の範囲でランダム方向に走査して最初の候補を返す。
  CivSystem.prototype._findOverseasLand = function (world, x, y) {
    const W = world.width, H = world.height, terr = world.terrain, owner = world.owner;
    const minR = CP.minSailGap, maxR = CP.maxSailRange;
    // 8方向を起点ランダムで一巡。各方向に外側へ伸ばし、海を越えた先の未開地を探す。
    const start = (this.rand() * 8) | 0;
    for (let s = 0; s < 8; s++) {
      const a = ((start + s) % 8) * (Math.PI / 4);
      const cx = Math.cos(a), cy = Math.sin(a);
      let crossedWater = false;
      for (let r = 2; r <= maxR; r++) {
        const nx = (x + cx * r) | 0, ny = (y + cy * r) | 0;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
        const i = ny * W + nx;
        if (tile.isWater(terr[i])) { crossedWater = true; continue; }
        // 陸に到達。海を越えており、未開（無所属）かつ十分遠ければ植民先。
        if (crossedWater && r >= minR && owner[i] === 0 && tile.isLand(terr[i])) {
          return { x: nx, y: ny };
        }
        // 海を越える前に陸（地続き）に当たったら、その方向は不可。
        if (!crossedWater) break;
      }
    }
    return null;
  };

  // 航海中の入植者の1ティック: 目的地へ水上を直進し、上陸して植民する。
  CivSystem.prototype._tickSail = function (h, world) {
    h.age++;
    h.food -= CP.sailMetab;
    const tx = h.sea.x + 0.5, ty = h.sea.y + 0.5;
    const dx = tx - h.x, dy = ty - h.y;
    const d = Math.hypot(dx, dy);
    if (d < 1.3) { this._landColony(h); return; }
    const sp = CP.sailSpeed;
    h.x += dx / d * sp; h.y += dy / d * sp;
    h.hx = dx / d * sp; h.hy = dy / d * sp;
    if (h.food <= 0 || h.age > CP.maxAge) h.alive = false; // 海難（行方不明）
  };

  // 上陸して植民地（新王国）を興す。母国の宗教・技術を引き継ぐ。
  CivSystem.prototype._landColony = function (h) {
    const k0 = this.kingdoms[h.kid];
    const tx = h.sea ? h.sea.x : (h.x | 0), ty = h.sea ? h.sea.y : (h.y | 0);
    h.sailing = false; h.sea = null;
    h.x = tx + 0.5; h.y = ty + 0.5;
    const nk = this._newKingdom(tx, ty);
    // 入植者を母国から外す。
    if (k0 && k0.alive) { k0.humanCount--; k0.roleCount[h.role]--; }
    if (nk) {
      if (k0) { nk.religion = k0.religion; nk.tech = k0.tech * 0.6; }
      h.kid = nk.id; h.clan = ++nk.clanSeq; h.role = ROLE.EXPLORER;
      h.home = { x: tx, y: ty }; h.farm = null; h.work = null;
      nk.humanCount++; nk.roleCount[h.role]++;
      this._colonies = (this._colonies || 0) + 1;
      this._logEvent(nk.name + " が海の彼方に建国した" + (k0 ? "（" + k0.name + "の植民地）" : ""));
    } else {
      // 上陸地が既に所有/不適 → 放浪者になる。
      h.kid = 0; h.clan = 0; h.role = ROLE.EXPLORER; h.home = null; h.farm = null; h.work = null;
    }
  };

  // (x,y) に一致する k の都市オブジェクトを返す。
  CivSystem.prototype._cityAt = function (k, x, y) {
    for (let c = 0; c < k.cities.length; c++) {
      if (k.cities[c].x === x && k.cities[c].y === y) return k.cities[c];
    }
    return k.cities[0];
  };

  // 建築家が都市で建設/建て替えを行う（人間が街を作る）。
  // 住居だけでなく、時代と都市の必要に応じて農場・鍛冶場・市場・兵舎・神殿・穀倉を
  // バランスよく建て、人々の職場と国の機能を生み出す。
  CivSystem.prototype._construct = function (k, city, world) {
    if (!city.buildings) city.buildings = [];
    const bs = city.buildings;
    // 上限に達したら建て替え（時代遅れの住居を更新）のみ。
    if (bs.length >= MAX_BUILDINGS) { this._rebuild(k, city); return; }
    // 建設は緩やかに進める。建てない番は古い住居の更新に充てる。
    if (this.rand() > 0.2) { this._rebuild(k, city); return; }

    const tier = dwellingTier(k.tech);
    // 現在の構成を数える。
    let dwell = 0; const has = {};
    for (let i = 0; i < bs.length; i++) {
      const t = bs[i].t;
      if (t === BUILDING.HUT || t === BUILDING.HOUSE || t === BUILDING.MANOR) dwell++;
      has[t] = (has[t] || 0) + 1;
    }

    // 鉱山: 領内に未採掘の鉱石があれば、そのタイルに鉱山を建てて採掘する。
    if (!has[BUILDING.MINE] && bs.length >= 2) {
      const ore = this._oreSpotNear(world, k, city);
      if (ore) {
        bs.push({ x: ore.x, y: ore.y, t: BUILDING.MINE });
        city.level = 1 + ((bs.length / 3) | 0);
        return;
      }
    }

    // 必要な建物を優先順位で選ぶ。基幹施設（工房・倉・市・兵舎）は原始的な形で早期から
    // 建ち、産物は技術で増える。神殿は社会が成熟してから。最後は住居で人口増に対応。
    const n = bs.length;
    let want;
    if (!has[BUILDING.FARM] && n >= 1) want = BUILDING.FARM;               // まず食料生産
    else if (dwell < 2) want = tier;                                       // 最低限の住居
    else if (!has[BUILDING.SMITHY] && n >= 3) want = BUILDING.SMITHY;      // 工房（道具・武具）
    else if (!has[BUILDING.GRANARY] && n >= 4) want = BUILDING.GRANARY;    // 倉（食料安全）
    else if (!has[BUILDING.MARKET] && n >= 4) want = BUILDING.MARKET;      // 市（富）
    else if ((this._count(k.wars) > 0 || city.capital) && !has[BUILDING.BARRACKS] && n >= 4) want = BUILDING.BARRACKS; // 兵舎
    else if (!has[BUILDING.TEMPLE] && n >= 6) want = BUILDING.TEMPLE;      // 神殿（信仰・成熟した都市）
    else if (dwell < Math.max(3, n * 0.5)) want = tier;                   // 人口に見合う住居
    else if ((has[BUILDING.SMITHY] || 0) < 2 && n >= 11) want = BUILDING.SMITHY;    // 大都市は2軒目
    else if ((has[BUILDING.MARKET] || 0) < 2 && n >= 13) want = BUILDING.MARKET;
    else want = tier;                                                      // さらに住居を増やす

    const spot = this._buildSpot(world, k, city);
    if (spot) {
      bs.push({ x: spot.x, y: spot.y, t: want });
      city.level = 1 + ((bs.length / 3) | 0);
    }
  };

  // 時代遅れの住居を現代の様式へ建て替える（古いものは建て替える）。
  CivSystem.prototype._rebuild = function (k, city) {
    if (this.rand() > 0.12) return;
    const tier = dwellingTier(k.tech);
    const bs = city.buildings;
    for (let i = 0; i < bs.length; i++) {
      const t = bs[i].t;
      if ((t === BUILDING.HUT || t === BUILDING.HOUSE || t === BUILDING.MANOR) && t < tier) { bs[i].t = tier; return; }
    }
  };

  // 都市の近くにある、自国領の未採掘の鉱石タイルを探す（鉱山の建設地）。
  CivSystem.prototype._oreSpotNear = function (world, k, city) {
    if (!world.resource) return null;
    const W = world.width, H = world.height, owner = world.owner, res = world.resource;
    const R = 7;
    const cx = city.x, cy = city.y;
    let bx = -1, by = -1, bd = 1e9;
    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy; if (y < 0 || y >= H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx; if (x < 0 || x >= W) continue;
        const i = y * W + x;
        if (res[i] !== Game.RESOURCE.ORE || owner[i] !== k.id) continue;
        let occupied = false;
        const bs = city.buildings;
        for (let bi = 0; bi < bs.length; bi++) { if (bs[bi].x === x && bs[bi].y === y) { occupied = true; break; } }
        if (occupied) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bx = x; by = y; }
      }
    }
    return bx < 0 ? null : { x: bx, y: by };
  };

  // 都市の近くで建設可能な空きタイル（自国の陸地・建物が未設置）を探す。
  CivSystem.prototype._buildSpot = function (world, k, city) {
    const W = world.width, H = world.height, owner = world.owner;
    for (let r = 1; r <= 4; r++) {
      for (let tries = 0; tries < 6; tries++) {
        const ang = this.rand() * Math.PI * 2;
        const x = (city.x + Math.cos(ang) * r) | 0;
        const y = (city.y + Math.sin(ang) * r) | 0;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (owner[i] !== k.id || !tile.isLand(world.terrain[i])) continue;
        let occupied = false;
        for (let bi = 0; bi < city.buildings.length; bi++) {
          if (city.buildings[bi].x === x && city.buildings[bi].y === y) { occupied = true; break; }
        }
        if (!occupied) return { x: x, y: y };
      }
    }
    return null;
  };

  // (cx,cy) を中心とした [minR,maxR] のリング内のランダムな点を目標にする。
  // 役割ごとの行動圏に人々を散らし、絶えず動かすためのもの。
  CivSystem.prototype._ringGoal = function (h, world, cx, cy, minR, maxR) {
    const ang = this.rand() * Math.PI * 2;
    const dist = minR + this.rand() * (maxR - minR);
    h.gx = Game.utils.clamp((cx + Math.cos(ang) * dist) | 0, 0, world.width - 1);
    h.gy = Game.utils.clamp((cy + Math.sin(ang) * dist) | 0, 0, world.height - 1);
  };

  // 半径 r 内で pred(terrain, owner) を満たす最寄りタイル（無ければ null）。
  CivSystem.prototype._nearestTile = function (h, world, r, pred) {
    const W = world.width, H = world.height;
    const cx = h.x | 0, cy = h.y | 0;
    let bx = -1, by = -1, bd = 1e9;
    for (let dy = -r; dy <= r; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const nx = cx + dx;
        if (nx < 0 || nx >= W) continue;
        const ni = ny * W + nx;
        if (pred(world.terrain[ni], world.owner[ni])) {
          const d = dx * dx + dy * dy;
          if (d > 0 && d < bd) { bd = d; bx = nx; by = ny; }
        }
      }
    }
    return bx < 0 ? null : { x: bx, y: by };
  };

  CivSystem.prototype._tryReproduce = function (h, k) {
    if (h.age < CP.adultAge || h.age > CP.elderAge) return;
    if (h.food < CP.reproFood || h.repro > 0) return;
    const capacity = this._capacity(k);
    if (k.humanCount >= capacity) return;
    if (this.people.length + this._births.length >= Game.config.sim.maxPeople) return;
    // 近くの同王国の成人をパートナーに。
    const partner = this._scan(h.x, h.y, CP.reproRadius, function (o) {
      return (o.kid === h.kid && o !== h && o.age >= CP.adultAge && o.food >= CP.reproFood && o.repro <= 0) ? 2 : 0;
    }).best;
    if (!partner) return;
    h.repro = CP.reproCooldown; partner.repro = CP.reproCooldown;
    h.food -= CP.reproCost; partner.food -= CP.reproCost;
    const child = this._spawnHuman(k, h.x, h.y, h.clan, this._assignRole(k), 0.7);
    if (child) this._births.push(child);
  };

  CivSystem.prototype._move = function (h, k, world) {
    const W = world.width, H = world.height;
    let dux = h.gx + 0.5 - h.x;
    let duy = h.gy + 0.5 - h.y;
    const dist = Math.hypot(dux, duy);
    let speed = CP.speed;
    if (dist < 0.6) {
      // 目標到達 → 直前の向きを保ちつつ緩やかに彷徨う（カクつき防止）。
      dux = (h.hx || 0) * 6 + (this.rand() - 0.5) * 0.5;
      duy = (h.hy || 0) * 6 + (this.rand() - 0.5) * 0.5;
      speed *= 0.45;
    } else {
      dux /= dist; duy /= dist;
    }
    // 慣性: 直前の進行方向と混ぜて滑らかに曲がる。
    const pl = Math.hypot(h.hx || 0, h.hy || 0);
    const pux = pl > 1e-4 ? h.hx / pl : dux;
    const puy = pl > 1e-4 ? h.hy / pl : duy;
    let bx = pux * 0.55 + dux * 0.45;
    let by = puy * 0.55 + duy * 0.45;
    const bl = Math.hypot(bx, by) || 1;
    const stepx = (bx / bl) * speed;
    const stepy = (by / bl) * speed;
    const nxp = h.x + stepx;
    const nyp = h.y + stepy;
    const ntx = Game.utils.clamp(nxp | 0, 0, W - 1);
    const nty = Game.utils.clamp(nyp | 0, 0, H - 1);
    if (tile.isLand(world.terrain[nty * W + ntx])) {
      h.hx = stepx; h.hy = stepy;
      h.x = nxp; h.y = nyp;
    } else {
      // 水際で反転気味に減衰（壁に張り付かない）。
      h.hx *= -0.4; h.hy *= -0.4;
    }
  };

  // 施設で就労中（職場座標に十分近い）か。
  CivSystem.prototype._atWork = function (h) {
    if (!h.work) return false;
    const dx = h.work.x + 0.5 - h.x, dy = h.work.y + 0.5 - h.y;
    return dx * dx + dy * dy < CP.workRadius * CP.workRadius;
  };

  // 役割の局所効果（毎ティックだが探索なし＝低負荷）。ti は足下のタイル index。
  CivSystem.prototype._roleTick = function (h, k, world, ti) {
    if (h.role === ROLE.FARMER) {
      // 耕作: 道具があるほど効率よく足下の fertility を高める。
      if (world.fertility && tile.isLand(world.terrain[ti])) {
        const f = world.fertility[ti] + CP.cultivate * (1 + (h.gear || 0) * 0.15);
        world.fertility[ti] = f > 1 ? 1 : f;
      }
      // 道具の支給（在庫があれば）。
      if (!h.gear && k.tools > 0 && this.rand() < CP.equipChance) h.gear = gearTier(k.tech);
      return;
    }
    // 鍛冶: 鍛冶場で道具・武具を生産する（人口を上限に飽和）。
    if (h.role === ROLE.SMITH) {
      if (this._atWork(h)) {
        if (k.tools < k.humanCount) k.tools += CP.toolRate * (1 + k.tech * 0.002);
        if (!h.gear) h.gear = gearTier(k.tech);
      }
      return;
    }
    // 商人: 市場で富を生む。
    if (h.role === ROLE.MERCHANT) {
      if (this._atWork(h)) {
        k.wealth += CP.marketRate * this._eff(k, "trade");
        if (!h.gear) h.gear = gearTier(k.tech);
      }
      return;
    }
    // 神官: 神殿で不満を鎮める。
    if (h.role === ROLE.PRIEST) {
      if (this._atWork(h)) {
        if (k.unrest > 0) k.unrest = Math.max(0, k.unrest - CP.templeCalm * this._eff(k, "faith"));
        if (!h.gear) h.gear = gearTier(k.tech);
      }
      return;
    }
    if (h.role === ROLE.SOLDIER) {
      // 武具の支給（在庫があれば）。
      if (!h.gear && k.tools > 0 && this.rand() < CP.equipChance) h.gear = gearTier(k.tech);
      // 思考時にキャッシュした敵が隣接していれば交戦（探索不要）。
      const e = h._enemy;
      if (e && e.alive && this._atWar(h.kid, e.kid)) {
        const dx = e.x - h.x, dy = e.y - h.y;
        if (dx * dx + dy * dy < 2.25) {
          // 戦闘: 軍事力で勝る側ほど、また武装が良いほど大きな損害を与える。0 で戦死。
          const other = this.kingdoms[e.kid];
          const m1 = this._military(k), m2 = other ? this._military(other) : 1;
          const edge = m1 / (m1 + m2);
          e.food -= CP.attack * (0.6 + edge) * (1 + (h.gear || 0) * 0.12);
          if (e.food <= 0) { e.food = 0; e.alive = false; this._addMark(e.x, e.y); } // 戦死
        }
      } else {
        h._enemy = null;
      }
      // 征服: 足下が交戦国の前線タイルのときだけ奪う（探索は隣接4のみ）。
      const o = world.owner[ti];
      if (o !== 0 && o !== h.kid && this._atWar(h.kid, o)) {
        const other = this.kingdoms[o];
        if (other && other.alive) {
          const tx = h.x | 0, ty = h.y | 0;
          // 征服成功率は相対的な軍事力で決まる（強国が前線を押す）。
          const m1 = this._military(k), m2 = this._military(other);
          const chance = CP.conflictChance * 2 * (m1 / (m1 + m2));
          if (this._adjacentOwner(world, tx, ty, h.kid) && this.rand() < chance) {
            world.owner[ti] = h.kid; k.tileCount++; other.tileCount--;
            if (this.renderer) this.renderer.markTerritoryDirty(tx, ty);
            // 都市の攻略: 足下に敵都市があれば占領（自国の都市になる）。
            for (let c = 0; c < other.cities.length; c++) {
              if (other.cities[c].x === tx && other.cities[c].y === ty) {
                const captured = other.cities[c];
                const wasCapital = c === 0;
                other.cities.splice(c, 1);
                captured.capital = false;
                k.cities.push(captured);
                if (other.cities.length === 0) {
                  other.alive = false; // 最後の都市を失い国家崩壊
                  this._logEvent("☠ " + other.name + " が " + k.name + " に征服された");
                } else if (wasCapital) {
                  other.cities[0].capital = true; // 遷都
                }
                break;
              }
            }
            if (other.alive && other.tileCount <= 0) { other.alive = false; this._logEvent("☠ " + other.name + " が滅亡した"); }
          }
        }
      }
    }
  };

  CivSystem.prototype._maybeFoundTown = function (h, k) {
    if (k.cities.length >= CP.maxSettlements) return;
    const home = this._home(h, k);
    if (home.d2 < CP.newTownDist * CP.newTownDist) return;
    const world = this.world;
    const i = (h.y | 0) * world.width + (h.x | 0);
    const fertile = !world.fertility || world.fertility[i] > 0.3;
    if (world.owner[i] === k.id && fertile && this.rand() < CP.foundRate * this._eff(k, "expand")) {
      k.cities.push({ x: h.x | 0, y: h.y | 0, capital: false, level: 1, buildings: [] });
    }
  };

  Game.CivSystem = CivSystem;
  Game.ROLE = ROLE;
  // 描画の年齢段階（子供/老人）と一致させるための閾値。
  Game.lifeStages = { adult: CP.adultAge, elder: CP.elderAge };
})(window.Game);
