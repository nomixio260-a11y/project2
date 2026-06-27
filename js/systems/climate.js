// 気候・季節システム。グローバルな時計を進め、季節（春夏秋冬）を更新する。
// 季節は植生の成長率・炎の延焼しやすさ・体感気温に影響する（vegetation/fire が参照）。
(function (Game) {
  "use strict";

  function ClimateSystem() {
    this.rand = Game.utils.mulberry32((Game.config.seed ^ 0x9e3779b9) >>> 0);
    this._epoch = 999; // 現在の気候エポック符号（年代記ログのヒステリシス用）
    this.reset();
  }

  ClimateSystem.prototype.reset = function () {
    const clk = Game.state.clock;
    clk.tick = 0;
    clk.day = 0;
    clk.year = 1;
    clk.seasonIndex = 0;
    clk.season = Game.SEASONS[0];
    // 長期気候（数年周期で揺らぐ温暖度・湿潤度。0 を中心に ±）。
    clk.warmth = 0;     // +温暖 / −寒冷
    clk.wetness = 0;    // +多雨 / −乾燥
    clk.coolShock = 0;  // 火山の冬など一時的な寒冷ショック（指数減衰）
    clk.climate = "穏やか";
    // 世界ごとに気候サイクルの位相をずらす（同じ歴史を繰り返さない）。
    this._wphase = this.rand ? this.rand() * 6.283 : 0;
    this._dphase = this.rand ? this.rand() * 6.283 : 0;
    this._epoch = 999;
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
      this._updateClimate(clk);
    }
  };

  // 長期の気候変動を1日ぶん進める。周期の異なる正弦波を重ね、緩やかに温暖/寒冷・
  // 湿潤/乾燥のうねりを作る。火山の冬などのショックは指数的に薄れていく。
  // この warmth / wetness を植生・天候・炎・災害・食料経済が参照し、
  // 「豊穣の時代」「大旱魃の時代」といった世界規模の起伏を生む（全系の上流の因果）。
  ClimateSystem.prototype._updateClimate = function (clk) {
    const daysPerYear = ((Game.config.sim.daysPerSeason || 14) * 4) || 56;
    const yr = clk.day / daysPerYear;
    const TWO_PI = Math.PI * 2;
    const warmBase = 0.10 * Math.sin(yr * TWO_PI / 7 + this._wphase) +
      0.05 * Math.sin(yr * TWO_PI / 3.1 + this._wphase * 1.7);
    const wetBase = 0.12 * Math.sin(yr * TWO_PI / 5 + this._dphase) +
      0.05 * Math.sin(yr * TWO_PI / 2.3 + this._dphase * 0.6);
    if (clk.coolShock > 0) { clk.coolShock *= 0.985; if (clk.coolShock < 0.003) clk.coolShock = 0; }
    clk.warmth = warmBase - clk.coolShock;
    clk.wetness = wetBase;
    this._logEpoch(clk);
  };

  // 気候エポックの転換を判定し、年代記に記録する（ヒステリシスで頻繁な切替を防ぐ）。
  ClimateSystem.prototype._logEpoch = function (clk) {
    let e = 0; if (clk.warmth > 0.12) e = 1; else if (clk.warmth < -0.12) e = -1;
    let w = 0; if (clk.wetness > 0.14) w = 1; else if (clk.wetness < -0.14) w = -1;
    const code = e * 10 + w;
    let label, msg = null;
    if (e > 0 && w < 0) { label = "灼熱・乾燥"; msg = "🌡 灼熱と乾きの時代が訪れた"; }
    else if (e < 0 && w < 0) { label = "寒冷・乾燥"; msg = "❄ 寒冷と乾燥の時代が訪れた"; }
    else if (e > 0 && w > 0) { label = "温暖・多雨"; msg = "🌿 温暖で豊かな実りの時代が訪れた"; }
    else if (e < 0 && w > 0) { label = "冷涼・多雨"; msg = "🌧 冷涼で雨がちな時代が訪れた"; }
    else if (e > 0) { label = "温暖"; msg = "🌡 温暖な時代が訪れた"; }
    else if (e < 0) { label = "寒冷"; msg = "❄ 寒冷な時代が訪れた"; }
    else if (w > 0) { label = "多雨"; msg = "🌧 多雨の時代が訪れた"; }
    else if (w < 0) { label = "乾燥"; msg = "☀ 乾燥の時代が訪れた"; }
    else { label = "穏やか"; msg = (this._epoch !== 999 ? "🍃 穏やかな気候に戻った" : null); }
    clk.climate = label;
    if (code !== this._epoch) {
      const wasInit = this._epoch === 999;
      this._epoch = code;
      const civ = Game.state.civ;
      if (msg && !wasInit && civ && civ._logEvent) civ._logEvent(msg);
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
