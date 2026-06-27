// インスペクタ。「調べる」ツールでクリックした人や国を選択し、詳細を表示する。
// 選択対象は毎フレーム最新情報に更新し、地図上にハイライトの輪を描く。追従も可能。
(function (Game) {
  "use strict";

  const ROLE_NAME = ["開拓者", "農民", "建築家", "兵士", "鍛冶", "商人", "神官"];
  // state（_think が設定）→ 行動の説明。
  const ACT = {
    1: "食料を探している", 2: "仲間のもとへ向かう", 3: "町へ帰る", 4: "土地を開拓中",
    5: "戦っている", 6: "建設中", 7: "畑を耕す", 8: "敵から逃走中",
    9: "国を探している", 10: "定住先を探す", 11: "さまよっている", 12: "職場で働く",
    13: "休息中", 14: "退却中", 15: "航海中", 16: "狩りをしている",
  };
  const UPDATE_MS = 220;

  const Inspector = {
    el: null, titleEl: null, bodyEl: null, followBtn: null,
    sel: null,       // { kind:'person', ref } | { kind:'nation', id }
    follow: false,
    _acc: 0,
  };

  Inspector.init = function () {
    const el = document.getElementById("inspector");
    if (!el) return;
    this.el = el;
    el.innerHTML =
      '<div class="insp-head">' +
      '<span class="insp-title">—</span>' +
      '<span class="insp-actions">' +
      '<button class="insp-follow" title="追従">◎ 追従</button>' +
      '<button class="insp-close" title="閉じる">✕</button>' +
      '</span></div>' +
      '<div class="insp-body"></div>';
    this.titleEl = el.querySelector(".insp-title");
    this.bodyEl = el.querySelector(".insp-body");
    this.followBtn = el.querySelector(".insp-follow");
    const self = this;
    el.querySelector(".insp-close").addEventListener("click", function () { self.clear(); });
    this.followBtn.addEventListener("click", function () {
      self.follow = !self.follow;
      self.followBtn.classList.toggle("on", self.follow);
    });
  };

  // タイル (tx,ty) 付近の人/国を選択する。
  Inspector.pickAt = function (tx, ty) {
    const civ = Game.state.civ;
    if (!civ) return;
    const cxp = tx + 0.5, cyp = ty + 0.5;
    // 最寄りの人。
    let bp = null, bpd = 1e9;
    const people = civ.people;
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      if (!p.alive) continue;
      const dx = p.x - cxp, dy = p.y - cyp, d = dx * dx + dy * dy;
      if (d < bpd) { bpd = d; bp = p; }
    }
    // 最寄りの都市（国）。
    let bc = null, bcd = 1e9;
    const ks = civ.kingdoms;
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id];
      if (!k || !k.alive || !k.cities) continue;
      for (let c = 0; c < k.cities.length; c++) {
        const dx = k.cities[c].x + 0.5 - cxp, dy = k.cities[c].y + 0.5 - cyp, d = dx * dx + dy * dy;
        if (d < bcd) { bcd = d; bc = k; }
      }
    }
    // 近い人を優先。少し離れていれば近くの町（国）。さらに緩めて人。
    if (bp && bpd < 1.8 * 1.8) this.sel = { kind: "person", ref: bp };
    else if (bc && bcd < 6 * 6) this.sel = { kind: "nation", id: bc.id };
    else if (bp && bpd < 4 * 4) this.sel = { kind: "person", ref: bp };
    else { this.clear(); return; }

    this.el.classList.add("show");
    this._acc = UPDATE_MS;
    this.tick(0);
  };

  // 諸国パネルなどから国を直接選択する。
  Inspector.selectNation = function (id) {
    const civ = Game.state.civ;
    const k = civ && civ.kingdoms[id];
    if (!k || !k.alive || !this.el) return;
    this.sel = { kind: "nation", id: id };
    this.el.classList.add("show");
    this._acc = UPDATE_MS;
    this.tick(0);
  };

  Inspector.clear = function () {
    this.sel = null;
    this.follow = false;
    if (this.followBtn) this.followBtn.classList.remove("on");
    if (this.el) this.el.classList.remove("show");
    Game.state.selection = null;
  };

  Inspector.tick = function (dt) {
    if (!this.sel || !this.el) return;
    const civ = Game.state.civ;

    // 選択対象の現在位置・色を求め、地図ハイライトと追従に使う。
    let sx = null, sy = null, color = "#8fd0ff", dead = false;
    if (this.sel.kind === "person") {
      const p = this.sel.ref;
      if (!p.alive) dead = true;
      else {
        sx = p.x; sy = p.y;
        const k = p.kid ? civ.kingdoms[p.kid] : null;
        const c = k ? k.color : [150, 140, 122];
        color = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
      }
    } else {
      const k = civ.kingdoms[this.sel.id];
      if (!k || !k.alive) dead = true;
      else {
        sx = k.cities[0].x + 0.5; sy = k.cities[0].y + 0.5;
        color = "rgb(" + k.color[0] + "," + k.color[1] + "," + k.color[2] + ")";
      }
    }

    if (sx !== null) {
      Game.state.selection = { x: sx, y: sy, color: color, kind: this.sel.kind };
      if (this.follow && Game.state.camera) Game.state.camera.centerOnTile(sx | 0, sy | 0);
    } else {
      Game.state.selection = null;
    }

    // DOM 更新は間引く。
    this._acc += dt;
    if (this._acc < UPDATE_MS) return;
    this._acc = 0;
    this._render(dead);
  };

  Inspector._render = function (dead) {
    const civ = Game.state.civ;
    if (this.sel.kind === "person") {
      const p = this.sel.ref;
      if (dead) {
        this.titleEl.textContent = "🧑 ある人物";
        this.bodyEl.innerHTML = '<div class="insp-dead">この人物は世を去りました。</div>';
        return;
      }
      const k = p.kid ? civ.kingdoms[p.kid] : null;
      const LIFE = Game.lifeStages || { adult: 200, elder: 2600 };
      const stage = p.age < LIFE.adult ? "子供" : (p.age >= LIFE.elder ? "老人" : "成人");
      const role = p.kid ? (ROLE_NAME[p.role] || "民") : "放浪者";
      const act = p.sailing ? "海を渡っている" : (ACT[p.state] || "活動中");
      const hp = Math.round(Math.max(0, Math.min(1, p.food)) * 100);
      const gear = p.gear ? ("装備 Lv" + p.gear) : "素手";
      this.titleEl.textContent = (k ? "🧑 " + role : "🚶 放浪者");
      this.bodyEl.innerHTML =
        row("所属", k ? swatch(k.color) + " " + esc(k.name) : "なし（放浪者）") +
        row("役割", role + "（" + stage + "）") +
        row("行動", act) +
        bar("体力", hp, false) +
        row("装備", gear);
      return;
    }
    // 国。
    const k = civ.kingdoms[this.sel.id];
    if (dead || !k || !k.alive) {
      this.titleEl.textContent = "🏰 ある国";
      this.bodyEl.innerHTML = '<div class="insp-dead">この国は滅亡しました。</div>';
      return;
    }
    let info = null;
    if (civ.getNations) { const list = civ.getNations(); info = list.find(function (n) { return n.id === k.id; }); }
    const res = k.res || { ore: 0, fish: 0, gems: 0 };
    const resStr = [res.ore ? "⛏" + res.ore : "", res.fish ? "🐟" + res.fish : "", res.gems ? "💎" + res.gems : ""].filter(Boolean).join(" ") || "なし";
    this.titleEl.innerHTML = swatch(k.color) + " " + esc(k.name) +
      (k.plague > 0 ? ' <span class="insp-tag bad">☣ 疫病</span>' : "") +
      (k.famine ? ' <span class="insp-tag bad">🌾 飢饉</span>' : "");
    this.bodyEl.innerHTML =
      row("統治", esc(k.ruler) + "（" + esc(k.gov) + "）") +
      row("時代", (info ? info.era : "") + " · " + esc(k.religion)) +
      row("気質", esc(k.trait.name)) +
      row("人口", String(k.humanCount) + " 人") +
      row("都市", String(k.cities.length) + " · 領土 " + k.tileCount) +
      row("国力", "💰" + Math.round(k.wealth) + " 🔬" + Math.round(k.tech) + " ⚔" + Math.round(this._mil(k))) +
      bar("不満", Math.round(k.unrest), true) +
      row("食料", (info ? info.food : Math.round(k.food || 0)) + (k.famine ? " ⚠飢饉" : "")) +
      row("資源", resStr) +
      (info && info.techCount ? row("技術", info.techCount + "件 " + (info.latestTechs.length ? "（" + info.latestTechs.join("・") + "）" : "")) : "") +
      (info && (info.wars.length || info.allies.length)
        ? row("外交", (info.wars.length ? "⚔" + info.wars.length + " " : "") + (info.allies.length ? "🤝" + info.allies.length : "")) : "");
  };

  Inspector._mil = function (k) {
    const civ = Game.state.civ;
    return civ && civ._military ? civ._military(k) : (k.roleCount ? k.roleCount[3] : 0);
  };

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  function row(label, val) {
    return '<div class="insp-row"><span class="insp-k">' + label + '</span><span class="insp-v">' + val + "</span></div>";
  }
  function bar(label, pct, highBad) {
    const col = highBad
      ? (pct >= 70 ? "var(--bad)" : pct >= 40 ? "var(--warn)" : "var(--good)")
      : (pct >= 70 ? "var(--good)" : pct >= 40 ? "var(--warn)" : "var(--bad)");
    return '<div class="insp-row"><span class="insp-k">' + label + '</span>' +
      '<span class="insp-bar"><i style="width:' + pct + "%;background:" + col + '"></i></span>' +
      '<span class="insp-v">' + pct + "%</span></div>";
  }
  function swatch(c) {
    return '<span class="insp-sw" style="background:rgb(' + c[0] + "," + c[1] + "," + c[2] + ')"></span>';
  }

  Game.inspector = Inspector;
})(window.Game);
