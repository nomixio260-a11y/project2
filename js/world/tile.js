// 標高・湿度から地形タイプを決定する分類ロジック。
// worldgen（初期生成）と godpowers（raise/lower 後の再分類）で共有する。
(function (Game) {
  "use strict";

  const T = Game.TERRAIN;

  Game.tile = {
    // elevation, moisture（ともに 0..1）から TERRAIN id を返す。
    classify: function (elevation, moisture) {
      const th = Game.config.thresholds;
      if (elevation < th.deepWater) return T.DEEP_WATER;
      if (elevation < th.shallowWater) return T.SHALLOW_WATER;
      if (elevation < th.sand) return T.SAND;
      if (elevation < th.grass) {
        return moisture >= th.forestMoisture ? T.FOREST : T.GRASS;
      }
      if (elevation < th.hill) return T.HILL;
      if (elevation < th.mountain) return T.MOUNTAIN;
      return T.SNOW;
    },

    // ある地形タイプの「代表的な標高」を返す。
    // grass/forest/mountain ツールが標高をその帯にスナップするのに使う。
    elevationForTerrain: function (terrain) {
      const th = Game.config.thresholds;
      switch (terrain) {
        case T.DEEP_WATER: return th.deepWater * 0.5;
        case T.SHALLOW_WATER: return (th.deepWater + th.shallowWater) * 0.5;
        case T.SAND: return (th.shallowWater + th.sand) * 0.5;
        case T.GRASS:
        case T.FOREST: return (th.sand + th.grass) * 0.5;
        case T.HILL: return (th.grass + th.hill) * 0.5;
        case T.MOUNTAIN: return (th.hill + th.mountain) * 0.5;
        case T.SNOW: return (th.mountain + 1) * 0.5;
        case T.SCORCHED: return (th.sand + th.grass) * 0.5;
        default: return 0.5;
      }
    },
  };
})(window.Game);
