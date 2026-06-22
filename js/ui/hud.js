// ライブ統計 HUD。シミュレーションの状態（個体数・王国・人口・延焼・FPS）と
// 個体数の推移スパークラインを表示する。さらに上部ステータスバーの季節時計も更新する。
// engine から毎フレーム tick(dt) されるが、DOM 更新は一定間隔(UPDATE_MS)に間引く。
(function (Game) {
  "use strict";

  const S = Game.SPECIES;
  const UPDATE_MS = 250; // HUD の再描画間隔
  const HIST = 120; // スパークラインの保持点数

  const Hud = {
    el: null,
    rows: null,
    spark: null,
    sctx: null,
    clockEl: null,
    history: [],
    _acc: 0,
    _fps: 0,
    _fpsAcc: 0,
    _fpsFrames: 0,
  };

  Hud.init = function () {
    const el = document.getElementById("hud");
    if (!el) return;
    this.el = el;
    this.rows = {};
    this.history = [];
    // [key, アイコン, 説明（ツールチップ）]
    const defs = [
      ["civpop", "👥", "人口"],
      ["kingdoms", "🏰", "王国数"],
      ["nomads", "🚶", "放浪者"],
      ["pop", "🐾", "総個体数"],
      ["herb", "🦌", "草食動物"],
      ["pred", "🐺", "肉食動物"],
      ["fires", "🔥", "延焼"],
      ["fps", "⚡", "FPS"],
    ];
    el.innerHTML = "";

    // スパークライン。
    const spark = document.createElement("canvas");
    spark.className = "hud-spark";
    spark.width = 150;
    spark.height = 34;
    el.appendChild(spark);
    this.spark = spark;
    this.sctx = spark.getContext("2d");

    // チップ（アイコン＋値）のグリッド。
    const chips = document.createElement("div");
    chips.className = "hud-chips";
    for (let i = 0; i < defs.length; i++) {
      const key = defs[i][0];
      const chip = document.createElement("div");
      chip.className = "hud-chip";
      chip.title = defs[i][2];
      const ic = document.createElement("span");
      ic.className = "hc-ic";
      ic.textContent = defs[i][1];
      const v = document.createElement("span");
      v.className = "hc-val";
      v.textContent = "0";
      chip.appendChild(ic);
      chip.appendChild(v);
      chips.appendChild(chip);
      this.rows[key] = v;
    }
    el.appendChild(chips);

    this.clockEl = document.getElementById("clock");
  };

  Hud.tick = function (dt) {
    this._renderClock(); // 時計は毎フレーム（軽量）
    if (!this.el) return;
    this._fpsAcc += dt;
    this._fpsFrames++;
    this._acc += dt;
    if (this._acc < UPDATE_MS) return;

    if (this._fpsAcc > 0) this._fps = (this._fpsFrames * 1000) / this._fpsAcc;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._acc = 0;

    this._render();
  };

  // 上部ステータスバーの季節時計を更新。
  Hud._renderClock = function () {
    if (!this.clockEl) this.clockEl = document.getElementById("clock");
    const clk = Game.state.clock;
    if (!this.clockEl || !clk || !clk.season) return;
    const dayInSeason = ((clk.day % Game.config.sim.daysPerSeason) | 0) + 1;
    this.clockEl.textContent =
      clk.season.emoji + " " + clk.season.name +
      "  " + clk.year + "年 " + dayInSeason + "日";
  };

  Hud.sample = function () {
    const st = Game.state;
    let herb = 0;
    let pred = 0;
    const e = st.entities;
    if (e) {
      for (let i = 0; i < e.count; i++) {
        if (!e.alive[i]) continue;
        if (e.type[i] === S.PREDATOR) pred++;
        else herb++;
      }
    }
    let kingdoms = 0;
    let civpop = 0;
    let nomads = 0;
    if (st.civ && st.civ.stats) {
      const cs = st.civ.stats();
      kingdoms = cs.kingdoms;
      civpop = cs.population;
      nomads = cs.nomads || 0;
    }
    const fires = st.fire && st.fire.active ? st.fire.active.length : 0;
    return { herb: herb, pred: pred, pop: herb + pred, kingdoms: kingdoms, civpop: civpop, nomads: nomads, fires: fires };
  };

  Hud._render = function () {
    const s = this.sample();
    this.rows.pop.textContent = String(s.pop);
    this.rows.herb.textContent = String(s.herb);
    this.rows.pred.textContent = String(s.pred);
    this.rows.kingdoms.textContent = String(s.kingdoms);
    this.rows.civpop.textContent = s.civpop >= 1000 ? (s.civpop / 1000).toFixed(1) + "k" : String(s.civpop);
    this.rows.nomads.textContent = String(s.nomads);
    this.rows.fires.textContent = String(s.fires);
    this.rows.fps.textContent = String(Math.round(this._fps));

    // スパークライン更新（総個体数の推移）。
    this.history.push(s.pop);
    if (this.history.length > HIST) this.history.shift();
    this._drawSpark();
  };

  Hud._drawSpark = function () {
    const ctx = this.sctx;
    if (!ctx) return;
    const W = this.spark.width;
    const H = this.spark.height;
    ctx.clearRect(0, 0, W, H);
    const h = this.history;
    if (h.length < 2) return;
    let max = 1;
    for (let i = 0; i < h.length; i++) if (h[i] > max) max = h[i];
    const stepX = W / (HIST - 1);
    // 塗り。
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < h.length; i++) {
      const x = i * stepX;
      const y = H - (h[i] / max) * (H - 2) - 1;
      ctx.lineTo(x, y);
    }
    ctx.lineTo((h.length - 1) * stepX, H);
    ctx.closePath();
    ctx.fillStyle = "rgba(120,200,120,0.22)";
    ctx.fill();
    // 線。
    ctx.beginPath();
    for (let i = 0; i < h.length; i++) {
      const x = i * stepX;
      const y = H - (h[i] / max) * (H - 2) - 1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#8fe08f";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  };

  Game.hud = Hud;
})(window.Game);
