// 地図ビュー切替。領土を「文明 / 政体 / 宗教 / 王朝 / 文化 / 時代」の区分で塗り分け、
// 勢力図を様々な切り口で可視化する。選んだ区分に応じて凡例を表示する。
(function (Game) {
  "use strict";

  const MapView = { sel: null, legendEl: null };

  MapView.init = function () {
    this.sel = document.getElementById("mapview");
    this.legendEl = document.getElementById("mapview-legend");
    if (!this.sel) return;
    Game.state.mapView = this.sel.value || "nation";
    const self = this;
    this.sel.addEventListener("change", function () { self.setMode(self.sel.value); });
    this._renderLegend();
  };

  MapView.setMode = function (mode) {
    Game.state.mapView = mode || "nation";
    // 領土・国境をその区分の配色で全面塗り直す。
    const r = Game.state.renderer;
    if (r && r.repaintTerritory) r.repaintTerritory();
    this._renderLegend();
  };

  // 現在の区分の凡例を描画（文明ビューは国ごとに色が異なるため凡例なし）。
  MapView._renderLegend = function () {
    if (!this.legendEl) return;
    const civ = Game.state.civ;
    const mode = Game.state.mapView || "nation";
    const items = (civ && civ.viewLegend) ? civ.viewLegend(mode) : [];
    if (!items.length) { this.legendEl.classList.remove("show"); this.legendEl.innerHTML = ""; return; }
    const title = this.sel ? this.sel.options[this.sel.selectedIndex].textContent : "";
    let html = '<div class="mvl-title">' + esc(title) + "</div>";
    for (let i = 0; i < items.length; i++) {
      const c = items[i].color;
      html += '<div class="mvl-row"><span class="mvl-sw" style="background:rgb(' +
        c[0] + "," + c[1] + "," + c[2] + ')"></span>' + esc(items[i].label) + "</div>";
    }
    this.legendEl.innerHTML = html;
    this.legendEl.classList.add("show");
  };

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

  Game.mapview = MapView;
})(window.Game);
