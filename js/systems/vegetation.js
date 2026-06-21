// 植生・生態系システム。タイルごとの fertility(植生密度) を季節に応じて
// 再成長させ、十分育てば森林化、枯れれば後退、焼け地は徐々に回復する。
// 全タイルを毎ティック走査せず、横帯(band)をローリングで処理して負荷を抑える。
(function (Game) {
  "use strict";

  const T = Game.TERRAIN;
  const tile = Game.tile;

  // 地形ごとの植生容量（0..1）。水・山・雪・砂漠は育ちにくい。
  function baseCapacity(terrain) {
    switch (terrain) {
      case T.JUNGLE: return 0.98;
      case T.FOREST: return 0.92;
      case T.SWAMP: return 0.8;
      case T.GRASS: return 0.7;
      case T.SAVANNA: return 0.6;
      case T.SCORCHED: return 0.55; // 回復する
      case T.SAND: return 0.42; // 湿れば草が侵入
      case T.HILL: return 0.4;
      case T.TUNDRA: return 0.2;
      case T.DESERT: return 0.12;
      default: return 0; // 水・山・雪
    }
  }

  function VegetationSystem(world, renderer) {
    this.world = world;
    this.renderer = renderer;
    this.cursor = 0; // 次に処理する開始行
  }

  VegetationSystem.prototype.setWorld = function (world) {
    this.world = world;
    this.cursor = 0;
  };

  VegetationSystem.prototype.clear = function () {
    this.cursor = 0;
  };

  // 地形から初期 fertility を割り当てる（生成・再生成時に1回）。
  VegetationSystem.prototype.seed = function (world) {
    const f = world.fertility;
    const terr = world.terrain;
    const n = world.width * world.height;
    for (let i = 0; i < n; i++) {
      f[i] = baseCapacity(terr[i]) * 0.85;
    }
  };

  VegetationSystem.prototype.tick = function (world) {
    const cfg = Game.config.sim;
    const th = Game.config.thresholds;
    const W = world.width;
    const H = world.height;
    const f = world.fertility;
    const terr = world.terrain;
    const moist = world.moisture;
    const temp = world.temperature;
    const season = Game.state.clock.season || Game.SEASONS[0];
    const growth = cfg.vegGrowth * season.growth;
    const tOff = season.tempOffset;

    const y0 = this.cursor;
    const y1 = Math.min(H, y0 + cfg.vegBandRows);

    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const t = terr[i];
        const cap = baseCapacity(t);
        if (cap <= 0) continue; // 植生不能タイル

        // 容量へ向けて成長（湿度で容量を変調）。
        const m = moist[i];
        const localCap = cap * (0.55 + 0.45 * m);
        let v = f[i];
        v += (localCap - v) * growth;
        if (v > 1) v = 1; else if (v < 0) v = 0;
        f[i] = v;

        // 体感気温（季節補正込み）。
        const et = temp[i] + tOff;

        // 地形遷移（植生密度と気候に応じた自然変化）。
        let nt = t;
        if (t === T.SCORCHED) {
          if (v > 0.3) nt = T.GRASS; // 焼け地の回復
        } else if (t === T.SAND) {
          // 十分に湿った砂地のみ草地化（乾いた砂浜・砂漠周縁は砂のまま）。
          if (v > 0.55 && m >= th.forestMoisture && et > th.cold && et < th.hot) nt = T.GRASS;
        } else if (t === T.GRASS) {
          if (v > 0.82 && m >= th.forestMoisture && et > th.cold && et < th.hot) nt = T.FOREST;
        } else if (t === T.SAVANNA) {
          if (v > 0.85 && m >= th.jungleMoisture && et > th.hot) nt = T.JUNGLE;
        } else if (t === T.FOREST) {
          if (v < 0.18) nt = T.GRASS; // 立ち枯れ
        } else if (t === T.JUNGLE) {
          if (v < 0.2) nt = T.SAVANNA;
        }

        if (nt !== t) {
          terr[i] = nt;
          if (this.renderer) this.renderer.markDirty(x, y);
        }
      }
    }

    this.cursor = y1 >= H ? 0 : y1;
  };

  // 草食動物が (i) で採食したとき呼ぶ: fertility を消費し、得た量(0..1)を返す。
  VegetationSystem.prototype.graze = function (i) {
    const f = this.world.fertility;
    const have = f[i];
    if (have <= 0.04) return 0;
    const cost = Game.config.sim.vegGrazeCost;
    const eaten = have < cost ? have : cost;
    f[i] = have - eaten;
    return eaten;
  };

  Game.VegetationSystem = VegetationSystem;
})(window.Game);
