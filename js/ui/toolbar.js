// ツールバー UI。godpowers registry からボタンを自動生成する。
(function (Game) {
  "use strict";

  Game.toolbar = {
    init: function () {
      const container = document.getElementById("tool-buttons");
      container.innerHTML = "";
      this.buttons = {};

      const self = this;
      Game.godpowers.list.forEach(function (tool) {
        const btn = document.createElement("button");
        btn.className = "tool-btn";
        btn.dataset.toolId = tool.id;

        const swatch = document.createElement("div");
        swatch.className = "swatch";
        swatch.style.background = tool.swatch;

        const label = document.createElement("span");
        label.textContent = tool.hotkey + " " + tool.label;

        btn.appendChild(swatch);
        btn.appendChild(label);
        btn.addEventListener("click", function () {
          Game.setActiveTool(tool.id);
        });

        container.appendChild(btn);
        self.buttons[tool.id] = btn;
      });

      // ブラシサイズスライダー。
      const slider = document.getElementById("brush-size");
      const sizeLabel = document.getElementById("brush-size-label");
      slider.value = Game.state.brush.size;
      sizeLabel.textContent = Game.state.brush.size;
      slider.addEventListener("input", function () {
        Game.setBrushSize(parseInt(slider.value, 10));
      });
      this.slider = slider;
      this.sizeLabel = sizeLabel;

      // 再生成ボタン。
      document.getElementById("regen").addEventListener("click", function () {
        Game.regenerate();
      });

      this.setActive(Game.state.activeToolId);
    },

    setActive: function (toolId) {
      for (const id in this.buttons) {
        this.buttons[id].classList.toggle("active", id === toolId);
      }
    },

    setBrushSize: function (size) {
      if (this.slider) this.slider.value = size;
      if (this.sizeLabel) this.sizeLabel.textContent = size;
    },
  };
})(window.Game);
