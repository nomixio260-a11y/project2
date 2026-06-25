// 設定パネル。表示・挙動のオン/オフを切り替える（⚙ ボタンで開閉）。
// 変更は Game.config.settings に反映され、各システム/描画が参照する。
(function (Game) {
  "use strict";

  const OPTS = [
    ["disasters", "自然災害", "噴火・地震・干ばつの自然発生"],
    ["dayNight", "昼夜サイクル", "照明と人々の生活リズム"],
    ["weather", "天候", "雲・雨・雷"],
    ["labels", "国名ラベル", "地図上の国名表示"],
    ["resources", "資源アイコン", "鉱石・漁場・宝石の表示"],
  ];

  const Settings = { panel: null, btn: null, open: false };

  Settings.init = function () {
    const btn = document.getElementById("settings-toggle");
    const panel = document.getElementById("settings-panel");
    if (!btn || !panel) return;
    this.panel = panel;
    this.btn = btn;
    const s = Game.config.settings || (Game.config.settings = {});

    let html = '<div class="panel-head">設定</div>';
    for (let i = 0; i < OPTS.length; i++) {
      const key = OPTS[i][0];
      html += '<label class="set-row" title="' + OPTS[i][2] + '">' +
        '<span class="set-name">' + OPTS[i][1] + "</span>" +
        '<input type="checkbox" class="set-toggle" data-key="' + key + '"' + (s[key] !== false ? " checked" : "") + ">" +
        '<span class="set-switch"></span></label>';
    }
    panel.innerHTML = html;

    const self = this;
    panel.querySelectorAll(".set-toggle").forEach(function (cb) {
      cb.addEventListener("change", function () {
        Game.config.settings[cb.dataset.key] = cb.checked;
      });
    });
    btn.addEventListener("click", function (e) { e.stopPropagation(); self.toggle(); });
    document.addEventListener("click", function (e) {
      if (self.open && !panel.contains(e.target) && e.target !== btn) self.toggle(false);
    });
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && self.open) self.toggle(false);
    });
  };

  Settings.toggle = function (force) {
    this.open = force === undefined ? !this.open : force;
    this.panel.classList.toggle("show", this.open);
    if (this.btn) this.btn.classList.toggle("on", this.open);
  };

  Game.settings = Settings;
})(window.Game);
