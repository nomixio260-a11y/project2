// レンダラ。地形はオフスクリーン canvas（1タイル=1px）にキャッシュし、
// 毎フレームは drawImage 一発で可視領域を拡大ブリットする。
// タイル編集時は dirty タイルだけ ImageData で部分更新する。
(function (Game) {
  "use strict";

  function Renderer(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.world = world;

    // オフスクリーン地形バッファ（マップ全体、1px/タイル）。
    this.terrainCanvas = document.createElement("canvas");
    this.terrainCanvas.width = world.width;
    this.terrainCanvas.height = world.height;
    this.terrainCtx = this.terrainCanvas.getContext("2d");
    this.imageData = this.terrainCtx.createImageData(world.width, world.height);

    // 拡大時にタイルがにじまないよう補間を無効化。
    this.ctx.imageSmoothingEnabled = false;

    // CSSピクセル基準の表示サイズ（高DPI対応で device px と分離）。
    this.cssW = canvas.width;
    this.cssH = canvas.height;
    this.dpr = 1;

    this.dirty = []; // 部分更新待ちのタイル {x,y}
    this.entities = null; // 生物ストア（setEntities で接続）
    this.fullRedraw(); // 初回は全タイルをバッファへ
  }

  // 生物ストアを接続（毎フレーム描画される）。
  Renderer.prototype.setEntities = function (entities) {
    this.entities = entities;
  };

  // 別の world に差し替え（再生成時）。
  Renderer.prototype.setWorld = function (world) {
    this.world = world;
    if (this.terrainCanvas.width !== world.width || this.terrainCanvas.height !== world.height) {
      this.terrainCanvas.width = world.width;
      this.terrainCanvas.height = world.height;
      this.imageData = this.terrainCtx.createImageData(world.width, world.height);
    }
    this.dirty.length = 0;
    this.fullRedraw();
  };

  // world.terrain 全体を ImageData に書き出してオフスクリーンへ。
  Renderer.prototype.fullRedraw = function () {
    const world = this.world;
    const data = this.imageData.data;
    const rgb = Game.TERRAIN_RGB;
    const terrain = world.terrain;
    const elev = world.elevation;
    const n = world.width * world.height;
    for (let i = 0; i < n; i++) {
      const c = rgb[terrain[i]];
      // 標高で軽くシェーディングして起伏を見せる。
      const shade = 0.78 + 0.22 * elev[i];
      const o = i * 4;
      data[o] = c[0] * shade;
      data[o + 1] = c[1] * shade;
      data[o + 2] = c[2] * shade;
      data[o + 3] = 255;
    }
    this.terrainCtx.putImageData(this.imageData, 0, 0);
  };

  // 1タイルを dirty キューに積む（input から呼ばれる）。
  Renderer.prototype.markDirty = function (x, y) {
    this.dirty.push(x, y);
  };

  // dirty タイルをオフスクリーンへ反映。
  Renderer.prototype.flushDirty = function () {
    if (this.dirty.length === 0) return;
    const world = this.world;
    const rgb = Game.TERRAIN_RGB;
    const tctx = this.terrainCtx;
    for (let k = 0; k < this.dirty.length; k += 2) {
      const x = this.dirty[k];
      const y = this.dirty[k + 1];
      const i = y * world.width + x;
      const c = rgb[world.terrain[i]];
      const shade = 0.78 + 0.22 * world.elevation[i];
      tctx.fillStyle =
        "rgb(" + ((c[0] * shade) | 0) + "," + ((c[1] * shade) | 0) + "," + ((c[2] * shade) | 0) + ")";
      tctx.fillRect(x, y, 1, 1);
    }
    this.dirty.length = 0;
  };

  Renderer.prototype.resize = function () {
    // 高DPI対応: 物理ピクセルで描画バッファを確保し、CSSピクセル基準に変換。
    const dpr = window.devicePixelRatio || 1;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";
    // 以降の描画は CSSピクセル座標で行えるようスケール。
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  };

  // 毎フレーム描画。
  Renderer.prototype.draw = function (camera) {
    this.flushDirty();
    const ctx = this.ctx;
    const cfg = Game.config;
    const tile = cfg.tilePx;

    // 背景（海より暗い余白）。CSSピクセル基準。
    ctx.fillStyle = "#070b16";
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // オフスクリーン全体を 1ブリットで配置。
    // src: タイル座標系（=オフスクリーンpx）、dst: スクリーンpx。
    const scale = tile * camera.zoom;
    const dx = -camera.x * camera.zoom;
    const dy = -camera.y * camera.zoom;
    const dw = this.world.width * scale;
    const dh = this.world.height * scale;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.terrainCanvas, dx, dy, dw, dh);

    // 生物オーバーレイ（地形ブリットの上）。
    this.drawEntities(camera);

    // ブラシのプレビュー（カーソル位置の円）。
    this.drawBrushPreview(camera);
  };

  // 生物を可視範囲だけ点で描画。
  Renderer.prototype.drawEntities = function (camera) {
    const e = this.entities;
    if (!e || e.live === 0) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 1.2) return; // 縮小しすぎたら省略（LOD）
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const r = Math.max(1.5, scale * 0.35);
    const SP = Game.SPECIES;

    for (let i = 0; i < e.count; i++) {
      if (!e.alive[i]) continue;
      const x = e.x[i];
      const y = e.y[i];
      if (x < range.x0 || x > range.x1 || y < range.y0 || y > range.y1) continue;
      const sx = camera.worldToScreenX((x + 0.5) * tile);
      const sy = camera.worldToScreenY((y + 0.5) * tile);
      ctx.fillStyle = e.type[i] === SP.PREDATOR ? "#d83a3a" : "#f2e3b0";
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  Renderer.prototype.drawBrushPreview = function (camera) {
    const mt = Game.state.mouseTile;
    if (!Game.state.brush || mt.x < 0) return;
    const cfg = Game.config;
    const tile = cfg.tilePx;
    const r = Game.state.brush.size;
    const ctx = this.ctx;

    // ブラシ中心のワールドpx → スクリーンpx
    const wx = (mt.x + 0.5) * tile;
    const wy = (mt.y + 0.5) * tile;
    const sx = camera.worldToScreenX(wx);
    const sy = camera.worldToScreenY(wy);
    const radPx = r * tile * camera.zoom;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(sx, sy, radPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.arc(sx, sy, radPx + 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  Game.Renderer = Renderer;
})(window.Game);
