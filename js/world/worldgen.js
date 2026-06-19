// プロシージャル生成: ノイズ → 標高 + 湿度 → 地形分類。
(function (Game) {
  "use strict";

  Game.worldgen = {
    // seed を使って world を生成・上書きする。world は再利用される。
    generate: function (world, seed) {
      const cfg = Game.config;
      const g = cfg.gen;
      const W = world.width;
      const H = world.height;

      const elevNoise = new Game.Noise(seed);
      const moistNoise = new Game.Noise((seed ^ 0x9e3779b9) >>> 0);

      // ノイズ座標は 0..frequency の範囲にマップ（解像度非依存にする）。
      const invW = 1 / W;
      const invH = 1 / H;
      const cx = (W - 1) * 0.5;
      const cy = (H - 1) * 0.5;
      // 中心からの最大距離（島マスク正規化用）。
      const maxDist = Math.sqrt(cx * cx + cy * cy);

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const nx = x * invW;
          const ny = y * invH;

          let e = elevNoise.fbm(nx * g.elevationFrequency, ny * g.elevationFrequency, {
            octaves: g.elevationOctaves,
            frequency: 1,
            lacunarity: g.elevationLacunarity,
            gain: g.elevationGain,
          });

          // 島マスク: 端に向かって標高を下げ、海で囲まれた大陸にする。
          if (g.islandMask) {
            const dx = x - cx;
            const dy = y - cy;
            const d = Math.sqrt(dx * dx + dy * dy) / maxDist; // 0(中心)..1(角)
            // 中心は 1、端は 0 に近づく減衰。
            const falloff = 1 - Math.pow(d, 2.2) * g.islandStrength;
            e = e * Game.utils.clamp(falloff, 0, 1);
          }

          const m = moistNoise.fbm(nx * g.moistureFrequency, ny * g.moistureFrequency, {
            octaves: g.moistureOctaves,
            frequency: 1,
            lacunarity: g.moistureLacunarity,
            gain: g.moistureGain,
          });

          const i = y * W + x;
          world.elevation[i] = e;
          world.moisture[i] = m;
          world.terrain[i] = Game.tile.classify(e, m);
        }
      }
    },
  };
})(window.Game);
