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

  const ROLE = { EXPLORER: 0, FARMER: 1, BUILDER: 2, SOLDIER: 3 };

  const CP = {
    popStart: 5,
    tilesPerHuman: 6,    // 人口容量の分母（確保した土地 / これ）
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
    tether: 34,
    seekRange: 3,
    conflictChance: 0.06,
    newTownDist: 22,
    foundRate: 0.02,
    maxSettlements: 10,
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
  };

  const RULER_NAMES = ["Alaric", "Brana", "Cedric", "Dara", "Eirik", "Freya", "Galen", "Hilda", "Ivar", "Juno", "Kael", "Lyra", "Magnus", "Nadia", "Osric", "Petra", "Rurik", "Sigrid", "Tarek", "Ulla", "Viktor", "Wrenn"];
  const GOV_TYPES = ["君主制", "共和制", "部族連合", "神権制", "氏族制"];
  const RELIGIONS = ["太陽信仰", "月の教団", "大地母神", "風の精霊", "祖霊崇拝", "星辰教"];
  const ERAS = ["石器時代", "青銅器時代", "鉄器時代", "古典時代", "中世", "啓蒙時代"];
  const TECH_PER_ERA = 60;

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
    // 近傍探索グリッド。
    this._cap = Game.config.sim.maxPeople;
    this._next = new Int32Array(this._cap);
    this._head = null;
    this._gw = 0;
    this._gh = 0;
  }

  CivSystem.prototype.setWorld = function (world) {
    this.world = world;
    this.people.length = 0;
    this._births.length = 0;
  };

  CivSystem.prototype.clear = function () {
    this.kingdoms = [null];
    this.people.length = 0;
    this._births.length = 0;
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
    const k = {
      id: id,
      name: makeName(this.rand),
      ruler: RULER_NAMES[(this.rand() * RULER_NAMES.length) | 0],
      gov: GOV_TYPES[(this.rand() * GOV_TYPES.length) | 0],
      color: makeColor(this.rand),
      cities: [{ x: x, y: y, capital: true, level: 1 }],
      tileCount: 1,
      humanCount: 0,
      roleCount: [0, 0, 0, 0],
      clanSeq: 0,
      relations: {}, // 既知の他国 id → 関係値(-100..100)
      wars: {},      // 交戦中の id → true
      allies: {},    // 同盟中の id → true
      tech: 0,       // 技術力（時代の指標）
      religion: RELIGIONS[(this.rand() * RELIGIONS.length) | 0],
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
      gx: x, gy: y,
      repro: CP.reproCooldown, social: 0, alive: true,
    });
    return true;
  };

  // 王国の現状に応じて職業を割り当てる（農民を一定割合確保）。
  CivSystem.prototype._assignRole = function (k) {
    const total = k.humanCount + 1;
    if (k.roleCount[ROLE.FARMER] / total < 0.45) return ROLE.FARMER;
    const r = this.rand();
    if (r < 0.5) return ROLE.EXPLORER;
    if (r < 0.75) return ROLE.SOLDIER;
    return ROLE.BUILDER;
  };

  CivSystem.prototype._spawnHuman = function (k, x, y, clan, role, food) {
    if (this.people.length + this._births.length >= Game.config.sim.maxPeople) return null;
    if (k.humanCount >= CP.perKingdomCap) return null;
    const h = {
      x: x, y: y, hx: 0, hy: 0,
      kid: k.id, clan: clan,
      age: 0, food: food,
      role: role, state: 0,
      gx: x, gy: y,        // 現在の目標タイル
      repro: CP.reproCooldown,
      social: 0,
      alive: true,
    };
    k.humanCount++;
    k.roleCount[role]++;
    return h;
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
    let count = 0, best = null, bestD = r2;
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
              else if (m === 2 && d < bestD) { bestD = d; best = o; }
            }
          }
          i = next[i];
        }
      }
    }
    return { count: count, best: best };
  };

  CivSystem.prototype.tick = function (world) {
    this._tickN++;
    const tN = this._tickN;
    const people = this.people;
    const kingdoms = this.kingdoms;
    const rand = this.rand;

    this._buildGrid();

    for (let i = 0; i < people.length; i++) {
      const h = people[i];
      if (!h.alive) continue;

      // 放浪者（無所属）: 集まり、やがて国を興す。
      if (h.kid === 0) { this._tickNomad(h, world, tN, i); continue; }

      const k = kingdoms[h.kid];
      if (!k || !k.alive) { h.alive = false; continue; }

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
      // 足下タイルだけ確保（5タイル走査は思考時に行う）。
      const o0 = world.owner[ti];
      if (o0 === 0) {
        if (tile.isLand(terr)) { world.owner[ti] = h.kid; k.tileCount++; if (this.renderer) this.renderer.markTerritoryDirty(tx, ty); }
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

      // 死亡（餓死・老衰）。
      if (h.food <= 0 || h.age > CP.maxAge) {
        h.alive = false;
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

    // 外交（間引いて評価）。
    if ((tN % CP.diploInterval) === 0) this._diplomacy();
  };

  // ===== 外交（国システム）=====
  CivSystem.prototype._contact = function (a, b) {
    if (a === b || a === 0 || b === 0) return;
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    if (!ka || !kb || !ka.alive || !kb.alive) return;
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

  CivSystem.prototype._declareWar = function (a, b) {
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    ka.wars[b] = true; kb.wars[a] = true;
    delete ka.allies[b]; delete kb.allies[a];
    this._setRel(a, b, -80);
  };

  CivSystem.prototype._makePeace = function (a, b) {
    delete this.kingdoms[a].wars[b];
    delete this.kingdoms[b].wars[a];
    this._setRel(a, b, -10);
  };

  CivSystem.prototype._formAlliance = function (a, b) {
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    ka.allies[b] = true; kb.allies[a] = true;
    delete ka.wars[b]; delete kb.wars[a];
    this._setRel(a, b, 70);
  };

  // イベント駆動の外交評価。関係値を「傾き」として開戦・同盟・講和の確率を変調する。
  CivSystem.prototype._diplomacy = function () {
    const ks = this.kingdoms;
    // 技術の進歩（都市数と人口に比例）。
    for (let a = 1; a < ks.length; a++) {
      const ka = ks[a];
      if (!ka || !ka.alive) continue;
      ka.tech += ka.cities.length * 0.5 + ka.humanCount * 0.01;
    }
    for (let a = 1; a < ks.length; a++) {
      const ka = ks[a];
      if (!ka || !ka.alive) continue;
      for (const bStr in ka.relations) {
        const b = +bStr;
        if (b <= a) continue;
        const kb = ks[b];
        if (!kb || !kb.alive) continue;
        const rel = ka.relations[b];

        // 文化的影響: 国力が大きく上回る国の宗教が、弱い国へ広まる。
        if (ka.religion !== kb.religion) {
          if (ka.humanCount > kb.humanCount * 2 && this.rand() < 0.12) kb.religion = ka.religion;
          else if (kb.humanCount > ka.humanCount * 2 && this.rand() < 0.12) ka.religion = kb.religion;
        }

        if (ka.wars[b]) {
          // 講和（戦争が長引くほど起きやすい近似として固定確率）。
          if (this.rand() < CP.peaceChance) this._makePeace(a, b);
        } else if (ka.allies[b]) {
          if (this.rand() < 0.05) { delete ka.allies[b]; delete kb.allies[a]; this._setRel(a, b, 10); }
        } else {
          // 関係が悪いほど開戦、良いほど同盟しやすい。
          const warP = 0.09 + (rel < 0 ? (-rel / 100) * 0.25 : 0);
          const allyP = 0.05 + (rel > 0 ? (rel / 100) * 0.2 : 0);
          const r = this.rand();
          if (r < warP) this._declareWar(a, b);
          else if (r < warP + allyP) this._formAlliance(a, b);
          else this._setRel(a, b, rel + (this.rand() * 8 - 4)); // 平時のゆらぎ
        }
      }
    }
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
    h.gx = k.cities[0].x; h.gy = k.cities[0].y;
    h.repro = CP.reproCooldown;
    h.social = 0;
    k.humanCount++;
    k.roleCount[h.role]++;
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
      o.gx = tx; o.gy = ty;
      o.repro = CP.reproCooldown;
      o.social = 0;
      k.humanCount++;
      k.roleCount[o.role]++;
    }
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

  // 4近傍の無所属の陸地を確保する（足下は毎ティック処理済み）。思考時のみ呼ぶ。
  CivSystem.prototype._claimNeighbors = function (h, k, world) {
    const W = world.width, H = world.height, owner = world.owner, id = k.id;
    const cx = h.x | 0, cy = h.y | 0;
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

    const home = this._home(h, k);

    // 1) 強い空腹 → 近くの可食地へ。
    if (h.food < 0.4) {
      const t = this._nearestTile(h, world, 5, function (terr) { return tile.isEdible(terr); });
      if (t) { h.gx = t.x; h.gy = t.y; h.state = 1; return; }
    }
    // 2) 孤独 → 同胞のもとへ集まる。
    if (h.social > 1) {
      const soc = this._scan(h.x, h.y, CP.socialRadius, function (o) { return o.kid === h.kid ? 1 : 0; });
      if (soc.count >= CP.socialNeed) h.social = 0;
      else { h.gx = k.cities[0].x; h.gy = k.cities[0].y; h.state = 2; return; }
    }
    // 3) テザー外 → 帰路。
    if (home.d2 > CP.tether * CP.tether) {
      h.gx = (h.x + home.dx) | 0; h.gy = (h.y + home.dy) | 0; h.state = 3; return;
    }

    // 4) 役割ごとの目的地・判断。
    if (h.role === ROLE.SOLDIER) {
      // 交戦中の敵だけを標的にする（平時は警邏）。
      const e = this._scan(h.x, h.y, 9, function (o) {
        return (o.kid !== h.kid && o.kid !== 0 && self._atWar(h.kid, o.kid)) ? 2 : 0;
      }).best;
      h._enemy = e;
      if (e) { h.gx = e.x | 0; h.gy = e.y | 0; h.state = 5; return; }
      const t = this._nearestTile(h, world, 6, function (terr, ow) {
        return ow !== 0 && ow !== h.kid && self._atWar(h.kid, ow);
      });
      if (t) { h.gx = t.x; h.gy = t.y; h.state = 5; return; }
      h.gx = k.cities[0].x; h.gy = k.cities[0].y; h.state = 5; return; // 警邏
    }
    if (h.role === ROLE.EXPLORER) {
      this._maybeFoundTown(h, k); // 遠地で新集落
      const t = this._nearestTile(h, world, CP.seekRange + 1, function (terr, ow) { return ow === 0 && tile.isLand(terr); });
      if (t) { h.gx = t.x; h.gy = t.y; h.state = 4; return; }
      h.gx = (h.x + (this.rand() - 0.5) * 8) | 0;
      h.gy = (h.y + (this.rand() - 0.5) * 8) | 0;
      h.state = 4; return;
    }
    if (h.role === ROLE.BUILDER) {
      if (home.d2 < 4) {
        // 集落を発展させる。
        if (this.rand() < 0.1) {
          for (let c = 0; c < k.cities.length; c++) {
            const dx = k.cities[c].x + 0.5 - h.x, dy = k.cities[c].y + 0.5 - h.y;
            if (dx * dx + dy * dy < 4 && k.cities[c].level < 6) { k.cities[c].level++; break; }
          }
        }
      } else {
        this._maybeFoundTown(h, k);
      }
      h.gx = k.cities[0].x; h.gy = k.cities[0].y; h.state = 6; return;
    }
    // FARMER（既定）: 肥沃地に留まり耕作。
    const t = this._nearestTile(h, world, 4, function (terr) { return tile.isEdible(terr); });
    if (t) { h.gx = t.x; h.gy = t.y; } else { h.gx = h.x | 0; h.gy = h.y | 0; }
    h.state = 7;
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
    const capacity = Math.min(CP.perKingdomCap, Math.max(2, (k.tileCount / CP.tilesPerHuman) | 0));
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
    let mx = h.gx + 0.5 - h.x;
    let my = h.gy + 0.5 - h.y;
    const d = Math.hypot(mx, my);
    if (d < 0.5) { // 目標到達 → 軽く徘徊
      mx = this.rand() - 0.5; my = this.rand() - 0.5;
    } else { mx /= d; my /= d; }
    const nxp = h.x + mx * CP.speed;
    const nyp = h.y + my * CP.speed;
    const ntx = Game.utils.clamp(nxp | 0, 0, W - 1);
    const nty = Game.utils.clamp(nyp | 0, 0, H - 1);
    if (tile.isLand(world.terrain[nty * W + ntx])) {
      h.hx = nxp - h.x; h.hy = nyp - h.y;
      h.x = nxp; h.y = nyp;
    } else {
      h.hx = 0; h.hy = 0;
    }
  };

  // 役割の局所効果（毎ティックだが探索なし＝低負荷）。ti は足下のタイル index。
  CivSystem.prototype._roleTick = function (h, k, world, ti) {
    if (h.role === ROLE.FARMER) {
      // 耕作: 足下の fertility を高め、土地を肥やす。
      if (world.fertility && tile.isLand(world.terrain[ti])) {
        const f = world.fertility[ti] + CP.cultivate;
        world.fertility[ti] = f > 1 ? 1 : f;
      }
      return;
    }
    if (h.role === ROLE.SOLDIER) {
      // 思考時にキャッシュした敵が隣接していれば攻撃（探索不要）。
      const e = h._enemy;
      if (e && e.alive && this._atWar(h.kid, e.kid)) {
        const dx = e.x - h.x, dy = e.y - h.y;
        if (dx * dx + dy * dy < 2.25) { e.food -= CP.attack; if (e.food < 0) e.food = 0; }
      } else {
        h._enemy = null;
      }
      // 征服: 足下が交戦国の前線タイルのときだけ奪う（探索は隣接4のみ）。
      const o = world.owner[ti];
      if (o !== 0 && o !== h.kid && this._atWar(h.kid, o)) {
        const other = this.kingdoms[o];
        if (other && other.alive) {
          const tx = h.x | 0, ty = h.y | 0;
          if (this._adjacentOwner(world, tx, ty, h.kid) && this.rand() < CP.conflictChance) {
            world.owner[ti] = h.kid; k.tileCount++; other.tileCount--;
            if (this.renderer) this.renderer.markTerritoryDirty(tx, ty);
            if (other.tileCount <= 0) other.alive = false;
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
    if (world.owner[i] === k.id && fertile && this.rand() < CP.foundRate) {
      k.cities.push({ x: h.x | 0, y: h.y | 0, capital: false, level: 1 });
    }
  };

  Game.CivSystem = CivSystem;
  Game.ROLE = ROLE;
})(window.Game);
