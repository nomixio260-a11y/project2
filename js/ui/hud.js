// ライブ統計 HUD。シミュレーションの状態（個体数・王国・延焼・FPS）を
// 画面右上に表示する。engine から毎フレーム tick(dt) されるが、
// DOM 更新は負荷軽減のため一定間隔（updateMs）に間引く。
(function (Game) {
  "use strict";

  const S = Game.SPECIES;
  const UPDATE_MS = 250; // HUD の再描画間隔

  const Hud = {
    el: null,
    rows: null,
    _acc: 0,
    _fps: 0,
    _fpsAcc: 0,
    _fpsFrames: 0,
  };

  // DOM を構築。index.html の #hud にぶら下げる。
  Hud.init = function () {
    const el = document.getElementById("hud");
    if (!el) return;
    this.el = el;
    this.rows = {};
    const defs = [
      ["pop", "総個体数"],
      ["herb", "草食"],
      ["pred", "肉食"],
      ["kingdoms", "王国"],
      ["fires", "延焼"],
      ["fps", "FPS"],
    ];
    el.innerHTML = "";
    for (let i = 0; i < defs.length; i++) {
      const key = defs[i][0];
      const label = defs[i][1];
      const row = document.createElement("div");
      row.className = "hud-row";
      const l = document.createElement("span");
      l.className = "hud-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "hud-value";
      v.textContent = "0";
      row.appendChild(l);
      row.appendChild(v);
      el.appendChild(row);
      this.rows[key] = v;
    }
  };

  // 毎フレーム呼ばれる。FPS を平滑化し、UPDATE_MS ごとに DOM を更新する。
  Hud.tick = function (dt) {
    if (!this.el) return;
    this._fpsAcc += dt;
    this._fpsFrames++;
    this._acc += dt;
    if (this._acc < UPDATE_MS) return;

    // 平滑化 FPS。
    if (this._fpsAcc > 0) {
      this._fps = (this._fpsFrames * 1000) / this._fpsAcc;
    }
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._acc = 0;

    this._render();
  };

  // Game.state から各種カウントを集計して反映。
  Hud.sample = function () {
    const st = Game.state;
    let herb = 0;
    let pred = 0;
    const e = st.entities;
    if (e) {
      for (let i = 0; i < e.count; i++) {
        if (!e.alive[i]) continue;
        if (e.type[i] === S.PREDATOR) pred++;
        else herb++;
      }
    }
    let kingdoms = 0;
    if (st.civ && st.civ.kingdoms) {
      const ks = st.civ.kingdoms;
      for (let id = 1; id < ks.length; id++) {
        if (ks[id] && ks[id].alive) kingdoms++;
      }
    }
    const fires = st.fire && st.fire.active ? st.fire.active.length : 0;
    return { herb: herb, pred: pred, pop: herb + pred, kingdoms: kingdoms, fires: fires };
  };

  Hud._render = function () {
    const s = this.sample();
    this.rows.pop.textContent = String(s.pop);
    this.rows.herb.textContent = String(s.herb);
    this.rows.pred.textContent = String(s.pred);
    this.rows.kingdoms.textContent = String(s.kingdoms);
    this.rows.fires.textContent = String(s.fires);
    this.rows.fps.textContent = String(Math.round(this._fps));
  };

  Game.hud = Hud;
})(window.Game);
