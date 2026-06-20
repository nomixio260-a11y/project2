// 神の力（ブラシツール）の registry。
// 各ツール: { id, label, hotkey, swatch(色), apply(world,x,y,falloff) }
// apply は 1タイルへの効果。dirty マークは input 側が行う。
(function (Game) {
  "use strict";

  const T = Game.TERRAIN;
  const C = Game.TERRAIN_COLORS;
  const classify = function (e, m, t) {
    return Game.tile.classify(e, m, t);
  };

  // 地形を直接セットし、標高もその帯にスナップするヘルパ。
  function paintTerrain(world, x, y, terrain) {
    const i = world.idx(x, y);
    world.terrain[i] = terrain;
    world.elevation[i] = Game.tile.elevationForTerrain(terrain);
  }

  const tools = [
    {
      id: "raise",
      label: "隆起",
      hotkey: "1",
      swatch: "#8a8a5a",
      apply: function (world, x, y, falloff) {
        const e = world.raise(x, y, 0.04 * falloff);
        world.setTerrain(x, y, classify(e, world.getMoisture(x, y), world.getTemperature(x, y)));
      },
    },
    {
      id: "lower",
      label: "沈下",
      hotkey: "2",
      swatch: "#2f6fb0",
      apply: function (world, x, y, falloff) {
        const e = world.raise(x, y, -0.04 * falloff);
        world.setTerrain(x, y, classify(e, world.getMoisture(x, y), world.getTemperature(x, y)));
      },
    },
    {
      id: "water",
      label: "水",
      hotkey: "3",
      swatch: C[T.SHALLOW_WATER],
      apply: function (world, x, y) {
        const th = Game.config.thresholds;
        // 海面下へ沈める。中心ほど深く。
        const i = world.idx(x, y);
        world.elevation[i] = th.deepWater * 0.6;
        world.terrain[i] = T.DEEP_WATER;
      },
    },
    {
      id: "sand",
      label: "砂",
      hotkey: "4",
      swatch: C[T.SAND],
      apply: function (world, x, y) {
        paintTerrain(world, x, y, T.SAND);
      },
    },
    {
      id: "grass",
      label: "草原",
      hotkey: "5",
      swatch: C[T.GRASS],
      apply: function (world, x, y) {
        paintTerrain(world, x, y, T.GRASS);
      },
    },
    {
      id: "forest",
      label: "森",
      hotkey: "6",
      swatch: C[T.FOREST],
      apply: function (world, x, y) {
        paintTerrain(world, x, y, T.FOREST);
        world.moisture[world.idx(x, y)] = 0.8;
      },
    },
    {
      id: "mountain",
      label: "山",
      hotkey: "7",
      swatch: C[T.MOUNTAIN],
      apply: function (world, x, y) {
        paintTerrain(world, x, y, T.MOUNTAIN);
      },
    },
    {
      id: "scorch",
      label: "破壊",
      hotkey: "8",
      swatch: C[T.SCORCHED],
      apply: function (world, x, y) {
        // 焼け地化。水中は対象外。
        const i = world.idx(x, y);
        if (world.terrain[i] === T.DEEP_WATER || world.terrain[i] === T.SHALLOW_WATER) return;
        world.terrain[i] = T.SCORCHED;
        world.moisture[i] = 0.05;
      },
    },
  ];

  // id → ツールの索引。
  const byId = {};
  for (const t of tools) byId[t.id] = t;

  Game.godpowers = {
    list: tools,
    get: function (id) {
      return byId[id];
    },
  };
})(window.Game);
