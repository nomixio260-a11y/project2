// モバイル下部ナビ。スマホでは各パネルを「下からのシート」として開閉し、
// 地図を最大限広く保つ。シートは同時に一つだけ開く（排他）。
// デスクトップでは CSS で非表示・ここでは何も壊さない。
(function (Game) {
  "use strict";

  const Nav = { el: null, buttons: {}, current: null };

  Nav.init = function () {
    const el = document.getElementById("bottombar");
    if (!el) return;
    this.el = el;
    const self = this;

    el.querySelectorAll(".bb-btn").forEach(function (btn) {
      const key = btn.dataset.sheet;
      self.buttons[key] = btn;
      btn.addEventListener("click", function (e) {
        e.stopPropagation(); // 概観/設定の「外側クリックで閉じる」に拾わせない
        self.toggle(key);
      });
    });

    // 道具シート内でツールを選んだら自動で閉じる（選ぶ→すぐ地図に触れる導線）。
    const toolButtons = document.getElementById("tool-buttons");
    if (toolButtons) {
      toolButtons.addEventListener("click", function (e) {
        if (!self._isPhone()) return;
        let n = e.target;
        while (n && n !== toolButtons) {
          if (n.classList && n.classList.contains("tool-btn")) {
            setTimeout(function () { self.close(); }, 120); // 選択のフィードバックを見せてから閉じる
            return;
          }
          n = n.parentNode;
        }
      });
    }

    // 地図をタップしたらシートを閉じる（シートの外＝地図に戻る操作として自然）。
    const canvas = document.getElementById("game");
    if (canvas) {
      canvas.addEventListener("touchstart", function () {
        self._reconcile();
        if (self.current) self.close();
      }, { passive: true });
    }
  };

  Nav._isPhone = function () {
    return window.matchMedia && window.matchMedia("(max-width: 680px)").matches;
  };

  // key: "tools" | "info" | "overview" | "settings"
  Nav.toggle = function (key) {
    this._reconcile();
    if (this.current === key) { this.close(); return; }
    this.close();
    this.current = key;
    this._apply(key, true);
    if (this.buttons[key]) this.buttons[key].classList.add("on");
  };

  // 概観/設定は自前の「外側タップで閉じる」を持つため、実際の表示状態と
  // ナビの記憶（current）がずれることがある。実 DOM を見て補正する。
  Nav._reconcile = function () {
    if (this.current === "overview" || this.current === "settings") {
      const p = document.getElementById(this.current + "-panel");
      if (p && !p.classList.contains("show")) {
        if (this.buttons[this.current]) this.buttons[this.current].classList.remove("on");
        this.current = null;
      }
    }
  };

  Nav.close = function () {
    if (!this.current) return;
    this._apply(this.current, false);
    if (this.buttons[this.current]) this.buttons[this.current].classList.remove("on");
    this.current = null;
  };

  Nav._apply = function (key, open) {
    if (key === "tools") {
      const tb = document.getElementById("toolbar");
      if (tb) tb.classList.toggle("collapsed", !open);
    } else if (key === "info") {
      const sb = document.getElementById("sidebar");
      if (sb) sb.classList.toggle("open", open);
    } else if (key === "overview") {
      // 内部状態（open / トップバーのボタン表示）も同期するため、モジュールの toggle を使う。
      if (Game.overview && Game.overview.toggle) Game.overview.toggle(open);
      else { const ov = document.getElementById("overview-panel"); if (ov) ov.classList.toggle("show", open); }
    } else if (key === "settings") {
      if (Game.settings && Game.settings.toggle) Game.settings.toggle(open);
      else { const st = document.getElementById("settings-panel"); if (st) st.classList.toggle("show", open); }
    }
  };

  Game.mobilenav = Nav;
})(window.Game);
