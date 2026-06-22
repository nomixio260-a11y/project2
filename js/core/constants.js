// 地形タイプ・カラー・地形名の定義。
(function (Game) {
  "use strict";

  // 地形 enum（Uint8Array に格納される値）。
  // 標高順に並べておくと raise/lower の段階移動がしやすい。
  Game.TERRAIN = {
    DEEP_WATER: 0,
    SHALLOW_WATER: 1,
    SAND: 2,
    GRASS: 3,
    FOREST: 4,
    HILL: 5,
    MOUNTAIN: 6,
    SNOW: 7,
    SCORCHED: 8, // 破壊ツールの焼け地
    // バイオーム強化（既存値 0..8 は固定し末尾に追加）。
    DESERT: 9,
    SAVANNA: 10,
    SWAMP: 11,
    TUNDRA: 12,
    JUNGLE: 13,
  };

  // 戦略資源（world.resource に格納）。文明の経済・技術・軍備に影響する。
  Game.RESOURCE = {
    NONE: 0,
    ORE: 1,   // 鉱石（丘・山）: 技術と武具を強化
    FISH: 2,  // 漁場（沿岸の浅瀬）: 食料を増やし人口扶養力を高める
    GEMS: 3,  // 宝石（稀少な丘・山）: 富を生む
  };

  const T = Game.TERRAIN;

  // 各地形の色。renderer がそのまま fillStyle に使う。
  Game.TERRAIN_COLORS = {
    [T.DEEP_WATER]: "#16335f",
    [T.SHALLOW_WATER]: "#2f6fb0",
    [T.SAND]: "#d8cb8e",
    [T.GRASS]: "#5aa64f",
    [T.FOREST]: "#2f7236",
    [T.HILL]: "#8a8a5a",
    [T.MOUNTAIN]: "#6f6a64",
    [T.SNOW]: "#eef3f7",
    [T.SCORCHED]: "#3a3330",
    [T.DESERT]: "#e0c878",
    [T.SAVANNA]: "#bcae5a",
    [T.SWAMP]: "#4a5d3a",
    [T.TUNDRA]: "#9fb0a8",
    [T.JUNGLE]: "#1f5a2a",
  };

  // RGB を事前計算（オフスクリーン ImageData 描画用に高速化）。
  Game.TERRAIN_RGB = {};
  for (const key in Game.TERRAIN_COLORS) {
    const hex = Game.TERRAIN_COLORS[key];
    Game.TERRAIN_RGB[key] = [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  Game.TERRAIN_NAMES = {
    [T.DEEP_WATER]: "深海",
    [T.SHALLOW_WATER]: "浅瀬",
    [T.SAND]: "砂",
    [T.GRASS]: "草原",
    [T.FOREST]: "森",
    [T.HILL]: "丘",
    [T.MOUNTAIN]: "山",
    [T.SNOW]: "雪",
    [T.SCORCHED]: "焼け地",
    [T.DESERT]: "砂漠",
    [T.SAVANNA]: "サバンナ",
    [T.SWAMP]: "湿地",
    [T.TUNDRA]: "ツンドラ",
    [T.JUNGLE]: "ジャングル",
  };
})(window.Game);
