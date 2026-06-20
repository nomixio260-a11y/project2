// 文明シミュレーション（ボトムアップ / 人間主導）。
// 建国 = 入植者(人間)の小集団を置くこと。領土・人口・都市は人間の行動から創発する:
//  - 人間は未開の隣接地を求めて歩き、踏み込んだ陸地を自国領として確保する。
//  - 確保した土地（＝食料・空間）に応じて集落で新たな人間が生まれる。
//  - 遠くまで移った人間は、良い土地で新しい集落を興し、文明が外へ広がる。
//  - 他国領に踏み込むと国境紛争で土地を奪い合う。
// 抽象的な「一定速度の自動拡張」は廃止。territory は人が居る所だけ伸びる。
(function (Game) {
  "use strict";

  const tile = Game.tile;

  // 人間エージェントの挙動パラメータ。
  const CP = {
    popStart: 5,        // 建国時の入植者数
    tilesPerHuman: 5,   // 人間1人が支える土地（人口容量の分母）
    perKingdomCap: 90,  // 1国あたりの人間上限
    spawnRate: 0.06,    // 容量未満のとき出生する確率/ティック
    speed: 0.22,        // 移動速度(タイル/ティック)
    deathRate: 0.0006,  // 自然死の確率/ティック
    tether: 30,         // 集落からこの距離を超えたら戻ろうとする
    conflictChance: 0.06, // 国境1接触あたりの territory 反転確率
    newTownDist: 22,    // 集落からこれ以上離れた良地で新集落を興しうる
    foundRate: 0.015,   // その際の建設確率/ティック
    maxSettlements: 8,  // 1国の集落上限
    seekRange: 2,       // 未開地を探す距離
  };

  function CivSystem(world, renderer) {
    this.world = world;
    this.renderer = renderer;
    this.rand = Game.utils.mulberry32((Game.config.seed ^ 0x5bd1e995) >>> 0);
    // index 0 は「無所属」予約。kingdoms[id] が王国レコード。
    this.kingdoms = [null];
    // 人間エージェント（文明の主体）。{x,y,kid,hx,hy}
    this.people = [];
  }

  CivSystem.prototype.setWorld = function (world) {
    this.world = world;
    this.people.length = 0;
  };

  CivSystem.prototype.clear = function () {
    this.kingdoms = [null];
    this.people.length = 0;
    if (this.world) this.world.owner.fill(0);
  };

  CivSystem.prototype.colorOf = function (id) {
    const k = this.kingdoms[id];
    return k ? k.color : null;
  };

  // 王国名の生成（音節を連結したファンタジー風）。
  const NAME_A = ["Ar", "Bel", "Cor", "Dra", "El", "Fen", "Gor", "Hal", "Ish", "Kor", "Lor", "Mor", "Nor", "Or", "Per", "Quel", "Rho", "Syl", "Tor", "Ul", "Var", "Wyn", "Xan", "Yor", "Zar"];
  const NAME_B = ["a", "e", "i", "o", "u", "ae", "ia", "or", "en", "an"];
  const NAME_C = ["dor", "gard", "heim", "land", "mar", "nia", "ria", "thal", "vale", "wick", "stead", "moor", "fell", "reach"];
  function makeName(rand) {
    return NAME_A[(rand() * NAME_A.length) | 0] +
      NAME_B[(rand() * NAME_B.length) | 0] +
      NAME_C[(rand() * NAME_C.length) | 0];
  }

  // HSL 風に id から鮮やかな色を生成。
  function makeColor(rand) {
    const h = rand() * 360;
    const s = 0.65;
    const l = 0.55;
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

  // (x,y) に建国 = 入植者の集団を置く。陸地かつ無所属のみ。王国IDを返す（失敗時 -1）。
  CivSystem.prototype.foundAt = function (x, y) {
    const world = this.world;
    if (!world.inBounds(x, y)) return -1;
    const i = y * world.width + x;
    if (world.owner[i] !== 0) return -1;
    if (!tile.isLand(world.terrain[i])) return -1;
    if (this.kingdoms.length - 1 >= Game.config.sim.maxKingdoms) return -1;

    const id = this.kingdoms.length;
    const k = {
      id: id,
      name: makeName(this.rand),
      color: makeColor(this.rand),
      cities: [{ x: x, y: y, capital: true }], // 集落（最初は首都）
      tileCount: 1,
      humanCount: 0,
      alive: true,
    };
    this.kingdoms.push(k);
    world.owner[i] = id;
    if (this.renderer) this.renderer.markTerritoryDirty(x, y);
    // 入植者を配置（彼らが歩いて領土を広げる）。
    for (let n = 0; n < CP.popStart; n++) this._spawnHuman(k);
    return id;
  };

  // 集落の近くに人間を1体スポーン。
  CivSystem.prototype._spawnHuman = function (k) {
    if (this.people.length >= Game.config.sim.maxPeople) return;
    if (k.humanCount >= CP.perKingdomCap) return;
    const city = k.cities[(this.rand() * k.cities.length) | 0];
    this.people.push({
      x: city.x + 0.5 + (this.rand() - 0.5) * 2,
      y: city.y + 0.5 + (this.rand() - 0.5) * 2,
      kid: k.id,
      hx: 0,
      hy: 0,
    });
    k.humanCount++;
  };

  // HUD 用の集計（生存王国数・総人口=人間数・都市数）。
  CivSystem.prototype.stats = function () {
    let kingdoms = 0;
    let population = 0;
    let cities = 0;
    for (let id = 1; id < this.kingdoms.length; id++) {
      const k = this.kingdoms[id];
      if (!k || !k.alive) continue;
      kingdoms++;
      population += k.humanCount;
      cities += k.cities.length;
    }
    return { kingdoms: kingdoms, population: population, cities: cities };
  };

  CivSystem.prototype.tick = function (world) {
    const kingdoms = this.kingdoms;
    const rand = this.rand;
    const maxPeople = Game.config.sim.maxPeople;

    // 出生: 確保した土地（容量）に空きがあれば集落で人が生まれる。
    for (let id = 1; id < kingdoms.length; id++) {
      const k = kingdoms[id];
      if (!k || !k.alive) continue;
      const capacity = Math.min(CP.perKingdomCap, Math.max(2, (k.tileCount / CP.tilesPerHuman) | 0));
      if (k.humanCount < capacity && this.people.length < maxPeople && rand() < CP.spawnRate) {
        this._spawnHuman(k);
      }
    }

    // 各人間: 周囲を確保 → 移動（未開地を目指す）→ 新集落 → 自然死。
    const people = this.people;
    for (let p = people.length - 1; p >= 0; p--) {
      const h = people[p];
      const k = kingdoms[h.kid];
      if (!k || !k.alive) { // 王国消滅 → 人も消える
        people[p] = people[people.length - 1];
        people.pop();
        if (k) k.humanCount--;
        continue;
      }
      this._claimAround(h, k, world);
      this._moveHuman(h, k, world);
      this._maybeFoundTown(h, k);
      if (rand() < CP.deathRate) {
        people[p] = people[people.length - 1];
        people.pop();
        k.humanCount--;
      }
    }
  };

  // 人間の足下とその4近傍の陸地を自国領として確保する（敵地は紛争で奪う）。
  CivSystem.prototype._claimAround = function (h, k, world) {
    const W = world.width;
    const H = world.height;
    const owner = world.owner;
    const id = k.id;
    const cx = h.x | 0;
    const cy = h.y | 0;
    for (let n = 0; n < 5; n++) {
      const x = cx + (n === 1 ? -1 : n === 2 ? 1 : 0);
      const y = cy + (n === 3 ? -1 : n === 4 ? 1 : 0);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const ni = y * W + x;
      if (!tile.isLand(world.terrain[ni])) continue;
      const o = owner[ni];
      if (o === id) continue;
      if (o === 0) {
        owner[ni] = id;
        k.tileCount++;
        if (this.renderer) this.renderer.markTerritoryDirty(x, y);
      } else {
        const other = this.kingdoms[o];
        if (other && other.alive && this.rand() < CP.conflictChance) {
          owner[ni] = id;
          k.tileCount++;
          other.tileCount--;
          if (this.renderer) this.renderer.markTerritoryDirty(x, y);
          if (other.tileCount <= 0) other.alive = false;
        }
      }
    }
  };

  // 移動: 近くの未開の陸地（自国フロンティア）へ向かい、無ければ集落へ戻るか徘徊。
  CivSystem.prototype._moveHuman = function (h, k, world) {
    const W = world.width;
    const H = world.height;
    const owner = world.owner;
    const rand = this.rand;

    // 最寄り集落への方向・距離。
    let homeDx = 0;
    let homeDy = 0;
    let homeD2 = 1e9;
    for (let c = 0; c < k.cities.length; c++) {
      const dx = k.cities[c].x + 0.5 - h.x;
      const dy = k.cities[c].y + 0.5 - h.y;
      const d = dx * dx + dy * dy;
      if (d < homeD2) { homeD2 = d; homeDx = dx; homeDy = dy; }
    }

    let mx = 0;
    let my = 0;
    // テザー外なら帰路を優先。
    if (homeD2 > CP.tether * CP.tether) {
      const hd = Math.sqrt(homeD2) || 1;
      mx = homeDx / hd;
      my = homeDy / hd;
    } else {
      // 未開地探索: seekRange の8方向で無所属の陸地を探し、そこへ向かう。
      const r = CP.seekRange;
      const cx = h.x | 0;
      const cy = h.y | 0;
      let bx = 0;
      let by = 0;
      let found = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx * r;
          const ny = cy + dy * r;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (owner[ni] === 0 && tile.isLand(world.terrain[ni])) {
            found++;
            if (rand() < 1 / found) { bx = dx; by = dy; } // reservoir 風に1方向選択
          }
        }
      }
      if (found > 0) {
        const bl = Math.hypot(bx, by) || 1;
        mx = bx / bl;
        my = by / bl;
      } else {
        mx = rand() - 0.5; // 未開地が近くに無ければ徘徊
        my = rand() - 0.5;
      }
    }

    const len = Math.hypot(mx, my) || 1;
    const nxp = h.x + (mx / len) * CP.speed;
    const nyp = h.y + (my / len) * CP.speed;
    const ntx = Game.utils.clamp(nxp | 0, 0, W - 1);
    const nty = Game.utils.clamp(nyp | 0, 0, H - 1);
    if (tile.isLand(world.terrain[nty * W + ntx])) {
      h.hx = nxp - h.x;
      h.hy = nyp - h.y;
      h.x = nxp;
      h.y = nyp;
    }
  };

  // 集落から十分離れた肥沃な土地で、まれに新しい集落を興す（文明の外延）。
  CivSystem.prototype._maybeFoundTown = function (h, k) {
    if (k.cities.length >= CP.maxSettlements) return;
    // 最寄り集落までの距離。
    let d2 = 1e9;
    for (let c = 0; c < k.cities.length; c++) {
      const dx = k.cities[c].x + 0.5 - h.x;
      const dy = k.cities[c].y + 0.5 - h.y;
      const d = dx * dx + dy * dy;
      if (d < d2) d2 = d;
    }
    if (d2 < CP.newTownDist * CP.newTownDist) return;
    const world = this.world;
    const i = (h.y | 0) * world.width + (h.x | 0);
    const fertile = !world.fertility || world.fertility[i] > 0.3;
    if (world.owner[i] === k.id && fertile && this.rand() < CP.foundRate) {
      k.cities.push({ x: h.x | 0, y: h.y | 0, capital: false });
    }
  };

  Game.CivSystem = CivSystem;
})(window.Game);
