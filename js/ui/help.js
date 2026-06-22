// ヘルプ＆凡例オーバーレイ。操作方法とバイオームの色見本を表示する。
// 右下の「?」ボタンで開閉。バイオーム一覧は TERRAIN 定義から自動生成。
(function (Game) {
  "use strict";

  const CONTROLS = [
    ["移動", "WASD / 矢印 / 右ドラッグ / 中ドラッグ"],
    ["ズーム", "マウスホイール（カーソル基点）／ピンチ"],
    ["ツール", "数字キー 1〜0・記号キー（ツールバー参照）"],
    ["人間を置く", "K（撒くと集まって国を興す／既存国に加入）"],
    ["調べる", "🔍ツール(I)で人や国をクリック → 詳細・追従"],
    ["ブラシ径", "[ と ] / スライダー"],
    ["一時停止", "P／停止ボタン"],
    ["諸国パネル", "右の一覧をクリックで首都へ移動＋詳細表示"],
    ["ミニマップ", "クリック/ドラッグで視点移動"],
  ];

  const Help = {
    overlay: null,
    open: false,
  };

  Help.init = function () {
    const btn = document.getElementById("help-toggle");
    const overlay = document.getElementById("help-overlay");
    if (!btn || !overlay) return;
    this.overlay = overlay;
    this._build(overlay);

    const self = this;
    btn.addEventListener("click", function () { self.toggle(); });
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) self.toggle(false);
    });
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && self.open) self.toggle(false);
    });
  };

  Help.toggle = function (force) {
    this.open = force === undefined ? !this.open : force;
    this.overlay.classList.toggle("show", this.open);
  };

  Help._build = function (overlay) {
    const panel = document.createElement("div");
    panel.className = "help-panel";

    const h1 = document.createElement("div");
    h1.className = "help-title";
    h1.textContent = "操作方法";
    panel.appendChild(h1);

    const ctrl = document.createElement("div");
    ctrl.className = "help-controls";
    for (let i = 0; i < CONTROLS.length; i++) {
      const row = document.createElement("div");
      row.className = "help-row";
      const a = document.createElement("span");
      a.className = "help-key";
      a.textContent = CONTROLS[i][0];
      const b = document.createElement("span");
      b.textContent = CONTROLS[i][1];
      row.appendChild(a);
      row.appendChild(b);
      ctrl.appendChild(row);
    }
    panel.appendChild(ctrl);

    const h2 = document.createElement("div");
    h2.className = "help-title";
    h2.textContent = "地形（バイオーム）";
    panel.appendChild(h2);

    const legend = document.createElement("div");
    legend.className = "help-legend";
    const T = Game.TERRAIN, C = Game.TERRAIN_COLORS, N = Game.TERRAIN_NAMES;
    for (const key in T) {
      const id = T[key];
      const item = document.createElement("div");
      item.className = "legend-item";
      const sw = document.createElement("span");
      sw.className = "legend-swatch";
      sw.style.background = C[id];
      const lbl = document.createElement("span");
      lbl.textContent = N[id];
      item.appendChild(sw);
      item.appendChild(lbl);
      legend.appendChild(item);
    }
    panel.appendChild(legend);

    const hint = document.createElement("div");
    hint.className = "help-foot";
    hint.textContent = "閉じる: もう一度「?」/ Esc / 背景をタップ";
    panel.appendChild(hint);

    overlay.appendChild(panel);
  };

  Game.help = Help;
})(window.Game);
