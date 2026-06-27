// 炎の延焼シミュレーション。全タイル走査を避けるため
// 「燃焼中タイルの集合（active set）」だけを毎ティック処理する。
// tick(world): 進行・延焼・燃え尽き。update(dt): グローのアニメ位相。
(function (Game) {
  "use strict";

  const T = Game.TERRAIN;
  const tile = Game.tile;

  // 燃焼パラメータ。
  const BURN_MAX = 120; // これに達したら焼け地化
  const RATE_MIN = 8;
  const RATE_MAX = 16;
  // 地形ごとの延焼しやすさ（隣接タイルが着火する確率）。
  // 草原は延焼しにくく（自然鎮火しやすい）、森・ジャングルは燃え広がる。
  // 草原を低くすることで「大陸全体が燃え続ける」暴走を防ぐ。
  function spreadProb(terrain) {
    switch (terrain) {
      case T.JUNGLE: return 0.15;
      case T.FOREST: return 0.13;
      case T.SAVANNA: return 0.035;
      case T.GRASS: return 0.02;
      default: return 0;
    }
  }

  function FireSystem(world, renderer) {
    this.world = world;
    this.renderer = renderer;
    this.burn = new Uint8Array(world.width * world.height); // 0=非燃焼, 1..=進行度
    this.active = []; // 燃焼中タイルの flat index
    this.rand = Game.utils.mulberry32((Game.config.seed ^ 0x00c0ffee) >>> 0);
    this.phase = 0; // グローのアニメ位相(ms)
  }

  FireSystem.prototype.setWorld = function (world) {
    this.world = world;
    if (this.burn.length !== world.width * world.height) {
      this.burn = new Uint8Array(world.width * world.height);
    } else {
      this.burn.fill(0);
    }
    this.active.length = 0;
  };

  FireSystem.prototype.clear = function () {
    this.burn.fill(0);
    this.active.length = 0;
  };

  // (x,y) を着火。可燃地形のみ。集合へ追加。
  FireSystem.prototype.ignite = function (x, y) {
    const world = this.world;
    if (!world.inBounds(x, y)) return false;
    const i = y * world.width + x;
    if (this.burn[i] !== 0) return false;
    if (!tile.isFlammable(world.terrain[i])) return false;
    if (this.active.length >= Game.config.sim.maxFires) return false;
    this.burn[i] = 1;
    this.active.push(i);
    return true;
  };

  // 内部用: 延焼先の着火（next 配列へ積む）。
  FireSystem.prototype._igniteInto = function (i, next) {
    if (this.burn[i] !== 0) return;
    if (!tile.isFlammable(this.world.terrain[i])) return;
    if (next.length >= Game.config.sim.maxFires) return;
    this.burn[i] = 1;
    next.push(i);
  };

  FireSystem.prototype.tick = function (world) {
    const cur = this.active;
    if (cur.length === 0) return;
    const burn = this.burn;
    const rand = this.rand;
    const W = world.width;
    const H = world.height;
    const maxFires = Game.config.sim.maxFires;
    const next = [];

    // パス1: 進行と燃え尽き判定（生存タイルを next へ）。
    for (let k = 0; k < cur.length; k++) {
      const i = cur[k];
      if (burn[i] === 0) continue; // 既に消火済み
      burn[i] = Math.min(255, burn[i] + (RATE_MIN + ((rand() * (RATE_MAX - RATE_MIN)) | 0)));
      if (burn[i] >= BURN_MAX) {
        world.terrain[i] = T.SCORCHED;
        world.moisture[i] = 0.05;
        burn[i] = 0;
        if (this.renderer) this.renderer.markDirty(i % W, (i / W) | 0);
      } else {
        next.push(i); // 燃焼継続
      }
    }

    // 延焼の環境補正（季節・長期気候・卓越風）。火は風下へ広がりやすい。
    const clk = Game.state.clock;
    const season = clk && clk.season;
    const seasonMul = season ? season.fireMul : 1;
    const wetness = clk ? (clk.wetness || 0) : 0;
    const warmth = clk ? (clk.warmth || 0) : 0;
    const climMul = (1 - 0.45 * wetness) * (1 + 0.25 * Math.max(0, warmth)); // 乾燥・温暖でよく燃える
    const wind = Game.state.wind;
    const wx = wind ? wind.x : 0, wy = wind ? wind.y : 0;
    const envMul = seasonMul * (climMul > 0 ? climMul : 0);

    // パス2: 延焼（生存タイル数を含めて maxFires を超えないよう制限）。
    for (let k = 0; k < cur.length && next.length < maxFires; k++) {
      const i = cur[k];
      const x = i % W;
      const y = (i / W) | 0;
      // 風下（風向と一致する向き）ほど延焼しやすく、風上は燃え広がりにくい。
      if (x > 0) this._maybeSpread(i - 1, next, rand, -wx, envMul);
      if (x < W - 1) this._maybeSpread(i + 1, next, rand, wx, envMul);
      if (y > 0) this._maybeSpread(i - W, next, rand, -wy, envMul);
      if (y < H - 1) this._maybeSpread(i + W, next, rand, wy, envMul);
    }

    this.active = next;
  };

  // dirDot: 延焼方向と卓越風の内積（+で風下, −で風上）。envMul: 季節×気候の補正。
  FireSystem.prototype._maybeSpread = function (ni, next, rand, dirDot, envMul) {
    if (this.burn[ni] !== 0) return;
    const terr = this.world.terrain[ni];
    let p = spreadProb(terr);
    if (p === 0) return;
    p *= (envMul == null ? 1 : envMul);
    // 卓越風: 風下は燃え移りやすく(最大+60%)、風上は鎮まる(最大-40%)。
    if (dirDot) p *= 1 + 0.5 * dirDot;
    // 乾燥（低 fertility）ほどよく燃える。
    const f = this.world.fertility;
    if (f) p *= 0.7 + 0.6 * (1 - f[ni]);
    if (p > 0 && rand() < p) this._igniteInto(ni, next);
  };

  // 毎フレーム: グローのアニメ位相を進める（一時停止中も揺らぐ）。
  FireSystem.prototype.update = function (dt) {
    this.phase += dt;
  };

  Game.FireSystem = FireSystem;
})(window.Game);
