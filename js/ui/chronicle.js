// 年代記パネル。世界の主要な出来事（建国・戦争・滅亡・時代の進歩・植民など）を
// 時系列で表示する。civ.getEvents() から取得し、間引いて更新する。
(function (Game) {
  "use strict";

  const UPDATE_MS = 700;

  const Chronicle = {
    el: null,
    body: null,
    _acc: 0,
    _lastLen: -1,
    collapsed: false,
  };

  Chronicle.init = function () {
    const el = document.getElementById("chronicle");
    if (!el) return;
    this.el = el;
    el.innerHTML = "";

    const header = document.createElement("div");
    header.className = "nations-header";
    const title = document.createElement("span");
    title.textContent = "年代記";
    const hint = document.createElement("span");
    hint.className = "nations-count";
    hint.textContent = "📜";
    header.appendChild(title);
    header.appendChild(hint);
    el.appendChild(header);

    const body = document.createElement("div");
    body.className = "chronicle-body";
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

  Chronicle.tick = function (dt) {
    if (!this.el) return;
    this._acc += dt;
    if (this._acc < UPDATE_MS) return;
    this._acc = 0;
    if (this.collapsed) return;
    const civ = Game.state.civ;
    if (!civ || !civ.getEvents) return;
    const list = civ.getEvents(10);
    // 件数が変わらなければ DOM 更新を省く。
    if (list.length === this._lastLen && list.length > 0 &&
        this.body.firstChild && this.body.firstChild._txt === list[0].text) return;
    this._lastLen = list.length;

    const body = this.body;
    body.innerHTML = "";
    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chronicle-row chronicle-empty";
      empty.textContent = "まだ何も起きていない…";
      body.appendChild(empty);
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const row = document.createElement("div");
      row.className = "chronicle-row";
      row._txt = e.text;
      const yr = document.createElement("span");
      yr.className = "chronicle-year";
      yr.textContent = e.year + "年";
      const tx = document.createElement("span");
      tx.className = "chronicle-text";
      tx.textContent = e.text;
      row.appendChild(yr);
      row.appendChild(tx);
      body.appendChild(row);
    }
  };

  Game.chronicle = Chronicle;
})(window.Game);
