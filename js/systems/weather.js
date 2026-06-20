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
      });
    }
  };

  WeatherSystem.prototype.setWorld = function (world) { this.world = world; this._spawn(); };
  WeatherSystem.prototype.clear = function () { this._spawn(); };

  WeatherSystem.prototype.tick = function (world) {
    const cfg = Game.config.sim;
    const W = world.width, H = world.height;
    const season = (Game.state.clock && Game.state.clock.season) || (Game.SEASONS && Game.SEASONS[0]);
    const rainMul = season ? (season.name === "春" ? 1.4 : season.name === "夏" ? 1.1 : season.name === "冬" ? 0.5 : 1.0) : 1;
    const lightningMul = season ? (season.name === "夏" ? 2.0 : season.name === "冬" ? 0.2 : 1.0) : 1;
    const rainMoist = (cfg.rainMoisture || 0.06) * rainMul;
    const rainFert = (cfg.rainFertility || 0.05) * rainMul;
    const lightningP = (cfg.lightningChance || 0.015) * lightningMul;
    const fire = Game.state.fire;

    for (let c = 0; c < this.clouds.length; c++) {
      const cl = this.clouds[c];
      cl.x += cl.vx; cl.y += cl.vy;
      // 端で巻き戻し（地図を周回）。
      if (cl.x < -cl.r) cl.x = W + cl.r; else if (cl.x > W + cl.r) cl.x = -cl.r;
      if (cl.y < -cl.r) cl.y = H + cl.r; else if (cl.y > H + cl.r) cl.y = -cl.r;

      // 降雨: 雲の下を数点サンプルして湿らせる。
      const samples = 14;
      for (let s = 0; s < samples; s++) {
        const rx = (cl.x + (this.rand() * 2 - 1) * cl.r) | 0;
        const ry = (cl.y + (this.rand() * 2 - 1) * cl.r) | 0;
        if (rx < 0 || ry < 0 || rx >= W || ry >= H) continue;
        const i = ry * W + rx;
        if (world.moisture) { const m = world.moisture[i] + rainMoist; world.moisture[i] = m > 1 ? 1 : m; }
        if (world.fertility && Game.tile.isLand(world.terrain[i])) {
          const f = world.fertility[i] + rainFert; world.fertility[i] = f > 1 ? 1 : f;
        }
        // 雨は延焼を鎮める。
        if (fire && fire.burn && fire.burn[i] > 0) {
          fire.burn[i] = fire.burn[i] > 6 ? fire.burn[i] - 6 : 0;
        }
      }

      // 落雷: 雲の下の可燃地にまれに着火。
      if (this.rand() < lightningP && fire) {
        const lx = (cl.x + (this.rand() * 2 - 1) * cl.r * 0.7) | 0;
        const ly = (cl.y + (this.rand() * 2 - 1) * cl.r * 0.7) | 0;
        if (lx >= 0 && ly >= 0 && lx < W && ly < H && Game.tile.isFlammable(world.terrain[ly * W + lx])) {
          fire.ignite(lx, ly);
          cl.flash = 6; // 描画用フラッシュ
        }
      }
      if (cl.flash) cl.flash--;
    }
  };

  WeatherSystem.prototype.update = function (dt) { this.phase += dt; };

  Game.WeatherSystem = WeatherSystem;
})(window.Game);
