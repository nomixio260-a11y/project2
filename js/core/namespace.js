// グローバル名前空間。全モジュールがここにぶら下がる。
// ES Modules を使わず file:// で動かすための単一エントリ。
window.Game = window.Game || {};

(function (Game) {
  "use strict";

  // 既定設定。worldgen / renderer / camera から参照される。
  Game.config = {
    // マップサイズ（タイル数）
    mapWidth: 640,
    mapHeight: 640,

    // 1タイルのベースピクセル（zoom=1.0 のときの見かけ上のサイズ）
    tilePx: 8,

    // ズーム範囲
    minZoom: 0.15,
    maxZoom: 8,

    // 生成シード（再生成で更新される）
    seed: (Math.random() * 1e9) | 0,

    // シミュレーション制御（生物・炎・文明の固定タイムステップ）
    sim: {
      running: true, // 一時停止/再生
      speed: 1, // 速度倍率（0.5/1/2/4）
      tickMs: 100, // 1ティック=シム内100ms（速度1で10tick/秒）
      maxSteps: 5, // 1フレームあたりの最大catch-upティック
      maxEntities: 16000, // 生物の上限
      maxFires: 12000, // 同時延焼タイルの上限
      maxKingdoms: 96, // 王国数の上限
      maxPeople: 1500, // 人間エージェント（文明の主体）の総数上限
      claimsPerTick: 40, // 1王国が1ティックに拡張するタイル数の上限（人口で変調）
      conflictChance: 0.05, // 国境での領土反転の基本確率

      // 気候・季節
      ticksPerDay: 18, // 何ティックで1日進むか
      daysPerSeason: 14, // 1季節の日数（4季=1年）

      // 植生（vegetation）
      vegBandRows: 96, // 1ティックで再成長処理する行数（ローリング走査）
      vegGrowth: 0.11, // 容量へ近づく基本成長率/ティック
      vegGrazeCost: 0.06, // 草食1回の採食で減る fertility

      // 文明（人口）
      popPerTile: 9, // 1タイルあたりの人口容量
      popGrowth: 0.02, // 人口の対数成長率/ティック
      popStart: 12, // 建国時の初期人口

      // 天候
      cloudCount: 5, // 同時に流れる雲の数
      rainMoisture: 0.06, // 降雨で上がる湿度/ティック
      rainFertility: 0.05, // 降雨で上がる植生/ティック
      lightningChance: 0.0009, // 雲ごとの落雷確率/ティック（乾燥地のみ発火）
    },

    // 生成パラメータ
    gen: {
      // 標高ノイズ
      elevationOctaves: 6,
      elevationFrequency: 2.2, // マップ全体に対する基本周波数
      elevationLacunarity: 2.0,
      elevationGain: 0.5,
      // 湿度ノイズ
      moistureOctaves: 4,
      moistureFrequency: 3.5,
      moistureLacunarity: 2.0,
      moistureGain: 0.5,
      // 島マスク（中心ほど標高が高く、端は海に沈む）
      islandMask: true,
      islandStrength: 0.92,
      // 温度（緯度ベース − 標高×lapse + ノイズ）
      temperatureLapse: 0.55, // 標高1あたりの気温低下量
      temperatureNoise: 0.25, // 温度のランダム揺らぎ幅
    },

    // 標高しきい値（0..1）。tile.classify で使用。
    thresholds: {
      deepWater: 0.30,
      shallowWater: 0.40,
      sand: 0.44,
      grass: 0.62, // grass/forest は moisture で分岐
      hill: 0.76,
      mountain: 0.90,
      // それ以上は snow
      // grass 帯で moisture がこの値以上なら forest
      forestMoisture: 0.52,
      // バイオーム分類（温度 0..1）。
      cold: 0.32, // これ未満は寒冷（ツンドラ/雪線低下）
      hot: 0.68, // これ超は高温（砂漠/サバンナ/ジャングル）
      desertMoisture: 0.35, // 高温かつ乾燥なら砂漠
      jungleMoisture: 0.66, // 高温かつ多湿ならジャングル
      swampElevation: 0.50, // 温帯・多湿・低地なら湿地
    },
  };

  // 季節テーブル（climate システムが参照）。
  // tempOffset: 体感気温の季節補正、growth: 植生の成長係数。
  Game.SEASONS = [
    { name: "春", emoji: "🌸", tempOffset: 0.02, growth: 1.05, fireMul: 1.0 },
    { name: "夏", emoji: "☀️", tempOffset: 0.16, growth: 1.35, fireMul: 1.5 },
    { name: "秋", emoji: "🍁", tempOffset: -0.01, growth: 0.7, fireMul: 1.1 },
    { name: "冬", emoji: "❄️", tempOffset: -0.18, growth: 0.25, fireMul: 0.5 },
  ];

  // デバイス判定（読み込み時）。端末ごとに地図サイズ・上限・初期ズームを最適化する。
  Game.device = (function () {
    const nav = typeof navigator !== "undefined" ? navigator : {};
    const touch = ("ontouchstart" in window) || (nav.maxTouchPoints || 0) > 0;
    const w = window.innerWidth || 1280;
    let type = "desktop";
    if (w < 760) type = "phone";
    else if (touch && w < 1200) type = "tablet";
    return {
      type: type, touch: touch,
      isPhone: type === "phone",
      isTablet: type === "tablet",
      isDesktop: type === "desktop",
    };
  })();

  // 端末プロファイル: 地図サイズ・エージェント上限・初期ズーム(表示タイル数)。
  Game.deviceProfiles = {
    phone: { mapW: 384, mapH: 384, maxEntities: 4000, maxFires: 4000, maxPeople: 500, fitTiles: 80 },
    tablet: { mapW: 512, mapH: 512, maxEntities: 8000, maxFires: 8000, maxPeople: 900, fitTiles: 110 },
    desktop: { mapW: 640, mapH: 640, maxEntities: 16000, maxFires: 12000, maxPeople: 1500, fitTiles: 130 },
  };

  // 端末プロファイルを config に反映する（main の boot 冒頭で呼ぶ）。
  Game.applyDeviceProfile = function () {
    const p = Game.deviceProfiles[Game.device.type] || Game.deviceProfiles.desktop;
    Game.config.mapWidth = p.mapW;
    Game.config.mapHeight = p.mapH;
    Game.config.sim.maxEntities = p.maxEntities;
    Game.config.sim.maxFires = p.maxFires;
    Game.config.sim.maxPeople = p.maxPeople;
    Game.config.initialFitTiles = p.fitTiles;
    return p;
  };

  // 実行時の共有状態。main.js が中身を埋める。
  Game.state = {
    world: null,
    camera: null,
    renderer: null,
    engine: null,
    activeToolId: "raise",
    brush: null,
    mouseTile: { x: -1, y: -1 },
    // 気候の時計（climate システムが進める）。
    clock: { tick: 0, day: 0, year: 1, seasonIndex: 0, season: null },
  };
})(window.Game);
