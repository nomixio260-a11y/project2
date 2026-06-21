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

  // 時刻(0..1: 0=深夜, 0.25=日の出, 0.5=正午, 0.75=日没)から
  // 環境光を計算する純関数。renderer が全画面オーバーレイに使う。
  Game.lighting = function (clk) {
    const cfg = Game.config.sim;
    const tod = cfg.ticksPerDay > 0 ? (clk.tick % cfg.ticksPerDay) / cfg.ticksPerDay : 0.5;
    const sun = Math.sin((tod - 0.25) * Math.PI * 2); // -1(深夜)..1(正午)
    const darkness = Math.max(0, -sun) * 0.55; // 夜の暗さ(最大0.55)
    const twilight = Math.max(0, 1 - Math.abs(sun) * 3); // 朝夕の暖色(0..1)
    return { tod: tod, sun: sun, darkness: darkness, twilight: twilight };
  };

  Game.ClimateSystem = ClimateSystem;
})(window.Game);
