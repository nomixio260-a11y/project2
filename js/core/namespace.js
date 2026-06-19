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
