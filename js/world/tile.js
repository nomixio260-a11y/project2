// 標高・湿度から地形タイプを決定する分類ロジック。
// worldgen（初期生成）と godpowers（raise/lower 後の再分類）で共有する。
(function (Game) {
  "use strict";

  const T = Game.TERRAIN;

  Game.tile = {
    // elevation, moisture, temperature（いずれも 0..1）から TERRAIN id を返す。
    // temperature 省略時は 0.5（温帯）として扱い、旧2引数呼び出しでも破綻しない。
    classify: function (elevation, moisture, temperature) {
      const th = Game.config.thresholds;
      const t = temperature === undefined ? 0.5 : temperature;

      // 水帯は標高のみで決まる（温度非依存）。
      if (elevation < th.deepWater) return T.DEEP_WATER;
      if (elevation < th.shallowWater) return T.SHALLOW_WATER;
      if (elevation < th.sand) return T.SAND;

      // 陸の低地帯（sand..grass）: 温度×湿度でバイオームを決める。
      if (elevation < th.grass) {
        if (t < th.cold) return T.TUNDRA; // 寒冷地
        if (t > th.hot) {
          // 高温帯: 乾燥→砂漠 / 多湿→ジャングル / 中間→サバンナ
          if (moisture < th.desertMoisture) return T.DESERT;
          if (moisture >= th.jungleMoisture) return T.JUNGLE;
          return T.SAVANNA;
        }
        // 温帯: 多湿の低地は湿地、湿れば森、乾けば草原。
        if (moisture >= th.forestMoisture) {
          if (elevation < th.swampElevation && moisture >= th.jungleMoisture) return T.SWAMP;
          return T.FOREST;
        }
        return T.GRASS;
      }

      // 丘帯。寒冷地では雪線が下がり、丘でも雪になりうる。
      if (elevation < th.hill) {
        if (t < th.cold) return T.SNOW;
        return T.HILL;
      }
      // 山帯。寒冷ほど雪になりやすい（雪線を温度で変調）。
      const snowline = th.mountain - (th.cold - Math.min(t, th.cold)) * 0.4;
      if (elevation < snowline) return T.MOUNTAIN;
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
        case T.FOREST:
        case T.DESERT:
        case T.SAVANNA:
        case T.SWAMP:
        case T.TUNDRA:
        case T.JUNGLE: return (th.sand + th.grass) * 0.5;
        case T.HILL: return (th.grass + th.hill) * 0.5;
        case T.MOUNTAIN: return (th.hill + th.mountain) * 0.5;
        case T.SNOW: return (th.mountain + 1) * 0.5;
        case T.SCORCHED: return (th.sand + th.grass) * 0.5;
        default: return 0.5;
      }
    },
  };
})(window.Game);
