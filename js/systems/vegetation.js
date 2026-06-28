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
    // 水循環の基準湿度: 生成時の気候湿度を「その土地の気候の素地」として保存する。
    //   以後、実際の湿度はこれを基準に降雨と蒸発で動的に増減する。
    world.moistureBase = Float32Array.from(world.moisture);
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

    // 水循環（hydrology）: 各タイルの湿度を、生成時の気候(moistureBase)を基準に、長期気候
    //   と季節・気温による蒸発で緩やかに均衡へ近づける（降雨は weather が上乗せ）。
    let mb = world.moistureBase;
    if (!mb || mb.length !== moist.length) { mb = world.moistureBase = Float32Array.from(moist); }
    const hydroRate = cfg.hydroRate || 0.06;
    const hydroClimW = cfg.hydroClimW || 0.25;
    const evapWarmW = cfg.evapWarmW || 0.5;
    const evapSeasonW = cfg.evapSeasonW || 0.35;
    const seep = cfg.seepMoisture || 0.55;
    const seasonEvap = season ? (season.name === "夏" ? 1 + evapSeasonW : season.name === "冬" ? 1 - evapSeasonW : 1) : 1;

    const y0 = this.cursor;
    const y1 = Math.min(H, y0 + cfg.vegBandRows);

    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const t = terr[i];
        const cap = baseCapacity(t);
        if (cap <= 0) continue; // 植生不能タイル

        // 水循環: 湿度を気候基準へ蒸発・浸透で近づける（降雨は weather が上乗せ）。
        const bt0 = temp[i] + warmth * 0.2;                                  // 体感気温（蒸発の強さ）
        const evapDef = Math.max(0, bt0 - th.cold) * evapWarmW * seasonEvap * 0.35; // 高温・夏ほど乾く
        let target = mb[i] * (1 + hydroClimW * wetness) - evapDef;
        // 水辺の染み出し: 隣接タイルが水なら最低湿度を保つ。
        if ((x > 0 && tile.isWater(terr[i - 1])) || (x < W - 1 && tile.isWater(terr[i + 1])) ||
            (y > 0 && tile.isWater(terr[i - W])) || (y < H - 1 && tile.isWater(terr[i + W]))) {
          if (target < seep) target = seep;
        }
        if (target < 0) target = 0; else if (target > 1) target = 1;
        let m = moist[i] + (target - moist[i]) * hydroRate;
        if (m < 0) m = 0; else if (m > 1) m = 1;
        moist[i] = m;

        // 容量へ向けて成長（湿度＋長期気候で容量を変調）。
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
