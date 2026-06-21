// カメラ。pan/zoom 状態と座標変換を持つ。
// (x,y) はビューポート左上に対応するワールドピクセル座標。zoom は拡大率。
(function (Game) {
  "use strict";

  function Camera(viewW, viewH) {
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.viewW = viewW;
    this.viewH = viewH;
  }

  Camera.prototype.resize = function (viewW, viewH) {
    this.viewW = viewW;
    this.viewH = viewH;
    this.clamp();
  };

  // ワールドpx → スクリーンpx
  Camera.prototype.worldToScreenX = function (wx) {
    return (wx - this.x) * this.zoom;
  };
  Camera.prototype.worldToScreenY = function (wy) {
    return (wy - this.y) * this.zoom;
  };

  // スクリーンpx → ワールドpx
  Camera.prototype.screenToWorldX = function (sx) {
    return sx / this.zoom + this.x;
  };
  Camera.prototype.screenToWorldY = function (sy) {
    return sy / this.zoom + this.y;
  };

  // スクリーンpx → タイル座標
  Camera.prototype.screenToTile = function (sx, sy) {
    const tile = Game.config.tilePx;
    return {
      x: Math.floor(this.screenToWorldX(sx) / tile),
      y: Math.floor(this.screenToWorldY(sy) / tile),
    };
  };

  // ワールドpx 単位でパン（zoom は考慮しない呼び出し側で割る）。
  Camera.prototype.panByWorld = function (dwx, dwy) {
    this.x += dwx;
    this.y += dwy;
    this.clamp();
  };

  // スクリーンpx のドラッグ量でパン。
  Camera.prototype.panByScreen = function (dsx, dsy) {
    this.x -= dsx / this.zoom;
    this.y -= dsy / this.zoom;
    this.clamp();
  };

  // カーソル(sx,sy)を基点にズーム。
  Camera.prototype.zoomAt = function (sx, sy, factor) {
    const cfg = Game.config;
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);
    this.zoom = Game.utils.clamp(this.zoom * factor, cfg.minZoom, cfg.maxZoom);
    // ズーム後、同じワールド点がカーソル下に来るよう x,y を補正。
    this.x = wx - sx / this.zoom;
    this.y = wy - sy / this.zoom;
    this.clamp();
  };

  // マップ外に出すぎないようにクランプ。
  Camera.prototype.clamp = function () {
    const cfg = Game.config;
    const mapW = cfg.mapWidth * cfg.tilePx;
    const mapH = cfg.mapHeight * cfg.tilePx;
    const visW = this.viewW / this.zoom;
    const visH = this.viewH / this.zoom;

    // 横: マップが画面より大きければ範囲内、小さければ中央寄せ。
    if (mapW <= visW) {
      this.x = (mapW - visW) / 2;
    } else {
      this.x = Game.utils.clamp(this.x, 0, mapW - visW);
    }
    if (mapH <= visH) {
      this.y = (mapH - visH) / 2;
    } else {
      this.y = Game.utils.clamp(this.y, 0, mapH - visH);
    }
  };

  // 指定タイルを画面中央に置く（ズームは維持）。
  Camera.prototype.centerOnTile = function (tx, ty) {
    const tile = Game.config.tilePx;
    this.x = (tx + 0.5) * tile - this.viewW / this.zoom / 2;
    this.y = (ty + 0.5) * tile - this.viewH / this.zoom / 2;
    this.clamp();
  };

  // 操作しやすいズームでマップ中央を表示（約 nTiles タイルが画面に収まる）。
  Camera.prototype.fitTiles = function (nTiles) {
    const cfg = Game.config;
    const mapW = cfg.mapWidth * cfg.tilePx;
    const mapH = cfg.mapHeight * cfg.tilePx;
    const viewMin = Math.min(this.viewW, this.viewH);
    const zoom = Game.utils.clamp(viewMin / (nTiles * cfg.tilePx), cfg.minZoom, cfg.maxZoom);
    this.zoom = zoom;
    this.x = (mapW - this.viewW / zoom) / 2;
    this.y = (mapH - this.viewH / zoom) / 2;
    this.clamp();
  };

  // マップ全体が見えるよう初期化（中央表示）。
  Camera.prototype.fitToMap = function () {
    const cfg = Game.config;
    const mapW = cfg.mapWidth * cfg.tilePx;
    const mapH = cfg.mapHeight * cfg.tilePx;
    const zx = this.viewW / mapW;
    const zy = this.viewH / mapH;
    this.zoom = Game.utils.clamp(Math.min(zx, zy), cfg.minZoom, cfg.maxZoom);
    this.x = (mapW - this.viewW / this.zoom) / 2;
    this.y = (mapH - this.viewH / this.zoom) / 2;
  };

  // 現在の可視タイル範囲（renderer の culling 用）。
  Camera.prototype.visibleTileRange = function () {
    const cfg = Game.config;
    const tile = cfg.tilePx;
    const x0 = Math.floor(this.screenToWorldX(0) / tile);
    const y0 = Math.floor(this.screenToWorldY(0) / tile);
    const x1 = Math.ceil(this.screenToWorldX(this.viewW) / tile);
    const y1 = Math.ceil(this.screenToWorldY(this.viewH) / tile);
    return {
      x0: Game.utils.clamp(x0, 0, cfg.mapWidth),
      y0: Game.utils.clamp(y0, 0, cfg.mapHeight),
      x1: Game.utils.clamp(x1, 0, cfg.mapWidth),
      y1: Game.utils.clamp(y1, 0, cfg.mapHeight),
    };
  };

  Game.Camera = Camera;
})(window.Game);
