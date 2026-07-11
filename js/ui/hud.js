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
    summaryEl: null,
    collapsed: false,
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
    // [key, アイコン, ラベル（常時表示＝アイコンの意味がすぐ分かる）]
    const defs = [
      ["civpop", "👥", "人口"],
      ["kingdoms", "🏰", "国"],
      ["nomads", "🚶", "放浪"],
      ["pop", "🐾", "野生"],
      ["herb", "🦌", "草食"],
      ["pred", "🐺", "肉食"],
      ["fires", "🔥", "火災"],
      ["fps", "⚡", "FPS"],
    ];
    el.innerHTML = "";

    // 折りたたみ用ヘッダ（クリックで開閉。畳んでも要約を表示）。諸国パネルと同じ見た目。
    const header = document.createElement("div");
    header.className = "nations-header";
    const title = document.createElement("span");
    title.textContent = "情報";
    const summary = document.createElement("span");
    summary.className = "nations-count hud-summary";
    summary.textContent = "—";
    header.appendChild(title);
    header.appendChild(summary);
    el.appendChild(header);
    this.summaryEl = summary;

    // 本体（スパークライン＋チップ）。畳むと隠れる。
    const body = document.createElement("div");
    body.className = "hud-body";
    el.appendChild(body);

    // スパークライン。
    const spark = document.createElement("canvas");
    spark.className = "hud-spark";
    spark.title = "人口の推移（時間で右へ流れるグラフ）";
    spark.width = 150;
    spark.height = 34;
    body.appendChild(spark);
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
      const lb = document.createElement("span");
      lb.className = "hc-lb";
      lb.textContent = defs[i][2]; // ラベルを常時表示（アイコン頼みにしない）
      chip.appendChild(ic);
      chip.appendChild(v);
      chip.appendChild(lb);
      chips.appendChild(chip);
      this.rows[key] = v;
    }
    body.appendChild(chips);

    // 世界の情勢（いま何ヶ国で戦争・飢饉・疫病・反乱・黄金時代が起きているか）。
    //   地図上の情勢バッジと同じ記号で、世界全体の「今」を一目で伝える。
    const situ = document.createElement("div");
    situ.className = "hud-situ";
    situ.title = "世界の情勢: 交戦・飢饉・疫病・反乱・黄金時代の国数";
    body.appendChild(situ);
    this.situEl = situ;

    const self = this;
    header.addEventListener("click", function () {
      self.collapsed = !self.collapsed;
      el.classList.toggle("collapsed", self.collapsed);
    });
    // 既定: 携帯では畳んでおく（邪魔にならないように）。
    if (Game.device && Game.device.isPhone) {
      this.collapsed = true;
      el.classList.add("collapsed");
    }

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
    // 平常時以外の長期気候（豊穣・旱魃・寒冷など）を併記する。
    const clim = clk.climate && clk.climate !== "穏やか" ? "  · " + clk.climate : "";
    this.clockEl.textContent =
      clk.season.emoji + " " + clk.season.name +
      "  " + clk.year + "年 " + dayInSeason + "日" + clim;
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
    // 畳んでいてもヘッダに要約（人口・総個体数）を出す。本体の更新と描画は省く。
    if (this.summaryEl) {
      const cp = s.civpop >= 1000 ? (s.civpop / 1000).toFixed(1) + "k" : String(s.civpop);
      this.summaryEl.textContent = "👥" + cp + " 🐾" + s.pop;
    }
    if (this.collapsed) return;
    this.rows.pop.textContent = String(s.pop);
    this.rows.herb.textContent = String(s.herb);
    this.rows.pred.textContent = String(s.pred);
    this.rows.kingdoms.textContent = String(s.kingdoms);
    this.rows.civpop.textContent = s.civpop >= 1000 ? (s.civpop / 1000).toFixed(1) + "k" : String(s.civpop);
    this.rows.nomads.textContent = String(s.nomads);
    this.rows.fires.textContent = String(s.fires);
    this.rows.fps.textContent = String(Math.round(this._fps));

    // 世界の情勢サマリ（顕著な状態にある国数を記号で）。地図の情勢バッジと対応する。
    if (this.situEl) this.situEl.innerHTML = this._situationHtml();

    // スパークライン更新（総個体数の推移）。
    this.history.push(s.pop);
    if (this.history.length > HIST) this.history.shift();
    this._drawSpark();
  };

  // 世界の情勢を集計し、記号＋国数の小さなバッジ列 HTML を返す（地図の情勢バッジと対応）。
  Hud._situationHtml = function () {
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return "";
    let wars = 0, famine = 0, plague = 0, revolt = 0, golden = 0;
    const ks = civ.kingdoms;
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id];
      if (!k || !k.alive) continue;
      let atWar = false;
      if (k.wars) { for (const w in k.wars) { atWar = true; break; } }
      if (atWar) wars++;
      if (k.famine) famine++;
      if (k.plague > 0) plague++;
      if ((k.unrest || 0) > 70) revolt++;
      if (k.goldenAge) golden++;
    }
    // 値が 0 の項目は出さない（情勢が静かなら簡潔に）。
    const parts = [];
    if (wars) parts.push(['⚔', wars, 'crit', '交戦中の国']);
    if (famine) parts.push(['🌾', famine, 'warn', '飢饉の国']);
    if (plague) parts.push(['🦠', plague, 'warn', '疫病の国']);
    if (revolt) parts.push(['✊', revolt, 'warn', '不穏（高い不満）の国']);
    if (golden) parts.push(['✨', golden, 'good', '黄金時代の国']);
    if (!parts.length) return '<span class="hud-situ-calm">☮ 世界は平穏</span>';
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      html += '<span class="hud-situ-b ' + parts[i][2] + '" title="' + parts[i][3] + '">' + parts[i][0] + " " + parts[i][1] + "</span>";
    }
    return html;
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
