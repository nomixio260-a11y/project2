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
      id: "ignite",
      label: "着火",
      hotkey: "8",
      group: "disaster",
      swatch: "#ff6a1f",
      apply: function (world, x, y) {
        const i = world.idx(x, y);
        const t = world.terrain[i];
        const fire = Game.state.fire;
        if (fire && Game.tile.isFlammable(t)) {
          fire.ignite(x, y); // 可燃地形は延焼する炎を着火
        } else if (!Game.tile.isWater(t)) {
          // 不燃地形は即焼け地化（水中は対象外）。
          world.terrain[i] = T.SCORCHED;
          world.moisture[i] = 0.05;
        }
      },
    },
    {
      id: "herbivore",
      label: "草食",
      hotkey: "9",
      group: "life",
      swatch: "#f2e3b0",
      apply: function (world, x, y, falloff) {
        // 確率ゲートで間引き（陸地のみ）。
        if (Math.random() > 0.12 * falloff) return;
        const ent = Game.state.entities;
        if (!ent) return;
        if (!Game.tile.isLand(world.getTerrain(x, y))) return;
        ent.spawn(Game.SPECIES.HERBIVORE, x + 0.5, y + 0.5, 0.7);
      },
    },
    {
      id: "predator",
      label: "肉食",
      hotkey: "0",
      group: "life",
      swatch: "#d83a3a",
      apply: function (world, x, y, falloff) {
        if (Math.random() > 0.08 * falloff) return;
        const ent = Game.state.entities;
        if (!ent) return;
        if (!Game.tile.isLand(world.getTerrain(x, y))) return;
        ent.spawn(Game.SPECIES.PREDATOR, x + 0.5, y + 0.5, 0.7);
      },
    },
    {
      id: "human",
      label: "人間",
      hotkey: "k",
      group: "civ",
      swatch: "#e8c8a0",
      apply: function (world, x, y, falloff) {
        // 放浪者（無所属の人間）を撒く。集まって自ら国を興す。
        if (Math.random() > 0.16 * falloff) return;
        const civ = Game.state.civ;
        if (!civ) return;
        if (!Game.tile.isLand(world.getTerrain(x, y))) return;
        civ.spawnNomad(x, y);
      },
    },
    {
      id: "fertilize",
      label: "豊穣",
      hotkey: "r",
      group: "life",
      swatch: "#7ec850",
      apply: function (world, x, y) {
        // 植生を活性化（湿度と fertility を底上げ）。森林化を促す。
        const i = world.idx(x, y);
        if (Game.tile.isWater(world.terrain[i])) return;
        world.moisture[i] = Math.min(1, world.moisture[i] + 0.25);
        if (world.fertility) world.fertility[i] = Math.min(1, world.fertility[i] + 0.5);
        if (world.terrain[i] === T.SCORCHED || world.terrain[i] === T.SAND) {
          world.terrain[i] = T.GRASS;
        }
      },
    },
    {
      id: "earthquake",
      label: "地震",
      hotkey: "e",
      group: "disaster",
      swatch: "#a87b4a",
      apply: function (world, x, y, falloff) {
        // 標高をランダムに揺らし、地形を再分類（山が崩れ谷が裂ける）。
        const i = world.idx(x, y);
        const jolt = (Math.random() - 0.5) * 0.35 * falloff;
        const e = world.raise(x, y, jolt);
        world.setTerrain(x, y, classify(e, world.getMoisture(x, y), world.getTemperature(x, y)));
      },
    },
    {
      id: "meteor",
      label: "隕石",
      hotkey: "m",
      group: "disaster",
      swatch: "#ff3b2f",
      apply: function (world, x, y, falloff) {
        const i = world.idx(x, y);
        if (Game.tile.isWater(world.terrain[i])) return; // 着水は無視
        // クレーター: 中心ほど深く沈め、一帯を焼け地化。
        world.elevation[i] = Math.max(0, world.elevation[i] - 0.22 * falloff);
        world.terrain[i] = T.SCORCHED;
        world.moisture[i] = 0.05;
        if (world.fertility) world.fertility[i] = 0;
        // 縁では可燃地形に着火し、燃え広がる火災を起こす。
        const fire = Game.state.fire;
        if (fire && falloff < 0.5) fire.ignite(x, y);
      },
    },
    {
      id: "flood",
      label: "洪水",
      hotkey: "f",
      group: "disaster",
      swatch: "#1f6fd0",
      apply: function (world, x, y) {
        // 低地のみ水没させる（高地は残る）。
        const th = Game.config.thresholds;
        const i = world.idx(x, y);
        if (world.elevation[i] >= th.grass) return;
        world.elevation[i] = (th.deepWater + th.shallowWater) * 0.5;
        world.terrain[i] = T.SHALLOW_WATER;
        world.moisture[i] = 1;
      },
    },
    {
      id: "plague",
      label: "疫病",
      hotkey: "v",
      group: "disaster",
      swatch: "#6db33f",
      apply: function (world, x, y, falloff) {
        // 中心タイルでのみ発動し、ブラシ半径内の生物を大量死させる（1回スキャン）。
        if (falloff < 0.95) return;
        const ent = Game.state.entities;
        const brush = Game.state.brush;
        if (!ent || !brush) return;
        const r = brush.size;
        const r2 = r * r;
        for (let k = 0; k < ent.count; k++) {
          if (!ent.alive[k]) continue;
          const dx = ent.x[k] - (x + 0.5);
          const dy = ent.y[k] - (y + 0.5);
          if (dx * dx + dy * dy <= r2 && Math.random() < 0.7) ent.kill(k);
        }
      },
    },
    {
      // 調べる: クリックで人や国を選んで詳細を見る（地形には作用しない）。
      // 実際の選択は input.applyAt が inspect を検知して Game.inspector に委ねる。
      id: "inspect",
      label: "調べる",
      hotkey: "i",
      group: "civ",
      swatch: "#8fd0ff",
      apply: function () { /* no-op: 選択は inspector が処理 */ },
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
