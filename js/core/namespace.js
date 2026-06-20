// グローバル名前空間。全モジュールがここにぶら下がる。
// ES Modules を使わず file:// で動かすための単一エントリ。
window.Game = window.Game || {};

(function (Game) {
  "use strict";

  // 既定設定。worldgen / renderer / camera から参照される。
  Game.config = {
    // マップサイズ（タイル数）
    mapWidth: 512,
    mapHeight: 512,

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
      maxEntities: 4000, // 生物の上限
      maxFires: 6000, // 同時延焼タイルの上限
      maxKingdoms: 64, // 王国数の上限
      claimsPerTick: 40, // 1王国が1ティックに拡張するタイル数の上限
      conflictChance: 0.05, // 国境での領土反転の基本確率
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

  // 実行時の共有状態。main.js が中身を埋める。
  Game.state = {
    world: null,
    camera: null,
    renderer: null,
    engine: null,
    activeToolId: "raise",
    brush: null,
    mouseTile: { x: -1, y: -1 },
  };
})(window.Game);
