// ミニマップ。マップ全体の地形＋領土を縮小表示し、現在のビューポートを矩形で示す。
// クリック/ドラッグでカメラをその地点へ移動できる。
(function (Game) {
  "use strict";

  const MAX = 168; // 最大表示辺(px)

  const Minimap = {
    canvas: null,
    ctx: null,
    scale: 1,
    _acc: 0,
  };

  Minimap.init = function () {
    const canvas = document.getElementById("minimap");
    if (!canvas) return;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this._fit();

    const self = this;
    let dragging = false;
    function jump(ev) {
      const rect = canvas.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * canvas.width;
      const py = (ev.clientY - rect.top) / rect.height * canvas.height;
      self._jumpTo(px, py);
    }
    canvas.addEventListener("pointerdown", function (ev) {
      dragging = true;
      canvas.setPointerCapture(ev.pointerId);
      jump(ev);
    });
    canvas.addEventListener("pointermove", function (ev) {
      if (dragging) jump(ev);
    });
    canvas.addEventListener("pointerup", function () {
      dragging = false;
    });
  };

  // world サイズに合わせてキャンバス解像度を設定。
  Minimap._fit = function () {
    const world = Game.state.world;
    if (!world || !this.canvas) return;
    const aspect = world.width / world.height;
    let w = MAX;
    let h = MAX;
    if (aspect > 1) h = Math.round(MAX / aspect);
    else w = Math.round(MAX * aspect);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.scale = w / world.width;
  };

  // ミニマップ上の px をワールド中心にしてカメラ移動。
  Minimap._jumpTo = function (px, py) {
    const cam = Game.state.camera;
    const world = Game.state.world;
    if (!cam || !world) return;
    const tilePx = Game.config.tilePx;
    const tx = px / this.scale;
    const ty = py / this.scale;
    cam.x = tx * tilePx - (cam.viewW / cam.zoom) / 2;
    cam.y = ty * tilePx - (cam.viewH / cam.zoom) / 2;
    cam.clamp();
  };

  // 毎フレーム呼ばれる（負荷軽減のため間引き描画）。
  Minimap.draw = function (dt, camera) {
    if (!this.ctx) return;
    this._acc += dt || 16;
    if (this._acc < 80) return; // ~12fps
    this._acc = 0;

    const renderer = Game.state.renderer;
    const world = Game.state.world;
    if (!renderer || !world) return;
    if (this.scale * world.width !== this.canvas.width) this._fit();

    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    // 地形（オフスクリーンを縮小ブリット）。
    ctx.drawImage(renderer.terrainCanvas, 0, 0, W, H);
    // 領土オーバーレイ。
    ctx.globalAlpha = 0.5;
    ctx.drawImage(renderer.territoryCanvas, 0, 0, W, H);
    // 国境（くっきり）。
    if (renderer.borderCanvas) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(renderer.borderCanvas, 0, 0, W, H);
    }
    ctx.globalAlpha = 1;

    // 首都マーカー（生存国の首都を小さな点で示す）。
    const civ = Game.state.civ;
    const s = this.scale;
    if (civ && civ.kingdoms) {
      const ks = civ.kingdoms;
      for (let id = 1; id < ks.length; id++) {
        const k = ks[id];
        if (!k || !k.alive || !k.cities || !k.cities.length) continue;
        const cap = k.cities[0];
        const x = cap.x * s, y = cap.y * s;
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        ctx.fillStyle = "#fff";
        ctx.fillRect(x - 0.5, y - 0.5, 1.5, 1.5);
      }
    }

    // ビューポート矩形（半透明の塗り＋明るい枠）。
    const r = camera.visibleTileRange();
    const vx = r.x0 * s, vy = r.y0 * s;
    const vw = Math.max(2, (r.x1 - r.x0) * s), vh = Math.max(2, (r.y1 - r.y0) * s);
    ctx.fillStyle = "rgba(150,190,255,0.14)";
    ctx.fillRect(vx, vy, vw, vh);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1;
    ctx.strokeRect(vx + 0.5, vy + 0.5, vw, vh);
  };

  Game.minimap = Minimap;
})(window.Game);
