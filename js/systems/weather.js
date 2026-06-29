// 天候システム。雲が大陸を流れ、雨で湿度・植生(fertility)を潤し、
// 落雷で可燃地に着火する。季節で雨量・落雷頻度が変わる（春は雨がち、夏は雷雨）。
// 雲は数個だけ・効果はサンプリングで適用するため低負荷。
(function (Game) {
  "use strict";

  function WeatherSystem(world, renderer) {
    this.world = world;
    this.renderer = renderer;
    this.rand = Game.utils.mulberry32((Game.config.seed ^ 0x7e47ce11) >>> 0);
    this.clouds = [];
    this.phase = 0;
    // 卓越風（ゆっくり向きを変える地球規模の風）。雲を流し、炎の延焼方向も左右する。
    this.windAng = this.rand() * Math.PI * 2;
    this.wind = { x: Math.cos(this.windAng), y: Math.sin(this.windAng) };
    Game.state.wind = this.wind; // 炎システムなどが参照
    this._spawn();
  }

  WeatherSystem.prototype._spawn = function () {
    const cfg = Game.config.sim;
    const W = this.world.width, H = this.world.height;
    const n = cfg.cloudCount || 5;
    this.clouds.length = 0;
    for (let i = 0; i < n; i++) {
      const ang = this.rand() * Math.PI * 2;
      const sp = 0.05 + this.rand() * 0.08;
      this.clouds.push({
        x: this.rand() * W,
        y: this.rand() * H,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp * 0.5,
        r: 18 + this.rand() * 26,
        water: 0.4 + this.rand() * 0.4, // 含む水分（海上で増え、陸へ降らせて減る）
      });
    }
  };

  WeatherSystem.prototype.setWorld = function (world) { this.world = world; this._spawn(); };
  WeatherSystem.prototype.clear = function () { this._spawn(); };

  WeatherSystem.prototype.tick = function (world) {
    const cfg = Game.config.sim;
    const W = world.width, H = world.height;
    const clk = Game.state.clock;
    const season = (clk && clk.season) || (Game.SEASONS && Game.SEASONS[0]);
    const rainMul = season ? (season.name === "春" ? 1.4 : season.name === "夏" ? 1.1 : season.name === "冬" ? 0.5 : 1.0) : 1;
    const lightningMul = season ? (season.name === "夏" ? 2.0 : season.name === "冬" ? 0.2 : 1.0) : 1;
    // 長期気候: 湿潤な時代は雨が増え、乾燥・温暖な時代は雷雨が増え雨が細る。
    const wetness = clk ? (clk.wetness || 0) : 0;
    const warmth = clk ? (clk.warmth || 0) : 0;
    const climRain = 1 + 0.6 * wetness;
    const climLight = 1 + Math.max(0, 0.5 * -wetness + 0.4 * warmth);
    const rainMoist = (cfg.rainMoisture || 0.06) * rainMul * climRain;
    const rainFert = (cfg.rainFertility || 0.05) * rainMul * climRain;
    const lightningP = (cfg.lightningChance || 0.015) * lightningMul * climLight;
    const fire = Game.state.fire;

    // 卓越風をゆっくり回し、雲を流す向きと炎の延焼方向に反映する。
    this.windAng += (this.rand() - 0.5) * 0.03;
    this.wind.x = Math.cos(this.windAng); this.wind.y = Math.sin(this.windAng);
    Game.state.wind = this.wind;
    const windSp = 0.06;

    for (let c = 0; c < this.clouds.length; c++) {
      const cl = this.clouds[c];
      if (cl.water == null) cl.water = 0.6;
      // 雲は固有の動き＋卓越風で流れる（一貫した気団・前線を作る）。
      cl.x += cl.vx * 0.6 + this.wind.x * windSp;
      cl.y += cl.vy * 0.6 + this.wind.y * windSp * 0.7;
      // 端で巻き戻し（地図を周回）。
      if (cl.x < -cl.r) cl.x = W + cl.r; else if (cl.x > W + cl.r) cl.x = -cl.r;
      if (cl.y < -cl.r) cl.y = H + cl.r; else if (cl.y > H + cl.r) cl.y = -cl.r;

      // 降雨: 雲の下を数点サンプル。海上では水分を蒸発で蓄え、陸では雨を降らせて
      //   水分を失う（風下に乾いた雨蔭ができる＝オログラフィックな現実味）。
      const samples = 14;
      let waterTiles = 0, landTiles = 0, mountainTiles = 0;
      const wf = 0.35 + 0.65 * cl.water; // 水分が多い雲ほど強く降る
      for (let s = 0; s < samples; s++) {
        const rx = (cl.x + (this.rand() * 2 - 1) * cl.r) | 0;
        const ry = (cl.y + (this.rand() * 2 - 1) * cl.r) | 0;
        if (rx < 0 || ry < 0 || rx >= W || ry >= H) continue;
        const i = ry * W + rx;
        const terr = world.terrain[i];
        if (Game.tile.isWater(terr)) { waterTiles++; continue; } // 海上は蒸発（降らない）
        landTiles++;
        const isMtn = terr === Game.TERRAIN.MOUNTAIN || terr === Game.TERRAIN.HILL;
        if (isMtn) mountainTiles++;
        const orog = isMtn ? 1.6 : 1; // 山地は雨を強く絞り取る
        if (world.moisture) { const m = world.moisture[i] + rainMoist * wf * orog; world.moisture[i] = m > 1 ? 1 : m; }
        if (world.fertility && Game.tile.isLand(terr)) {
          const f = world.fertility[i] + rainFert * wf * orog; world.fertility[i] = f > 1 ? 1 : f;
        }
        // 雨は延焼を鎮める。
        if (fire && fire.burn && fire.burn[i] > 0) {
          fire.burn[i] = fire.burn[i] > 6 ? fire.burn[i] - 6 : 0;
        }
      }
      // 水分収支: 海上で蓄え、陸（特に山）へ降らせて失う。乾燥気候では蓄えにくい。
      cl.water += waterTiles / samples * 0.05 * (1 + 0.5 * wetness);
      cl.water -= (landTiles + mountainTiles) / samples * 0.03 * wf;
      if (cl.water < 0.1) cl.water = 0.1; else if (cl.water > 1) cl.water = 1;

      // 落雷: 背の高い水分の多い積乱雲ほど雷を生む（薄く乾いた雲はめったに光らない＝実際の雷雨）。
      //   雲の下の「乾いた」可燃地にまれに着火する（湿った草原は燃えない）。
      if (this.rand() < lightningP * (0.15 + 0.85 * cl.water) && fire) {
        const lx = (cl.x + (this.rand() * 2 - 1) * cl.r * 0.7) | 0;
        const ly = (cl.y + (this.rand() * 2 - 1) * cl.r * 0.7) | 0;
        if (lx >= 0 && ly >= 0 && lx < W && ly < H) {
          const li = ly * W + lx;
          const dry = !world.moisture || world.moisture[li] < 0.35;
          if (dry && Game.tile.isFlammable(world.terrain[li])) {
            fire.ignite(lx, ly);
            cl.flash = 6; // 描画用フラッシュ
          }
        }
      }
      if (cl.flash) cl.flash--;
    }
  };

  WeatherSystem.prototype.update = function (dt) { this.phase += dt; };

  Game.WeatherSystem = WeatherSystem;
})(window.Game);
