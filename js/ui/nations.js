// 諸国パネル。全王国の要約（人口・都市・領土・外交）を一覧表示する。
// 行クリックでその国の首都へカメラ移動。負荷軽減のため間引いて更新する。
(function (Game) {
  "use strict";

  const UPDATE_MS = 600;

  const Nations = {
    el: null,
    body: null,
    countEl: null,
    _acc: 0,
    collapsed: false,
  };

  Nations.init = function () {
    const el = document.getElementById("nations");
    if (!el) return;
    this.el = el;
    el.innerHTML = "";

    const header = document.createElement("div");
    header.className = "nations-header";
    const title = document.createElement("span");
    title.textContent = "諸国";
    const count = document.createElement("span");
    count.className = "nations-count";
    count.textContent = "0";
    header.appendChild(title);
    header.appendChild(count);
    el.appendChild(header);
    this.countEl = count;

    const body = document.createElement("div");
    body.className = "nations-body";
    el.appendChild(body);
    this.body = body;

    const self = this;
    header.addEventListener("click", function () {
      self.collapsed = !self.collapsed;
      el.classList.toggle("collapsed", self.collapsed);
    });
    // 既定: 携帯では畳む。
    if (Game.device && Game.device.isPhone) {
      this.collapsed = true;
      el.classList.add("collapsed");
    }
  };

  Nations.tick = function (dt) {
    if (!this.el) return;
    this._acc += dt;
    if (this._acc < UPDATE_MS) return;
    this._acc = 0;
    this._render();
  };

  Nations._render = function () {
    const civ = Game.state.civ;
    if (!civ || !civ.getNations) return;
    const list = civ.getNations();
    this.countEl.textContent = String(list.length);
    if (this.collapsed) return;

    const body = this.body;
    body.innerHTML = "";
    const max = Math.min(list.length, 12); // 上位12国
    for (let i = 0; i < max; i++) {
      const n = list[i];
      const row = document.createElement("div");
      row.className = "nation-row";

      const sw = document.createElement("span");
      sw.className = "nation-swatch";
      sw.style.background = "rgb(" + n.color[0] + "," + n.color[1] + "," + n.color[2] + ")";
      // 色覚補助: 色だけに頼らず、国名の頭文字を見分けの手がかりとして重ねる。
      sw.textContent = n.name ? n.name.charAt(0) : "?";

      const info = document.createElement("div");
      info.className = "nation-info";
      const name = document.createElement("div");
      name.className = "nation-name";
      name.textContent = n.name;
      const meta = document.createElement("div");
      meta.className = "nation-meta";
      let badges = "";
      if (n.wars.length) badges += " ⚔" + n.wars.length;
      if (n.allies.length) badges += " 🤝" + n.allies.length;
      meta.textContent = "👤" + n.pop + " 🏛" + n.cities + " ▦" + n.tiles + badges;

      const meta2 = document.createElement("div");
      meta2.className = "nation-meta";
      meta2.textContent = (n.era || "") + " ・ " + (n.religion || "") +
        " ・ " + (n.trait || "") + (n.unrest >= 70 ? " ⚠不穏" : "");

      info.appendChild(name);
      info.appendChild(meta);
      info.appendChild(meta2);

      row.appendChild(sw);
      row.appendChild(info);
      row.title = n.name + "\n統治者: " + n.ruler + "（" + n.gov + " / " + n.trait + "）" +
        "\n時代: " + n.era + " / 宗教: " + n.religion + " / 技術: " + n.tech +
        "\n富: " + n.wealth + " / 不満: " + n.unrest +
        (n.wars.length ? "\n交戦: " + n.wars.join(", ") : "") +
        (n.allies.length ? "\n同盟: " + n.allies.join(", ") : "");
      (function (cap, id) {
        row.addEventListener("click", function () {
          const cam = Game.state.camera;
          if (cam && cap) (cam.glideToTile ? cam.glideToTile(cap.x, cap.y) : cam.centerOnTile(cap.x, cap.y)); // 滑らかに移動
          if (Game.inspector) Game.inspector.selectNation(id); // 詳細を開く
        });
      })(n.capital, n.id);

      body.appendChild(row);
    }
  };

  Game.nations = Nations;
})(window.Game);
