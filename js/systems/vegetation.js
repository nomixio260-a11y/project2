// 植生・生態系システム。タイルごとの fertility(植生密度) を季節に応じて
// 再成長させ、十分育てば森林化、枯れれば後退、焼け地は徐々に回復する。
// 全タイルを毎ティック走査せず、横帯(band)をローリングで処理して負荷を抑える。
(function (Game) {
  "use strict";

  const T = Game.TERRAIN;
  const tile = Game.tile;

  // 焼け跡の回復: 灰は養分に富み、パイオニア種が素早く定着する（一時的に成長が速い）。
  const ASH_GROWTH = 2.4; // SCORCHED の成長率倍率（急速な再植生）
  const ASH_CAP = 0.12;   // 灰による一時的な容量上乗せ
  const ASH_MOIST = 0.15; // 回復して草地化したとき、灰が保つ養分（次段階の遷移を後押し）

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
    const clk = Game.state.clock;
    const season = (clk && clk.season) || Game.SEASONS[0];
    const growth = cfg.vegGrowth * season.growth;
    // 長期気候: 多雨は植生容量を上げ、乾燥は枯らす。温暖/寒冷は体感気温を押し引きする。
    const wetness = clk ? (clk.wetness || 0) : 0;
    const warmth = clk ? (clk.warmth || 0) : 0;
    const capClim = 1 + 0.22 * wetness; // 容量への気候補正（多雨で繁茂・乾燥で痩せる）

    const y0 = this.cursor;
    const y1 = Math.min(H, y0 + cfg.vegBandRows);

    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const t = terr[i];
        const cap = baseCapacity(t);
        if (cap <= 0) continue; // 植生不能タイル

        // 容量へ向けて成長（湿度＋長期気候で容量を変調）。
        const m = moist[i];
        let localCap = cap * (0.55 + 0.45 * m) * capClim;
        if (localCap > 1) localCap = 1;
        let v = f[i];
        // 焼け跡は灰の養分でパイオニア種が急速に戻る（一時的肥沃化＝段階的遷移の起点）。
        let gr = growth, lc = localCap;
        if (t === T.SCORCHED) { gr *= ASH_GROWTH; lc = Math.min(1, lc + ASH_CAP); }
        v += (lc - v) * gr;
        if (v > 1) v = 1; else if (v < 0) v = 0;
        f[i] = v;

        // 生物群系の判定には「長期気候」の体感気温を使う（季節の寒暖では生物群系は
        //   変わらない＝毎冬ツンドラ化するような暴走を防ぐ）。季節は成長率にのみ効く。
        //   bt: 基準気温＋長期の温暖/寒冷のうねり。気候のエポックで境界が緩やかに動く。
        const bt = temp[i] + warmth * 0.2;

        // 地形遷移（植生密度と長期気候に応じた自然変化）:
        //   温暖多雨は森林・密林を広げ、寒冷化は凍土を、灼熱乾燥は砂漠を広げる。
        let nt = t;
        if (t === T.SCORCHED) {
          // 段階的回復: まず草地が戻り（灰の養分を残す）、以後の遷移で森へ育ちうる。
          if (v > 0.35) { nt = T.GRASS; moist[i] = Math.min(1, m + ASH_MOIST); }
        } else if (t === T.SAND) {
          // 十分に湿った砂地のみ草地化（乾いた砂浜・砂漠周縁は砂のまま）。
          if (v > 0.55 && m >= th.forestMoisture && bt > th.cold && bt < th.hot) nt = T.GRASS;
        } else if (t === T.GRASS) {
          if (bt < th.cold - 0.04) nt = T.TUNDRA;                           // 寒冷化で凍土へ
          else if (bt > th.hot + 0.02 && m < th.desertMoisture) nt = T.SAVANNA; // 高温乾燥で疎林化
          else if (v > 0.82 && m >= th.forestMoisture && bt < th.hot) nt = T.FOREST;
        } else if (t === T.SAVANNA) {
          if (v > 0.85 && m >= th.jungleMoisture && bt > th.hot) nt = T.JUNGLE;
          else if (v < 0.25 && m < th.desertMoisture && bt > th.hot + 0.02) nt = T.DESERT; // 砂漠化
          else if (bt < th.hot - 0.04 && m >= th.forestMoisture) nt = T.GRASS; // 冷涼・湿潤化で草地へ
        } else if (t === T.FOREST) {
          if (v < 0.18) nt = T.GRASS;                                       // 立ち枯れ
          else if (bt < th.cold - 0.04) nt = T.TUNDRA;                      // 寒冷化
        } else if (t === T.JUNGLE) {
          if (v < 0.2) nt = T.SAVANNA;
        } else if (t === T.DESERT) {
          if (m >= th.forestMoisture && bt < th.hot) nt = T.SAVANNA;        // 緑化（雨で甦る）
        } else if (t === T.TUNDRA) {
          if (bt > th.cold + 0.02) nt = T.GRASS;                            // 温暖化で解ける（植生量は問わない）
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
