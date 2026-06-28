// プロシージャル生成: ノイズ → 標高 + 湿度 → 地形分類。
(function (Game) {
  "use strict";

  const T = Game.TERRAIN;

  Game.worldgen = {
    // seed を使って world を生成・上書きする。world は再利用される。
    generate: function (world, seed) {
      const cfg = Game.config;
      const g = cfg.gen;
      const W = world.width;
      const H = world.height;

      const elevNoise = new Game.Noise(seed);
      const moistNoise = new Game.Noise((seed ^ 0x9e3779b9) >>> 0);
      const tempNoise = new Game.Noise((seed ^ 0x85ebca6b) >>> 0);

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

          // 温度: 緯度（マップ中央が暖・上下端が寒）から標高分を引き、ノイズで揺らす。
          const lat = 1 - Math.abs(ny - 0.5) * 2; // 0(端)..1(中央)
          const tn = tempNoise.fbm(nx * 2.0, ny * 2.0, {
            octaves: 3,
            frequency: 1,
            lacunarity: 2,
            gain: 0.5,
          });
          let temp = lat - e * g.temperatureLapse + (tn - 0.5) * g.temperatureNoise;
          temp = Game.utils.clamp(temp, 0, 1);

          const i = y * W + x;
          world.elevation[i] = e;
          world.moisture[i] = m;
          world.temperature[i] = temp;
          world.terrain[i] = Game.tile.classify(e, m, temp);
        }
      }

      // 川を刻む（湿った高地→海への最急降下）。
      this.carveRivers(world, seed);

      // 戦略資源を配置（地形に応じた鉱石・漁場・宝石）。
      this.placeResources(world, seed);
    },

    // 戦略資源を地形に応じて散布する（seed で再現可能）。
    // 鉱石=丘/山、宝石=稀な丘/山、漁場=陸に隣接する浅瀬。
    placeResources: function (world, seed) {
      const W = world.width, H = world.height;
      const R = Game.RESOURCE, T = Game.TERRAIN;
      const rand = Game.utils.mulberry32((seed ^ 0x6b43a9f5) >>> 0);
      const res = world.resource;
      res.fill(0);
      const list = [];
      const tile = Game.tile;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const ter = world.terrain[i];
          let r = 0;
          if (ter === T.HILL || ter === T.MOUNTAIN) {
            const v = rand();
            if (v < 0.012) r = R.GEMS;        // 宝石（稀）
            else if (v < 0.026) r = R.GOLD;   // 金鉱石（稀。貨幣の素材）
            else if (v < 0.11) r = R.ORE;     // 鉱石
          } else if (ter === T.SHALLOW_WATER) {
            // 陸に隣接する浅瀬＝沿岸の漁場。
            let coast = false;
            if (x > 0 && tile.isLand(world.terrain[i - 1])) coast = true;
            else if (x < W - 1 && tile.isLand(world.terrain[i + 1])) coast = true;
            else if (y > 0 && tile.isLand(world.terrain[i - W])) coast = true;
            else if (y < H - 1 && tile.isLand(world.terrain[i + W])) coast = true;
            if (coast && rand() < 0.06) r = R.FISH;
          }
          if (r) { res[i] = r; list.push({ x: x, y: y, t: r }); }
        }
      }
      world.resourceList = list;
    },

    // 湿った高地を水源に、最急降下で水まで川を引く。seed で再現可能。
    carveRivers: function (world, seed) {
      const th = Game.config.thresholds;
      const W = world.width;
      const H = world.height;
      const rand = Game.utils.mulberry32((seed ^ 0x27d4eb2f) >>> 0);

      // 水源候補（高地かつ多湿）を集める。
      const sources = [];
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (world.elevation[i] > th.hill && world.moisture[i] > 0.55) {
            sources.push(i);
          }
        }
      }
      // シャッフルして上限本数だけ採用（決定性は seed 由来の rand に依存）。
      const maxSources = 40;
      for (let k = sources.length - 1; k > 0; k--) {
        const j = (rand() * (k + 1)) | 0;
        const tmp = sources[k];
        sources[k] = sources[j];
        sources[j] = tmp;
      }
      const count = Math.min(maxSources, sources.length);

      const maxLen = (W + H);
      for (let s = 0; s < count; s++) {
        let i = sources[s];
        let steps = 0;
        const visited = {};
        while (steps++ < maxLen) {
          const x = i % W;
          const y = (i / W) | 0;
          const e = world.elevation[i];
          // 既に水なら終了。
          if (world.terrain[i] === T.DEEP_WATER || world.terrain[i] === T.SHALLOW_WATER) break;

          // 川化（浅瀬として刻み、周囲を湿らせて再分類）。
          world.terrain[i] = T.SHALLOW_WATER;
          world.moisture[i] = 1;
          visited[i] = 1;

          // 最も低い 8近傍へ。
          let best = -1;
          let bestE = e;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const ni = ny * W + nx;
              if (visited[ni]) continue;
              if (world.elevation[ni] < bestE) {
                bestE = world.elevation[ni];
                best = ni;
              }
            }
          }
          if (best < 0) break; // 窪地（局所最小）で停止
          i = best;
        }
      }
    },
  };
})(window.Game);
