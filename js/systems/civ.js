// 文明・王国シミュレーション。建国 → フロンティアからの領土拡張 → 国境紛争。
// 全タイル走査を避け、各王国の「フロンティア（拡張可能な辺縁タイル）」のみ処理する。
(function (Game) {
  "use strict";

  const tile = Game.tile;

  function CivSystem(world, renderer) {
    this.world = world;
    this.renderer = renderer;
    this.rand = Game.utils.mulberry32((Game.config.seed ^ 0x5bd1e995) >>> 0);
    // index 0 は「無所属」予約。kingdoms[id] が王国レコード。
    this.kingdoms = [null];
    // 可視化用の市民エージェント（領土を歩く人々）。{x,y,kid,hx,hy}
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

  // id から色 [r,g,b] を返す（描画用）。
  CivSystem.prototype.colorOf = function (id) {
    const k = this.kingdoms[id];
    return k ? k.color : null;
  };

  // 王国名の生成（音節を連結したファンタジー風）。
  const NAME_A = ["Ar", "Bel", "Cor", "Dra", "El", "Fen", "Gor", "Hal", "Ish", "Kor", "Lor", "Mor", "Nor", "Or", "Per", "Quel", "Rho", "Syl", "Tor", "Ul", "Var", "Wyn", "Xan", "Yor", "Zar"];
  const NAME_B = ["a", "e", "i", "o", "u", "ae", "ia", "or", "en", "an"];
  const NAME_C = ["dor", "gard", "heim", "land", "mar", "nia", "ria", "thal", "vale", "wick", "stead", "moor", "fell", "reach"];
  function makeName(rand) {
    const a = NAME_A[(rand() * NAME_A.length) | 0];
    const b = NAME_B[(rand() * NAME_B.length) | 0];
    const c = NAME_C[(rand() * NAME_C.length) | 0];
    return a + b + c;
  }

  // HSL 風に id から鮮やかな色を生成。
  function makeColor(rand) {
    const h = rand() * 360;
    const s = 0.65;
    const l = 0.55;
    // HSL→RGB
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

  // (x,y) に建国。陸地かつ無所属のみ。新しい王国IDを返す（失敗時 -1）。
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
      capitalX: x,
      capitalY: y,
      tileCount: 1,
      population: Game.config.sim.popStart,
      peopleCount: 0, // この王国の市民エージェント数
      cities: [{ x: x, y: y, capital: true }],
      nextCityAt: 300, // この領土数で次の都市を建てる
      frontier: [i],
      fhead: 0, // 処理済みフロンティアの先頭位置
      alive: true,
    };
    this.kingdoms.push(k);
    world.owner[i] = id;
    if (this.renderer) this.renderer.markTerritoryDirty(x, y);
    return id;
  };

  // 領土が閾値に達するたびに新都市を建設する（最大6都市）。
  CivSystem.prototype._maybeFoundCity = function (k, x, y) {
    if (k.tileCount < k.nextCityAt || k.cities.length >= 6) return;
    k.cities.push({ x: x, y: y, capital: false });
    k.nextCityAt += 350;
  };

  // HUD 用の集計（生存王国数・総人口・都市数）。
  CivSystem.prototype.stats = function () {
    let kingdoms = 0;
    let population = 0;
    let cities = 0;
    for (let id = 1; id < this.kingdoms.length; id++) {
      const k = this.kingdoms[id];
      if (!k || !k.alive) continue;
      kingdoms++;
      population += k.population;
      cities += k.cities.length;
    }
    return { kingdoms: kingdoms, population: Math.round(population), cities: cities };
  };

  CivSystem.prototype.tick = function (world) {
    const kingdoms = this.kingdoms;
    const owner = world.owner;
    const W = world.width;
    const H = world.height;
    const rand = this.rand;
    const cfg = Game.config.sim;
    const claimsPerTick = cfg.claimsPerTick;
    const conflictChance = cfg.conflictChance;

    for (let id = 1; id < kingdoms.length; id++) {
      const k = kingdoms[id];
      if (!k || !k.alive) continue;

      // 人口の対数成長（容量＝領土数×popPerTile）。領土が縮めば人口も減衰。
      const cap = k.tileCount * cfg.popPerTile;
      k.population += cfg.popGrowth * k.population * (1 - k.population / (cap + 1));
      if (k.population < 1) k.population = 1;

      // 拡張予算は人口規模で変調（大国ほど速く広がる）。
      const budget = Math.min(claimsPerTick, 2 + ((k.population / 25) | 0));

      let claims = 0;
      const frontier = k.frontier;

      while (claims < budget && k.fhead < frontier.length) {
        const fi = frontier[k.fhead];
        const x = fi % W;
        const y = (fi / W) | 0;
        let stillFrontier = false;

        // 4近傍を見て、拡張・紛争。
        const nb = [
          x > 0 ? fi - 1 : -1,
          x < W - 1 ? fi + 1 : -1,
          y > 0 ? fi - W : -1,
          y < H - 1 ? fi + W : -1,
        ];
        for (let n = 0; n < 4; n++) {
          const ni = nb[n];
          if (ni < 0) continue;
          const o = owner[ni];
          if (o === id) continue;
          if (!tile.isLand(world.terrain[ni])) continue;

          if (o === 0) {
            // 無所属の陸地を領有。
            owner[ni] = id;
            k.tileCount++;
            frontier.push(ni);
            if (this.renderer) this.renderer.markTerritoryDirty(ni % W, (ni / W) | 0);
            this._maybeFoundCity(k, ni % W, (ni / W) | 0);
            claims++;
            stillFrontier = true;
            if (claims >= budget) break;
          } else {
            // 他国の領土 → 人口比に応じて確率的に奪う。
            const other = kingdoms[o];
            if (other && other.alive) {
              const ratio = k.population / (k.population + other.population + 1);
              if (rand() < conflictChance * ratio) {
                owner[ni] = id;
                k.tileCount++;
                other.tileCount--;
                other.population *= 0.985; // 領土喪失で人口減
                frontier.push(ni);
                if (this.renderer) this.renderer.markTerritoryDirty(ni % W, (ni / W) | 0);
                claims++;
                stillFrontier = true;
                if (other.tileCount <= 0) other.alive = false;
                if (claims >= budget) break;
              } else {
                stillFrontier = true; // 隣に敵がいる限りフロンティア
              }
            }
          }
        }

        if (!stillFrontier) {
          k.fhead++; // このタイルはもう拡張先が無い
        } else if (claims >= budget) {
          break; // 上限。続きは次ティック。
        } else {
          k.fhead++; // 拡張済み。次のフロンティアへ。
        }
      }
    }

    this._tickPeople();
  };

  // 市民エージェントの増減と移動。人口に応じて各国に数人を配置し、
  // 都市の周りを歩かせる（純粋に可視化用。重い生態シミュレーションには含めない）。
  CivSystem.prototype._tickPeople = function () {
    const world = this.world;
    const W = world.width;
    const H = world.height;
    const kingdoms = this.kingdoms;
    const people = this.people;
    const rand = this.rand;
    const maxPeople = Game.config.sim.maxPeople;

    // スポーン: 各国の目標人数に満たなければ確率的に追加。
    for (let id = 1; id < kingdoms.length; id++) {
      const k = kingdoms[id];
      if (!k || !k.alive) continue;
      const target = Math.min(6, 1 + ((k.population / 2500) | 0));
      if (k.peopleCount < target && people.length < maxPeople && rand() < 0.25) {
        const city = k.cities[(rand() * k.cities.length) | 0];
        people.push({ x: city.x + 0.5, y: city.y + 0.5, kid: id, hx: 0, hy: 0 });
        k.peopleCount++;
      }
    }

    // 移動: 最寄りの都市へ緩く引き寄せつつランダムウォーク。陸地のみ。
    for (let p = people.length - 1; p >= 0; p--) {
      const person = people[p];
      const k = kingdoms[person.kid];
      if (!k || !k.alive) {
        // 王国消滅 → 市民も消える。
        people[p] = people[people.length - 1];
        people.pop();
        if (k) k.peopleCount--;
        continue;
      }
      // 最寄り都市方向。
      let cx = person.x;
      let cy = person.y;
      let bestD = 1e9;
      for (let c = 0; c < k.cities.length; c++) {
        const dx = k.cities[c].x + 0.5 - person.x;
        const dy = k.cities[c].y + 0.5 - person.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; cx = dx; cy = dy; }
      }
      // 都市が遠いほど引き寄せを強める。
      const pull = bestD > 36 ? 0.6 : 0.12;
      let mx = (rand() - 0.5) + (bestD > 1 ? cx / Math.sqrt(bestD) : 0) * pull;
      let my = (rand() - 0.5) + (bestD > 1 ? cy / Math.sqrt(bestD) : 0) * pull;
      const len = Math.hypot(mx, my) || 1;
      const sp = 0.22;
      const nxp = person.x + (mx / len) * sp;
      const nyp = person.y + (my / len) * sp;
      const ntx = Game.utils.clamp(nxp | 0, 0, W - 1);
      const nty = Game.utils.clamp(nyp | 0, 0, H - 1);
      if (tile.isLand(world.terrain[nty * W + ntx])) {
        person.hx = nxp - person.x;
        person.hy = nyp - person.y;
        person.x = nxp;
        person.y = nyp;
      }
    }
  };

  Game.CivSystem = CivSystem;
})(window.Game);
