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
  function spreadProb(terrain) {
    switch (terrain) {
      case T.JUNGLE: return 0.22;
      case T.FOREST: return 0.2;
      case T.SAVANNA: return 0.11;
      case T.GRASS: return 0.1;
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

    // パス2: 延焼（生存タイル数を含めて maxFires を超えないよう制限）。
    for (let k = 0; k < cur.length && next.length < maxFires; k++) {
      const i = cur[k];
      const x = i % W;
      const y = (i / W) | 0;
      if (x > 0) this._maybeSpread(i - 1, next, rand);
      if (x < W - 1) this._maybeSpread(i + 1, next, rand);
      if (y > 0) this._maybeSpread(i - W, next, rand);
      if (y < H - 1) this._maybeSpread(i + W, next, rand);
    }

    this.active = next;
  };

  FireSystem.prototype._maybeSpread = function (ni, next, rand) {
    if (this.burn[ni] !== 0) return;
    const terr = this.world.terrain[ni];
    const p = spreadProb(terr);
    if (p === 0) return;
    if (rand() < p) this._igniteInto(ni, next);
  };

  // 毎フレーム: グローのアニメ位相を進める（一時停止中も揺らぐ）。
  FireSystem.prototype.update = function (dt) {
    this.phase += dt;
  };

  Game.FireSystem = FireSystem;
})(window.Game);
