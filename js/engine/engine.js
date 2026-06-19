// ゲームループ。requestAnimationFrame で update → render を回す。
// systems 配列は将来のシミュレーション（生物・文明・炎の延焼など）の差し込み口。
(function (Game) {
  "use strict";

  function Engine(renderer, camera, input) {
    this.renderer = renderer;
    this.camera = camera;
    this.input = input;
    this.systems = []; // { update(dt, world) } を push して拡張
    this.running = false;
    this.last = 0;
    this._loop = this._loop.bind(this);
  }

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

    // 入力（カメラのパン）。
    this.input.update(dt);

    // 拡張システム。
    const world = Game.state.world;
    for (let i = 0; i < this.systems.length; i++) {
      this.systems[i].update(dt, world);
    }

    // 描画。
    this.renderer.draw(this.camera);

    // 座標 HUD 更新。
    this._updateCoords();

    requestAnimationFrame(this._loop);
  };

  Engine.prototype._updateCoords = function () {
    const el = document.getElementById("coords");
    if (!el) return;
    const mt = Game.state.mouseTile;
    const world = Game.state.world;
    if (mt.x >= 0 && world.inBounds(mt.x, mt.y)) {
      const name = Game.TERRAIN_NAMES[world.getTerrain(mt.x, mt.y)];
      el.textContent =
        "(" + mt.x + ", " + mt.y + ")  " + name +
        "  標高 " + world.getElevation(mt.x, mt.y).toFixed(2);
    } else {
      el.textContent = "";
    }
  };

  Game.Engine = Engine;
})(window.Game);
