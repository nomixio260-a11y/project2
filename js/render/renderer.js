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

    // 領土オーバーレイ用オフスクリーン（透明背景、所有タイルだけ着色）。
    this.territoryCanvas = document.createElement("canvas");
    this.territoryCanvas.width = world.width;
    this.territoryCanvas.height = world.height;
    this.territoryCtx = this.territoryCanvas.getContext("2d");
    this.territoryDirty = [];

    this.dirty = []; // 部分更新待ちのタイル {x,y}
    this.entities = null; // 生物ストア（setEntities で接続）
    this.fire = null; // 炎システム（setFire で接続）
    this.fullRedraw(); // 初回は全タイルをバッファへ
  }

  // 生物ストアを接続（毎フレーム描画される）。
  Renderer.prototype.setEntities = function (entities) {
    this.entities = entities;
  };

  // 炎システムを接続（オーバーレイ描画）。
  Renderer.prototype.setFire = function (fire) {
    this.fire = fire;
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
    // 領土オフスクリーンもサイズ追従しクリア。
    if (this.territoryCanvas.width !== world.width || this.territoryCanvas.height !== world.height) {
      this.territoryCanvas.width = world.width;
      this.territoryCanvas.height = world.height;
    } else {
      this.territoryCtx.clearRect(0, 0, world.width, world.height);
    }
    this.territoryDirty.length = 0;
    this.fullRedraw();
  };

  // 領土タイルの差分更新を積む。
  Renderer.prototype.markTerritoryDirty = function (x, y) {
    this.territoryDirty.push(x, y);
  };

  // 領土の dirty を territoryCanvas へ反映（所有者色 or クリア）。
  Renderer.prototype.flushTerritoryDirty = function () {
    if (this.territoryDirty.length === 0) return;
    const world = this.world;
    const civ = Game.state.civ;
    const tctx = this.territoryCtx;
    for (let k = 0; k < this.territoryDirty.length; k += 2) {
      const x = this.territoryDirty[k];
      const y = this.territoryDirty[k + 1];
      const id = world.owner[y * world.width + x];
      if (id === 0 || !civ) {
        tctx.clearRect(x, y, 1, 1);
      } else {
        const c = civ.colorOf(id);
        if (c) {
          tctx.fillStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
          tctx.fillRect(x, y, 1, 1);
        } else {
          tctx.clearRect(x, y, 1, 1);
        }
      }
    }
    this.territoryDirty.length = 0;
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
    this.flushTerritoryDirty();
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

    // 領土オーバーレイ（地形の上、半透明で着色）。
    ctx.globalAlpha = 0.4;
    ctx.drawImage(this.territoryCanvas, dx, dy, dw, dh);
    ctx.globalAlpha = 1;

    // 炎オーバーレイ（地形の上、生物の下）。
    this.drawFire(camera);

    // 都市マーカー（領土の上）。
    this.drawCities(camera);

    // 生物オーバーレイ。
    this.drawEntities(camera);

    // 市民（人間）エージェント。
    this.drawPeople(camera);

    // 昼夜の環境光（全要素の上に重ねて統一した照明にする）。
    this.drawDayNight(camera);

    // ブラシのプレビュー（カーソル位置の円。照明の影響を受けない）。
    this.drawBrushPreview(camera);
  };

  // 生物を可視範囲だけ描画。負荷軽減のため2段階 LOD:
  //  - 遠景(scale<6): 種別ごとに色を1回だけ設定し fillRect で一括（高速）。
  //  - 近景(scale>=6): 個体ごとに体格・向き付きの形状で描く（可視数は少ない）。
  Renderer.prototype.drawEntities = function (camera) {
    const e = this.entities;
    if (!e || e.live === 0) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 0.8) return; // 縮小しすぎたら省略
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const SP = Game.SPECIES;
    const n = e.count;

    if (scale < 6) {
      // 遠景: 種別ごとに一括（fillStyle 切替を最小化）。
      const px = Math.max(1, scale * 0.55);
      const half = px * 0.5;
      const colors = ["#f2e3b0", "#e0473a"]; // [草食, 肉食]
      for (let sp = 0; sp < 2; sp++) {
        ctx.fillStyle = colors[sp];
        for (let i = 0; i < n; i++) {
          if (!e.alive[i] || e.type[i] !== sp) continue;
          const x = e.x[i];
          const y = e.y[i];
          if (x < range.x0 || x > range.x1 || y < range.y0 || y > range.y1) continue;
          const sx = camera.worldToScreenX((x + 0.5) * tile);
          const sy = camera.worldToScreenY((y + 0.5) * tile);
          ctx.fillRect(sx - half, sy - half, px, px);
        }
      }
      return;
    }

    // 近景: 個体ごとに描画（体格・向き）。
    const base = scale * 0.42;
    for (let i = 0; i < n; i++) {
      if (!e.alive[i]) continue;
      const x = e.x[i];
      const y = e.y[i];
      if (x < range.x0 || x > range.x1 || y < range.y0 || y > range.y1) continue;
      const sx = camera.worldToScreenX((x + 0.5) * tile);
      const sy = camera.worldToScreenY((y + 0.5) * tile);
      const gene = e.gene[i] || 1;
      const r = base * gene;
      if (e.type[i] === SP.PREDATOR) {
        // 肉食: 進行方向を向いた三角形。
        const h = e.heading[i] || 0;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(h);
        ctx.beginPath();
        ctx.moveTo(r * 1.4, 0);
        ctx.lineTo(-r, r * 0.85);
        ctx.lineTo(-r, -r * 0.85);
        ctx.closePath();
        ctx.fillStyle = "#e0473a";
        ctx.fill();
        ctx.lineWidth = Math.max(0.5, r * 0.18);
        ctx.strokeStyle = "rgba(60,10,10,0.65)";
        ctx.stroke();
        ctx.restore();
      } else {
        // 草食: 丸い体＋淡い縁取り。
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = "#efdca0";
        ctx.fill();
        ctx.lineWidth = Math.max(0.5, r * 0.2);
        ctx.strokeStyle = "rgba(90,70,30,0.55)";
        ctx.stroke();
      }
    }
  };

  // 市民（人間）エージェントをヒト型で描画。一定以上ズーム時のみ。
  Renderer.prototype.drawPeople = function (camera) {
    const civ = Game.state.civ;
    if (!civ || !civ.people || civ.people.length === 0) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 3) return; // 小さすぎる時は省略
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const people = civ.people;
    const headR = Math.max(1, scale * 0.16);
    const bodyH = Math.max(2, scale * 0.5);
    const bodyW = Math.max(1, scale * 0.22);

    for (let p = 0; p < people.length; p++) {
      const person = people[p];
      if (person.x < range.x0 || person.x > range.x1 || person.y < range.y0 || person.y > range.y1) continue;
      const k = civ.kingdoms[person.kid];
      if (!k) continue;
      const col = k.color;
      const sx = camera.worldToScreenX((person.x + 0.5) * tile);
      const sy = camera.worldToScreenY((person.y + 0.5) * tile);
      // 体（王国色）。
      ctx.fillStyle = "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")";
      ctx.fillRect(sx - bodyW * 0.5, sy - bodyH * 0.3, bodyW, bodyH);
      // 影の縁。
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.strokeRect(sx - bodyW * 0.5, sy - bodyH * 0.3, bodyW, bodyH);
      // 頭。
      ctx.beginPath();
      ctx.arc(sx, sy - bodyH * 0.3 - headR, headR, 0, Math.PI * 2);
      ctx.fillStyle = "#f0d2a8";
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.stroke();
    }
  };

  // 昼夜の環境光オーバーレイ。夜は青く暗く、朝夕は暖色。夜は都市が灯る。
  Renderer.prototype.drawDayNight = function (camera) {
    if (!Game.lighting) return;
    const L = Game.lighting(Game.state.clock);
    const ctx = this.ctx;
    const W = this.cssW;
    const H = this.cssH;
    if (L.darkness > 0.001) {
      ctx.fillStyle = "rgba(8,14,40," + L.darkness.toFixed(3) + ")";
      ctx.fillRect(0, 0, W, H);
    }
    if (L.twilight > 0.001) {
      ctx.fillStyle = "rgba(255,150,70," + (L.twilight * 0.16).toFixed(3) + ")";
      ctx.fillRect(0, 0, W, H);
    }
    // 夜は都市が灯る（暗い時だけ加算で光らせる）。
    if (L.darkness > 0.18) {
      this._drawCityLights(camera, L.darkness);
    }
  };

  Renderer.prototype._drawCityLights = function (camera, darkness) {
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 1) return;
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const kingdoms = civ.kingdoms;
    const glow = Math.min(0.85, darkness * 1.4);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let id = 1; id < kingdoms.length; id++) {
      const k = kingdoms[id];
      if (!k || !k.alive || !k.cities) continue;
      for (let c = 0; c < k.cities.length; c++) {
        const city = k.cities[c];
        if (city.x < range.x0 || city.x > range.x1 || city.y < range.y0 || city.y > range.y1) continue;
        const sx = camera.worldToScreenX((city.x + 0.5) * tile);
        const sy = camera.worldToScreenY((city.y + 0.5) * tile);
        const rad = Math.max(3, scale * (city.capital ? 1.6 : 1.1));
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
        g.addColorStop(0, "rgba(255,210,120," + glow.toFixed(3) + ")");
        g.addColorStop(1, "rgba(255,180,80,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  // 王国の都市マーカーを描画（首都は大きめ）。
  Renderer.prototype.drawCities = function (camera) {
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 1.5) return; // 縮小時は省略
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const kingdoms = civ.kingdoms;

    ctx.save();
    for (let id = 1; id < kingdoms.length; id++) {
      const k = kingdoms[id];
      if (!k || !k.alive || !k.cities) continue;
      const col = k.color;
      const fill = "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")";
      for (let c = 0; c < k.cities.length; c++) {
        const city = k.cities[c];
        if (city.x < range.x0 || city.x > range.x1 || city.y < range.y0 || city.y > range.y1) continue;
        const sx = camera.worldToScreenX((city.x + 0.5) * tile);
        const sy = camera.worldToScreenY((city.y + 0.5) * tile);
        const rad = city.capital ? Math.max(3, scale * 0.6) : Math.max(2, scale * 0.4);
        ctx.beginPath();
        ctx.arc(sx, sy, rad + 1.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.stroke();
        if (city.capital) {
          // 首都は中心に白点。
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(1, rad * 0.35), 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
        }
      }
    }
    ctx.restore();
  };

  // 燃焼中タイルを可視範囲だけ揺らぐグローで描画。
  Renderer.prototype.drawFire = function (camera) {
    const fire = this.fire;
    if (!fire || fire.active.length === 0) return;
    const W = this.world.width;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    const range = camera.visibleTileRange();
    const active = fire.active;
    const burn = fire.burn;
    const ctx = this.ctx;
    const phase = fire.phase * 0.006;

    ctx.save();
    ctx.globalCompositeOperation = "lighter"; // 加算で光らせる
    for (let k = 0; k < active.length; k++) {
      const i = active[k];
      if (burn[i] === 0) continue;
      const x = i % W;
      const y = (i / W) | 0;
      if (x < range.x0 || x > range.x1 || y < range.y0 || y > range.y1) continue;
      const sx = camera.worldToScreenX(x * tile);
      const sy = camera.worldToScreenY(y * tile);
      // タイルごとに位相をずらした炎のちらつき。
      const flick = 0.6 + 0.4 * Math.sin(phase + (x * 1.3 + y * 0.7));
      ctx.fillStyle = "rgba(255," + (90 + ((flick * 110) | 0)) + ",30,0.55)";
      ctx.fillRect(sx, sy, scale, scale);
      ctx.fillStyle = "rgba(255,230,120," + (0.25 * flick).toFixed(3) + ")";
      ctx.fillRect(sx + scale * 0.25, sy + scale * 0.25, scale * 0.5, scale * 0.5);
    }
    ctx.restore();
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
