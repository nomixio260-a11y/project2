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

    // ミニマップ（内部で間引いて描画）。
    if (Game.minimap) Game.minimap.draw(dt, this.camera);

    requestAnimationFrame(this._loop);
  };

  Engine.prototype._updateCoords = function () {
    const el = document.getElementById("coords");
    if (!el) return;
    const mt = Game.state.mouseTile;
    const world = Game.state.world;
    if (mt.x >= 0 && world.inBounds(mt.x, mt.y)) {
      const i = mt.y * world.width + mt.x;
      const name = Game.TERRAIN_NAMES[world.terrain[i]];
      let txt = "(" + mt.x + "," + mt.y + ") " + name +
        " 標高" + world.elevation[i].toFixed(2) +
        " 気温" + world.temperature[i].toFixed(2) +
        " 湿度" + world.moisture[i].toFixed(2);
      if (world.fertility) txt += " 植生" + world.fertility[i].toFixed(2);
      // 領有国（国名）。
      const civ = Game.state.civ;
      if (civ && world.owner) {
        const id = world.owner[i];
        const k = id > 0 ? civ.kingdoms[id] : null;
        if (k) txt += "  " + k.name + "（" + (k.religion || "") + "）";
      }
      el.textContent = txt;
    } else {
      el.textContent = "";
    }
  };

  Game.Engine = Engine;
})(window.Game);
