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
    ["autoSeed", "最初から生きた世界", "新しい世界に文明と野生を芽吹かせる（オフなら空の世界から始まる）"],
  ];

  const Settings = { panel: null, btn: null, open: false };
  const STORE_KEY = "fms_settings";

  Settings.init = function () {
    const btn = document.getElementById("settings-toggle");
    const panel = document.getElementById("settings-panel");
    if (!btn || !panel) return;
    this.panel = panel;
    this.btn = btn;
    const s = Game.config.settings || (Game.config.settings = {});
    // 保存済み設定を読み込んで反映（再読込でも維持）。
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (saved) for (const k in saved) if (k in s) s[k] = !!saved[k];
    } catch (e) { /* localStorage 不可なら既定値 */ }

    let html = '<div class="panel-head">設定</div>';
    for (let i = 0; i < OPTS.length; i++) {
      const key = OPTS[i][0];
      html += '<label class="set-row" title="' + OPTS[i][2] + '">' +
        '<span class="set-name">' + OPTS[i][1] + "</span>" +
        '<input type="checkbox" class="set-toggle" data-key="' + key + '"' + (s[key] !== false ? " checked" : "") + ">" +
        '<span class="set-switch"></span></label>';
    }
    // データ: 保存・読込・スクリーンショット。
    html += '<div class="panel-head" style="margin-top:10px">データ</div>' +
      '<div class="set-actions">' +
      '<button class="set-btn" id="data-save">💾 保存</button>' +
      '<button class="set-btn" id="data-load">📂 読込</button>' +
      '<button class="set-btn" id="data-shot">📸 画像</button>' +
      '<input type="file" id="data-file" accept="application/json,.json" style="display:none">' +
      '</div>';
    panel.innerHTML = html;
    // データ操作の配線。
    const saveBtn = panel.querySelector("#data-save");
    const loadBtn = panel.querySelector("#data-load");
    const shotBtn = panel.querySelector("#data-shot");
    const fileInp = panel.querySelector("#data-file");
    if (saveBtn) saveBtn.addEventListener("click", function (e) { e.stopPropagation(); if (Game.persistence) Game.persistence.save(); });
    if (shotBtn) shotBtn.addEventListener("click", function (e) { e.stopPropagation(); if (Game.persistence) Game.persistence.screenshot(); });
    if (loadBtn && fileInp) {
      loadBtn.addEventListener("click", function (e) { e.stopPropagation(); fileInp.click(); });
      fileInp.addEventListener("change", function () { if (fileInp.files && fileInp.files[0] && Game.persistence) { Game.persistence.loadFile(fileInp.files[0]); fileInp.value = ""; } });
    }

    const self = this;
    panel.querySelectorAll(".set-toggle").forEach(function (cb) {
      cb.addEventListener("change", function () {
        Game.config.settings[cb.dataset.key] = cb.checked;
        self._save();
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

  Settings._save = function () {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(Game.config.settings)); } catch (e) { /* ignore */ }
  };

  Settings.toggle = function (force) {
    this.open = force === undefined ? !this.open : force;
    this.panel.classList.toggle("show", this.open);
    if (this.btn) this.btn.classList.toggle("on", this.open);
  };

  Game.settings = Settings;
})(window.Game);
