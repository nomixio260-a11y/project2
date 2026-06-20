// 気候・季節システム。グローバルな時計を進め、季節（春夏秋冬）を更新する。
// 季節は植生の成長率・炎の延焼しやすさ・体感気温に影響する（vegetation/fire が参照）。
(function (Game) {
  "use strict";

  function ClimateSystem() {
    this.reset();
  }

  ClimateSystem.prototype.reset = function () {
    const clk = Game.state.clock;
    clk.tick = 0;
    clk.day = 0;
    clk.year = 1;
    clk.seasonIndex = 0;
    clk.season = Game.SEASONS[0];
  };

  // 互換: world 差し替え時に呼ばれても安全。
  ClimateSystem.prototype.setWorld = function () {};
  ClimateSystem.prototype.clear = function () {
    this.reset();
  };

  ClimateSystem.prototype.tick = function () {
    const cfg = Game.config.sim;
    const clk = Game.state.clock;
    clk.tick++;
    if (clk.tick >= cfg.ticksPerDay) {
      clk.tick = 0;
      clk.day++;
      const seasonLen = cfg.daysPerSeason;
      const totalSeasons = (clk.day / seasonLen) | 0;
      const idx = totalSeasons % 4;
      clk.year = 1 + ((totalSeasons / 4) | 0);
      if (idx !== clk.seasonIndex) {
        clk.seasonIndex = idx;
        clk.season = Game.SEASONS[idx];
      }
    }
  };

  Game.ClimateSystem = ClimateSystem;
})(window.Game);
