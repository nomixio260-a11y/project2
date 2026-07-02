// ゲームループ。requestAnimationFrame で update → render を回す。
// systems 配列は将来のシミュレーション（生物・文明・炎の延焼など）の差し込み口。
(function (Game) {
  "use strict";

  function Engine(renderer, camera, input) {
    this.renderer = renderer;
    this.camera = camera;
    this.input = input;
    // 各 system は tick(world)（固定step・一時停止で止まる）と
    // update(dt, world)（毎フレーム・アニメ用）を任意で持つ。
    this.systems = [];
    this.running = false;
    this.last = 0;
    this.accumulator = 0; // シムtickの端数を蓄積
    this._loop = this._loop.bind(this);
  }

  // シミュレーションの一時停止/再生。
  Engine.prototype.setPaused = function (paused) {
    Game.config.sim.running = !paused;
  };

  // シミュレーション速度倍率。
  Engine.prototype.setSpeed = function (mult) {
    Game.config.sim.speed = mult;
  };

  Engine.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._loop);
  };

  Engine.prototype._loop = function (now) {
    if (!this.running) return;
    let dt = now - this.last;
    this.last = now;
    if (dt > 100) dt = 100; // タブ復帰時の巨大 dt をクランプ

    // 入力（カメラのパン）は常に毎フレーム。
    this.input.update(dt);
    // カメラのスムーズ移動（パネルクリック等の「飛ぶ」操作）。
    if (this.camera.update) this.camera.update(dt);

    const world = Game.state.world;
    const sim = Game.config.sim;
    const systems = this.systems;

    // 固定タイムステップでシミュレーションを進める（一時停止中は止まる）。
    if (sim.running) {
      this.accumulator += dt * sim.speed;
      let steps = 0;
      while (this.accumulator >= sim.tickMs && steps < sim.maxSteps) {
        for (let i = 0; i < systems.length; i++) {
          if (systems[i].tick) systems[i].tick(world);
        }
        this.accumulator -= sim.tickMs;
        steps++;
      }
      // 取りこぼし防止: catch-up 上限に達したら端数を捨てる。
      if (steps === sim.maxSteps) this.accumulator = 0;
    }

    // 毎フレームの update（アニメーション等。一時停止中も動く）。
    for (let i = 0; i < systems.length; i++) {
      if (systems[i].update) systems[i].update(dt, world);
    }

    // 描画。
    this.renderer.draw(this.camera);

    // 座標 HUD 更新。
    this._updateCoords();

    // 統計 HUD（内部で間引いて DOM 更新）。
    if (Game.hud) Game.hud.tick(dt);

    // 諸国パネル（内部で間引いて更新）。
    if (Game.nations) Game.nations.tick(dt);

    // 年代記パネル（内部で間引いて更新）。
    if (Game.chronicle) Game.chronicle.tick(dt);

    // インスペクタ（選択中の対象を毎フレーム更新・追従）。
    if (Game.inspector) Game.inspector.tick(dt);

    // イベント通知トースト。
    if (Game.toasts) Game.toasts.tick(dt);

    // 世界の概観パネル（開いている間だけ更新）。
    if (Game.overview) Game.overview.tick(dt);

    // ミニマップ（内部で間引いて描画）。
    if (Game.minimap) Game.minimap.draw(dt, this.camera);

    requestAnimationFrame(this._loop);
  };

  // 資源の絵文字（種別ごと）。
  const RES_EMOJI = { 1: "⛏", 2: "🐟", 3: "💎", 4: "🪙", 5: "🐎", 6: "🌶", 7: "🧂", 8: "🪵" };

  Engine.prototype._updateCoords = function () {
    const el = document.getElementById("coords");
    const tip = document.getElementById("hovertip");
    const mt = Game.state.mouseTile;
    const world = Game.state.world;
    if (!(mt.x >= 0 && world.inBounds(mt.x, mt.y))) {
      if (el) el.textContent = "";
      if (tip) tip.classList.remove("show");
      return;
    }
    const i = mt.y * world.width + mt.x;
    const civ = Game.state.civ;
    const owner = (civ && world.owner) ? world.owner[i] : 0;
    const k = owner > 0 && civ.kingdoms ? civ.kingdoms[owner] : null;

    // 下部バー: 詳細な地勢（標高・気温・湿度・植生・資源）。
    if (el) {
      const name = Game.TERRAIN_NAMES[world.terrain[i]];
      let txt = "(" + mt.x + "," + mt.y + ") " + name +
        " 標高" + world.elevation[i].toFixed(2) +
        " 気温" + world.temperature[i].toFixed(2) +
        " 湿度" + world.moisture[i].toFixed(2);
      if (world.fertility) txt += " 植生" + world.fertility[i].toFixed(2);
      if (world.resource && world.resource[i]) {
        const r = world.resource[i];
        txt += "  " + (RES_EMOJI[r] || "◆") + (Game.RESOURCE_NAMES[r] || "");
      }
      if (k) txt += "  ▣ " + k.name;
      el.textContent = txt;
    }

    // カーソルの吹き出し: 「今ここに何があるか」を一目で（国・人物・地形）。
    if (tip) {
      const ms = Game.state.mouseScreen;
      if (ms.x < 0) { tip.classList.remove("show"); return; }
      let html = "";
      // 近景では、カーソル直下の人物を拾って名前・役割・様子を示す。
      const person = this._personAt(mt.x, mt.y);
      if (person) {
        const kk = person.kid && civ.kingdoms ? civ.kingdoms[person.kid] : null;
        const LIFE = Game.lifeStages || { adult: 200, elder: 2600 };
        const stage = person.age < LIFE.adult ? "子供" : (person.age >= LIFE.elder ? "老人" : "成人");
        const role = Game.ROLE_NAMES ? Game.ROLE_NAMES[person.role] : "";
        html += '<div class="ht-title">' + (person._famed ? "★ " : "") + esc(person.name || "名も無き者") + "</div>";
        html += '<div class="ht-sub">' + esc((kk ? kk.name + "・" : "") + role + "（" + stage + "）") + "</div>";
      } else if (k) {
        // 領有国: 国名・政体・宗教・時代、統治者と人口。
        const era = (Game.eraOf && k.tech != null) ? Game.eraOf(k.tech) : "";
        html += '<div class="ht-title"><span class="ht-dot" style="background:rgb(' + k.color[0] + "," + k.color[1] + "," + k.color[2] + ')"></span>' + esc(k.name) + "</div>";
        html += '<div class="ht-sub">' + esc([k.gov, k.religion, era].filter(Boolean).join("・")) + "</div>";
        const ruler = (k.rulerRef && k.rulerRef.alive && k.rulerRef.name) ? k.rulerRef.name : k.ruler;
        html += '<div class="ht-sub">' + (ruler ? "👑" + esc(ruler) + "　" : "") + "👥" + (k.humanCount || 0) + "</div>";
      } else {
        // 無所属の地: 生物群系（地形名）。
        html += '<div class="ht-title">' + esc(Game.TERRAIN_NAMES[world.terrain[i]]) + "</div>";
        const res = world.resource && world.resource[i];
        if (res) html += '<div class="ht-sub">' + (RES_EMOJI[res] || "◆") + esc(Game.RESOURCE_NAMES[res] || "") + "</div>";
      }
      tip.innerHTML = html;
      // 位置: カーソル右上に少しずらし、画面端でははみ出さないよう反転する。
      tip.classList.add("show");
      const pad = 14, tw = tip.offsetWidth, thh = tip.offsetHeight;
      let px = ms.x + pad, py = ms.y - thh - 8;
      if (px + tw > window.innerWidth - 4) px = ms.x - tw - pad;
      if (py < 4) py = ms.y + pad;
      tip.style.left = px + "px";
      tip.style.top = py + "px";
    }
  };

  // カーソル直下（同タイル付近）の人物を1人返す。近景でのみ探す（負荷を抑える）。
  Engine.prototype._personAt = function (tx, ty) {
    const civ = Game.state.civ;
    if (!civ || !civ.people) return null;
    const scale = Game.config.tilePx * this.camera.zoom;
    if (scale < 5) return null; // 人が描かれない引きでは拾わない
    const cx = tx + 0.5, cy = ty + 0.5, R = 0.85, R2 = R * R;
    const people = civ.people;
    let best = null, bd = R2;
    for (let p = 0; p < people.length; p++) {
      const o = people[p];
      if (!o.alive) continue;
      const dx = o.x - cx, dy = o.y - cy, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
    });
  }

  Game.Engine = Engine;
})(window.Game);
