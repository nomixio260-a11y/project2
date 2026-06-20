// DOM非依存のコアモジュール群を Node の vm 上にロードするヘルパ。
// window だけ用意すれば noise / world / worldgen / tile / camera が動く。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadCore(overrides) {
  const root = path.join(__dirname, "..");
  // camera.js は document を参照しないが、screenToTile などのために
  // 最小限の window だけ用意する。
  const ctx = {
    window: {},
    Math,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    console,
    performance: { now: () => Date.now() },
  };
  vm.createContext(ctx);

  const files = [
    "js/core/namespace.js",
    "js/core/constants.js",
    "js/core/utils.js",
    "js/math/noise.js",
    "js/world/tile.js",
    "js/world/world.js",
    "js/world/worldgen.js",
    "js/world/entities.js",
    "js/tools/godpowers.js",
    "js/render/camera.js",
    "js/systems/climate.js",
    "js/systems/vegetation.js",
    "js/systems/creatures.js",
    "js/systems/fire.js",
    "js/systems/civ.js",
    "js/ui/hud.js",
  ];
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
  }

  const Game = ctx.window.Game;
  if (overrides) Object.assign(Game.config, overrides);
  return Game;
}

module.exports = { loadCore };
