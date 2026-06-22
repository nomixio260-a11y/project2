// ツールバー UI。godpowers registry からボタンをグループ別に自動生成する。
(function (Game) {
  "use strict";

  // グループの表示順とラベル（未指定ツールは terrain 扱い）。
  const GROUPS = [
    { id: "terrain", label: "地形" },
    { id: "life", label: "生命" },
    { id: "civ", label: "文明" },
    { id: "disaster", label: "災害" },
  ];

  // ツールの絵文字アイコン（id 対応）。視認性のため文字より図像で示す。
  const ICONS = {
    raise: "⬆️", lower: "⬇️", water: "💧", sand: "🏜️", grass: "🌱", forest: "🌲", mountain: "⛰️",
    ignite: "🔥", herbivore: "🦌", predator: "🐺", human: "🧑", fertilize: "🌾",
    earthquake: "💥", meteor: "☄️", flood: "🌊", plague: "☣️", inspect: "🔍",
  };

  Game.toolbar = {
    init: function () {
      const container = document.getElementById("tool-buttons");
      container.innerHTML = "";
      this.buttons = {};
      this.toolMeta = {};
      const self = this;

      // グループごとに仕分け。
      const byGroup = {};
      Game.godpowers.list.forEach(function (tool) {
        const g = tool.group || "terrain";
        (byGroup[g] = byGroup[g] || []).push(tool);
      });

      function addButton(grid, tool) {
        const btn = document.createElement("button");
        btn.className = "tool-btn";
        btn.dataset.toolId = tool.id;
        btn.title = tool.hotkey.toUpperCase() + " · " + tool.label;
        btn.style.setProperty("--tool-color", tool.swatch);

        const key = document.createElement("span");
        key.className = "tb-key";
        key.textContent = tool.hotkey.toUpperCase();

        const icon = document.createElement("span");
        icon.className = "tb-icon";
        icon.textContent = ICONS[tool.id] || "✷";

        const label = document.createElement("span");
        label.className = "tb-label";
        label.textContent = tool.label;

        btn.appendChild(key);
        btn.appendChild(icon);
        btn.appendChild(label);
        btn.addEventListener("click", function () {
          Game.setActiveTool(tool.id);
        });
        grid.appendChild(btn);
        self.buttons[tool.id] = btn;
        self.toolMeta[tool.id] = { label: tool.label, swatch: tool.swatch, icon: ICONS[tool.id] || "✷" };
      }

      GROUPS.forEach(function (grp) {
        const tools = byGroup[grp.id];
        if (!tools || tools.length === 0) return;
        const header = document.createElement("div");
        header.className = "tool-group-label";
        header.textContent = grp.label;
        container.appendChild(header);
        const grid = document.createElement("div");
        grid.className = "tool-grid";
        container.appendChild(grid);
        tools.forEach(function (tool) {
          addButton(grid, tool);
        });
      });

      // 選択中ツール表示。
      this.selDot = document.querySelector("#tool-selected .ts-dot");
      this.selName = document.querySelector("#tool-selected .ts-name");

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

      // シミュレーション: 一時停止トグル。
      const pauseBtn = document.getElementById("sim-pause");
      if (pauseBtn) {
        pauseBtn.addEventListener("click", function () {
          Game.togglePaused();
        });
        this.pauseBtn = pauseBtn;
      }

      // シミュレーション: 速度ボタン。
      const speedControl = document.getElementById("speed-control");
      if (speedControl) {
        this.speedButtons = speedControl.querySelectorAll(".speed-btn");
        const self2 = this;
        this.speedButtons.forEach(function (b) {
          b.addEventListener("click", function () {
            Game.setSpeed(parseFloat(b.dataset.speed));
          });
        });
      }

      // モバイル: ツールバー開閉トグル。
      const toolbarEl = document.getElementById("toolbar");
      const toggle = document.getElementById("toolbar-toggle");
      if (toggle) {
        toggle.addEventListener("click", function () {
          toolbarEl.classList.toggle("collapsed");
        });
      }

      this.setActive(Game.state.activeToolId);
    },

    setActive: function (toolId) {
      for (const id in this.buttons) {
        this.buttons[id].classList.toggle("active", id === toolId);
      }
      // 選択中ツールの表示を更新。
      const meta = this.toolMeta && this.toolMeta[toolId];
      if (meta && this.selName) {
        this.selName.textContent = (meta.icon ? meta.icon + " " : "") + meta.label;
        if (this.selDot) this.selDot.style.background = meta.swatch;
      }
    },

    setBrushSize: function (size) {
      if (this.slider) this.slider.value = size;
      if (this.sizeLabel) this.sizeLabel.textContent = size;
    },

    setPaused: function (paused) {
      if (!this.pauseBtn) return;
      this.pauseBtn.textContent = paused ? "▶ 再生" : "⏸ 停止";
      this.pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
      this.pauseBtn.classList.toggle("paused", paused);
    },

    setSpeed: function (mult) {
      if (!this.speedButtons) return;
      this.speedButtons.forEach(function (b) {
        b.classList.toggle("active", parseFloat(b.dataset.speed) === mult);
      });
    },
  };
})(window.Game);
