// 世界の概観パネル。人口・国数の推移グラフと、人口上位の国ランキングを表示する。
// 📊 ボタンで開閉。開いている間だけ間引いて更新する。
(function (Game) {
  "use strict";

  const Overview = { panel: null, btn: null, chart: null, cctx: null, rank: null, open: false, _acc: 0 };

  Overview.init = function () {
    const btn = document.getElementById("overview-toggle");
    const panel = document.getElementById("overview-panel");
    if (!btn || !panel) return;
    this.btn = btn;
    this.panel = panel;
    panel.innerHTML =
      '<div class="panel-head">世界の概観</div>' +
      '<canvas class="ov-chart" width="306" height="104"></canvas>' +
      '<div class="ov-legend"><span class="ov-k ov-k-pop">■ 総人口</span><span class="ov-k ov-k-nat">■ 国数</span></div>' +
      '<div class="ov-rank-title">人口上位</div>' +
      '<div class="ov-rank"></div>';
    this.chart = panel.querySelector(".ov-chart");
    this.cctx = this.chart.getContext("2d");
    this.rank = panel.querySelector(".ov-rank");

    const self = this;
    btn.addEventListener("click", function (e) { e.stopPropagation(); self.toggle(); });
    document.addEventListener("click", function (e) {
      if (self.open && !panel.contains(e.target) && e.target !== btn) self.toggle(false);
    });
    window.addEventListener("keydown", function (e) { if (e.key === "Escape" && self.open) self.toggle(false); });
  };

  Overview.toggle = function (force) {
    this.open = force === undefined ? !this.open : force;
    this.panel.classList.toggle("show", this.open);
    this.btn.classList.toggle("on", this.open);
    if (this.open) this._render();
  };

  Overview.tick = function (dt) {
    if (!this.open) return;
    this._acc += dt;
    if (this._acc < 700) return;
    this._acc = 0;
    this._render();
  };

  Overview._render = function () {
    const civ = Game.state.civ;
    if (!civ) return;
    const hist = civ.statsHist || [];
    const ctx = this.cctx, W = this.chart.width, H = this.chart.height;
    ctx.clearRect(0, 0, W, H);
    if (hist.length >= 2) {
      let maxP = 1, maxN = 1;
      for (let i = 0; i < hist.length; i++) {
        const tot = hist[i].pop + hist[i].nomads;
        if (tot > maxP) maxP = tot;
        if (hist[i].nations > maxN) maxN = hist[i].nations;
      }
      const stepX = W / (hist.length - 1);
      // 総人口の塗り＋線。
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let i = 0; i < hist.length; i++) {
        ctx.lineTo(i * stepX, H - ((hist[i].pop + hist[i].nomads) / maxP) * (H - 5) - 2);
      }
      ctx.lineTo((hist.length - 1) * stepX, H); ctx.closePath();
      ctx.fillStyle = "rgba(120,200,120,0.20)"; ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < hist.length; i++) {
        const y = H - ((hist[i].pop + hist[i].nomads) / maxP) * (H - 5) - 2;
        if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i * stepX, y);
      }
      ctx.strokeStyle = "#8fe08f"; ctx.lineWidth = 1.4; ctx.stroke();
      // 国数の線（独自スケール）。
      ctx.beginPath();
      for (let i = 0; i < hist.length; i++) {
        const y = H - (hist[i].nations / maxN) * (H - 5) - 2;
        if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i * stepX, y);
      }
      ctx.strokeStyle = "#6fa8ff"; ctx.lineWidth = 1.2; ctx.stroke();
    }

    // 人口上位ランキング。
    const list = civ.getNations ? civ.getNations() : [];
    const top = list.slice(0, 6);
    const maxPop = top.length ? top[0].pop : 1;
    let html = "";
    for (let i = 0; i < top.length; i++) {
      const n = top[i];
      html += '<div class="ov-row">' +
        '<span class="ov-sw" style="background:rgb(' + n.color[0] + "," + n.color[1] + "," + n.color[2] + ')"></span>' +
        '<span class="ov-name">' + esc(n.name) + "</span>" +
        '<span class="ov-bar"><i style="width:' + (100 * n.pop / Math.max(1, maxPop)).toFixed(0) + '%"></i></span>' +
        '<span class="ov-num">' + n.pop + "</span></div>";
    }
    this.rank.innerHTML = html || '<div class="ov-empty">まだ国がありません</div>';
  };

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

  Game.overview = Overview;
})(window.Game);
