// レンダラ。地形はオフスクリーン canvas（1タイル=1px）にキャッシュし、
// 毎フレームは drawImage 一発で可視領域を拡大ブリットする。
// タイル編集時は dirty タイルだけ ImageData で部分更新する。
(function (Game) {
  "use strict";

  // 役割ごとの被り物の色（ROLE: 0=開拓者,1=農民,2=建築家,3=兵士,4=鍛冶,5=商人,6=神官）。
  const ROLE_HAT = [null, "#4fae4f", "#e08a2a", "#b9c2cc", "#6a6a72", "#d8b84a", "#ece9e0"];
  // 建物タイプごとの相対サイズ（実世界の規模感に合わせる。index=建物タイプ）。
  // 0小屋 1家 2邸宅 3砦 4神殿 5農場 6工房 7市場 8兵舎 9穀倉 10鉱山 11大記念碑
  //              hut  house manor keep temple farm smith mkt barr gran mine wonder acad harbor tavern
  const BUILD_SIZE = [0.78, 1.0, 1.28, 1.55, 1.4, 0.95, 1.02, 0.88, 1.2, 1.0, 0.85, 2.1, 1.45, 1.15, 0.98];
  // 個人差の肌・髪の色（人ごとに一意に選ばれ、群衆が多様に見える）。
  const SKIN = ["#f3cd9b", "#e8b887", "#d9a066", "#c68642", "#a9764b", "#8d5524"];
  const HAIR = ["#2a1c10", "#4a3422", "#6b4f2a", "#caa84a", "#b5482f", "#15110b"];
  const LIFE_DEFAULT = { adult: 200, elder: 2600 }; // civ の CP と一致（フォールバック）

  // 都市内の家の配置オフセット（タイル単位・安定配置）。
  const CITY_PATTERN = [
    [0, 0], [1.1, 0.4], [-1.0, 0.5], [0.5, 1.1], [-0.6, -0.9],
    [1.3, -0.8], [-1.4, -0.7], [1.5, 1.2], [-1.5, 1.1], [0.2, -1.6],
    [2.2, 0.3], [-2.1, 0.4], [0.6, 2.1], [-0.7, 2.0],
  ];

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

    // 国境オーバーレイ用オフスクリーン（所有者が変わる辺だけ濃く着色）。
    this.borderCanvas = document.createElement("canvas");
    this.borderCanvas.width = world.width;
    this.borderCanvas.height = world.height;
    this.borderCtx = this.borderCanvas.getContext("2d");

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
    // 国境オフスクリーンもサイズ追従しクリア。
    if (this.borderCanvas.width !== world.width || this.borderCanvas.height !== world.height) {
      this.borderCanvas.width = world.width;
      this.borderCanvas.height = world.height;
    } else {
      this.borderCtx.clearRect(0, 0, world.width, world.height);
    }
    this.fullRedraw();
  };

  // 領土タイルの差分更新を積む。
  Renderer.prototype.markTerritoryDirty = function (x, y) {
    this.territoryDirty.push(x, y);
  };

  // (x,y) の国境状態を再計算して borderCanvas に反映。
  // 所有国があり、4近傍に別の所有者（無所属/他国）が接していれば「辺」。
  Renderer.prototype._updateBorderAt = function (x, y, civ) {
    const world = this.world, W = world.width, H = world.height, owner = world.owner;
    const id = owner[y * W + x];
    const bctx = this.borderCtx;
    if (id === 0 || !civ) { bctx.clearRect(x, y, 1, 1); return; }
    let edge = false;
    if (x > 0 && owner[y * W + x - 1] !== id) edge = true;
    else if (x < W - 1 && owner[y * W + x + 1] !== id) edge = true;
    else if (y > 0 && owner[(y - 1) * W + x] !== id) edge = true;
    else if (y < H - 1 && owner[(y + 1) * W + x] !== id) edge = true;
    if (!edge) { bctx.clearRect(x, y, 1, 1); return; }
    const c = (civ.viewColorOf ? civ.viewColorOf(id) : civ.colorOf(id));
    if (!c) { bctx.clearRect(x, y, 1, 1); return; }
    // 視認性のため明るめに。
    const br = function (v) { return Math.min(255, (v * 1.25 + 40) | 0); };
    bctx.fillStyle = "rgb(" + br(c[0]) + "," + br(c[1]) + "," + br(c[2]) + ")";
    bctx.fillRect(x, y, 1, 1);
  };

  // 領土の dirty を territoryCanvas へ反映（所有者色 or クリア）。
  Renderer.prototype.flushTerritoryDirty = function () {
    if (this.territoryDirty.length === 0) return;
    const world = this.world;
    const civ = Game.state.civ;
    const tctx = this.territoryCtx;
    const W = world.width, H = world.height;
    for (let k = 0; k < this.territoryDirty.length; k += 2) {
      const x = this.territoryDirty[k];
      const y = this.territoryDirty[k + 1];
      const id = world.owner[y * W + x];
      if (id === 0 || !civ) {
        tctx.clearRect(x, y, 1, 1);
      } else {
        const c = (civ.viewColorOf ? civ.viewColorOf(id) : civ.colorOf(id));
        if (c) {
          tctx.fillStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
          tctx.fillRect(x, y, 1, 1);
        } else {
          tctx.clearRect(x, y, 1, 1);
        }
      }
      // 自タイルと4近傍の国境を更新（辺の所在が変わるため）。
      this._updateBorderAt(x, y, civ);
      if (x > 0) this._updateBorderAt(x - 1, y, civ);
      if (x < W - 1) this._updateBorderAt(x + 1, y, civ);
      if (y > 0) this._updateBorderAt(x, y - 1, civ);
      if (y < H - 1) this._updateBorderAt(x, y + 1, civ);
    }
    this.territoryDirty.length = 0;
  };

  // 領土・国境を全タイル塗り直す（地図ビュー＝区分の切替時に呼ぶ）。
  Renderer.prototype.repaintTerritory = function () {
    const world = this.world, civ = Game.state.civ;
    const W = world.width, H = world.height, owner = world.owner;
    const tctx = this.territoryCtx, bctx = this.borderCtx;
    tctx.clearRect(0, 0, W, H);
    if (bctx) bctx.clearRect(0, 0, W, H);
    if (!civ) return;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const id = owner[y * W + x];
        if (id === 0) continue;
        const c = (civ.viewColorOf ? civ.viewColorOf(id) : civ.colorOf(id));
        if (c) { tctx.fillStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; tctx.fillRect(x, y, 1, 1); }
      }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this._updateBorderAt(x, y, civ);
  };

  // 1タイルの陰影係数。標高＋北西から当たる光による起伏の立体感（レリーフ）＋
  // タイルごとの微細なテクスチャゆらぎを掛け合わせ、平坦な塗りに質感を与える。
  Renderer.prototype._tileShade = function (world, i, x, y) {
    const elev = world.elevation, W = world.width;
    const e = elev[i];
    const elevShade = 0.80 + 0.20 * e;
    // 北・西の標高との差で斜面を擬似ライティング（尾根は明るく谷は暗く）。
    const west = x > 0 ? elev[i - 1] : e;
    const north = y > 0 ? elev[i - W] : e;
    let relief = 1 + ((e - west) + (e - north)) * 3.0;
    if (relief < 0.70) relief = 0.70; else if (relief > 1.36) relief = 1.36;
    // ハッシュ由来の微細なゆらぎ（同一バイオームの広い面の単調さを崩す。高所では控えめ）。
    const hsh = (((x * 374761393) + (y * 668265263)) ^ (x * 19349663)) >>> 0 & 255;
    const amp = e > 0.7 ? 0.04 : 0.066; // 雪・山頂など明るい高所はテクスチャを抑える
    const tex = (1 - amp * 0.5) + (hsh / 255) * amp;
    return elevShade * relief * tex;
  };

  // world.terrain 全体を ImageData に書き出してオフスクリーンへ。
  Renderer.prototype.fullRedraw = function () {
    const world = this.world;
    const data = this.imageData.data;
    const rgb = Game.TERRAIN_RGB;
    const terrain = world.terrain;
    const W = world.width, H = world.height;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const c = rgb[terrain[i]];
        let s = this._tileShade(world, i, x, y);
        const o = i * 4;
        let r = c[0] * s, g = c[1] * s, b = c[2] * s;
        data[o] = r > 255 ? 255 : r;
        data[o + 1] = g > 255 ? 255 : g;
        data[o + 2] = b > 255 ? 255 : b;
        data[o + 3] = 255;
      }
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
      const shade = this._tileShade(world, i, x, y);
      const r = Math.min(255, (c[0] * shade) | 0), g = Math.min(255, (c[1] * shade) | 0), b = Math.min(255, (c[2] * shade) | 0);
      tctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
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
    // 歩行アニメ用の時間（秒）。
    this._t = (typeof performance !== "undefined" ? performance.now() : Date.now()) * 0.001;
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
    ctx.globalAlpha = 0.32;
    ctx.drawImage(this.territoryCanvas, dx, dy, dw, dh);
    // 国境（辺だけ濃く描いて領土をはっきりさせる）。
    ctx.globalAlpha = 0.85;
    ctx.drawImage(this.borderCanvas, dx, dy, dw, dh);
    ctx.globalAlpha = 1;

    // 戦略資源（鉱石・漁場・宝石）。
    this.drawResources(camera);

    // 街道（実際に敷かれた道タイル）。
    this.drawRoads(camera);

    // 田畑（農場の周りに耕地を描く）。建物の下に敷く。
    this.drawFields(camera);

    // 樹木（森・密林に木のドット絵を立てる）と伐採アニメ。建物・人の下に描く。
    this.drawTrees(camera);
    this.drawFellings(camera);

    // 交易路（同盟国の首都を結ぶ金色の線）。
    this.drawTradeRoutes(camera);

    // 街道・交易路を行き交う荷馬車（経済が見える）。
    this.drawCaravans(camera);

    // 炎オーバーレイ（地形の上、生物の下）。
    this.drawFire(camera);

    // 都市マーカー（領土の上）。
    this.drawCities(camera);

    // 戦場の痕跡（戦死地点。生物・市民の下）。
    this.drawMarks(camera);

    // 生物オーバーレイ。
    this.drawEntities(camera);

    // 市民（人間）エージェント。
    this.drawPeople(camera);

    // 戦闘演出（白刃の火花・矢・銃弾・流血）。人の上に重ねる。
    this.drawBattleFx(camera);

    // 選択ハイライト（インスペクタで選んだ対象）。
    this.drawSelection(camera);

    // 天候（雲の影・雨・落雷）。
    this.drawWeather(camera);

    // 昼夜の環境光（全要素の上に重ねて統一した照明にする）。
    this.drawDayNight(camera);

    // 外交ビュー: 国同士の関係（戦争＝赤・同盟＝緑・従属＝金）を首都間の線で一望できる。
    if (Game.state.mapView === "diplomacy") this.drawDiplomacy(camera);

    // 国名ラベル（照明の影響を受けず常に読める）。
    this.drawLabels(camera);

    // ブラシのプレビュー（カーソル位置の円。照明の影響を受けない）。
    this.drawBrushPreview(camera);
  };

  // 外交関係を首都間の線で描く（戦争=赤・同盟=緑・従属=金）。一目で勢力図と対立が分かる。
  Renderer.prototype.drawDiplomacy = function (camera) {
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const tile = Game.config.tilePx;
    const ks = civ.kingdoms;
    const ctx = this.ctx;
    function cap(k) { return k && k.alive && k.cities && k.cities.length ? k.cities[0] : null; }
    function line(ca, cb, col, wdt, dash) {
      ctx.strokeStyle = col; ctx.lineWidth = wdt;
      if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(camera.worldToScreenX((ca.x + 0.5) * tile), camera.worldToScreenY((ca.y + 0.5) * tile));
      ctx.lineTo(camera.worldToScreenX((cb.x + 0.5) * tile), camera.worldToScreenY((cb.y + 0.5) * tile));
      ctx.stroke();
    }
    ctx.save();
    ctx.lineCap = "round";
    // 1) 同盟（緑）と従属（金）。2) 戦争（赤・太）を上に重ねて目立たせる。
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id], ca = cap(k); if (!ca) continue;
      if (k.allies) for (const b in k.allies) { if (+b <= id) continue; const cb = cap(ks[+b]); if (cb) line(ca, cb, "rgba(80,210,120,0.7)", 2, null); }
      if (k.vassals) for (const v in k.vassals) { const cb = cap(ks[+v]); if (cb) line(ca, cb, "rgba(200,170,70,0.8)", 2, [6, 4]); }
    }
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id], ca = cap(k); if (!ca) continue;
      if (k.wars) for (const b in k.wars) { if (+b <= id) continue; const cb = cap(ks[+b]); if (cb) line(ca, cb, "rgba(232,70,60,0.85)", 3, null); }
    }
    ctx.setLineDash([]);
    ctx.restore();
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
      // 遠景: 種別ごとに一括（fillStyle 切替を最小化）。肉食は小さめの点。
      const colors = ["#f2e3b0", "#e0473a"]; // [草食, 肉食]
      const pxBy = [Math.max(1, scale * 0.52), Math.max(1, scale * 0.4)]; // [草食, 肉食]
      for (let sp = 0; sp < 2; sp++) {
        ctx.fillStyle = colors[sp];
        const px = pxBy[sp], half = px * 0.5;
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

    // 近景: ピクセルアートのスプライトで描画（体格・向き付き）。
    const sprites = Game.sprites;
    ctx.imageSmoothingEnabled = false;
    // 移動検知用の前フレーム座標・移動カウントダウン（描画側で保持）。
    if (!this._cpx || this._cpx.length < e.capacity) {
      this._cpx = new Float32Array(e.capacity);
      this._cpy = new Float32Array(e.capacity);
      this._cmv = new Uint8Array(e.capacity);
    }
    const t = this._t;
    for (let i = 0; i < n; i++) {
      if (!e.alive[i]) continue;
      const x = e.x[i];
      const y = e.y[i];
      // 移動していれば歩行アニメをしばらく継続（tick間も滑らかに）。
      const ddx = x - this._cpx[i], ddy = y - this._cpy[i];
      if (ddx * ddx + ddy * ddy > 1e-5) this._cmv[i] = 16;
      this._cpx[i] = x; this._cpy[i] = y;
      if (x < range.x0 || x > range.x1 || y < range.y0 || y > range.y1) continue;
      const moving = this._cmv[i] > 0;
      if (moving) this._cmv[i]--;
      const sx = camera.worldToScreenX((x + 0.5) * tile);
      const sy = camera.worldToScreenY((y + 0.5) * tile);
      const gene = e.gene[i] || 1;
      const type = e.type[i];
      if (sprites) {
        // 進行方向で左右反転。heading 0 = 右。
        const faceLeft = Math.cos(e.heading[i] || 0) < 0;
        // 仔は小さく、成長で大人サイズへ（生まれて 140 ティックで一人前）。
        const age = e.age ? e.age[i] : 999;
        const grow = age < 140 ? (0.5 + 0.5 * (age / 140)) : 1;
        // 種別で実寸が違う: 草食(鹿)は人よりやや大きく、肉食(狼)は人より小さい。
        const species = type === SP.PREDATOR ? 0.66 : 0.96;
        const dh = Math.max(5, scale * species * gene * grow);
        // 歩行: 脚の2コマ切替＋上下のバウンドで「動いてる感」を出す。
        const ph = moving ? t * 7 + i * 0.9 : 0;
        const frame = moving && Math.sin(ph) > 0 ? 1 : 0;
        const bob = moving ? Math.abs(Math.sin(ph)) * dh * 0.10 : 0;
        const spr = sprites.get(type, faceLeft, frame);
        const dw = dh * (spr.width / spr.height);
        // 接地影（地面に落として立体感を出す。バウンドしても影は地面に固定）。
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        ctx.beginPath();
        ctx.ellipse(sx, sy + dh * 0.34, dw * 0.36, dh * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.drawImage(spr, sx - dw * 0.5, sy - dh * 0.5 - bob, dw, dh);
      } else {
        // フォールバック（スプライト未ロード時）。
        const r = scale * 0.42 * gene;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = type === SP.PREDATOR ? "#e0473a" : "#efdca0";
        ctx.fill();
      }
    }
  };

  // 市民（人間）エージェントをヒト型で描画。一定以上ズーム時のみ。
  Renderer.prototype.drawPeople = function (camera) {
    const civ = Game.state.civ;
    if (!civ || !civ.people || civ.people.length === 0) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 2.5) return; // 小さすぎる時は省略
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const people = civ.people;
    ctx.imageSmoothingEnabled = false;
    const detailed = scale >= 5; // 近景は人型、遠景は簡易点
    const u = Math.max(1, Math.round(scale * 0.085)); // ドット単位（人物は世界に対し小さめ）
    const t = this._t;
    // 夜は休む人々が建物に入る（＝描かれない）。日暮れに人が家へ入り、街に灯がともる様子を
    //   見せる手がかり。動いている者（旅人・移住・出兵）と航海者・野は引き続き描く。
    const townNight = (Game.config.settings && Game.config.settings.dayNight !== false) &&
      Game.state.civ && Game.state.civ._night;

    for (let p = 0; p < people.length; p++) {
      const person = people[p];
      // 移動検知（前フレーム座標を各人に保持し、しばらく歩行アニメを継続）。
      const ddx = person.x - (person._px || 0), ddy = person.y - (person._py || 0);
      if (ddx * ddx + ddy * ddy > 1e-5) person._mv = 16;
      person._px = person.x; person._py = person.y;
      if (person.x < range.x0 || person.x > range.x1 || person.y < range.y0 || person.y > range.y1) continue;
      const moving = (person._mv || 0) > 0;
      if (moving) person._mv--;
      // 夜、住居に入って休む町人は描かない（建物の中＝灯る街で表現）。住居に入れず野宿する
      //   者(_sheltered=false)は外で休む姿が見える（＝住宅不足が分かる）。
      if (townNight && !moving && person.kid && !person.sailing && person._sheltered) continue;
      const k = person.kid ? civ.kingdoms[person.kid] : null;
      let sx = Math.round(camera.worldToScreenX((person.x + 0.5) * tile));
      let sy = Math.round(camera.worldToScreenY((person.y + 0.5) * tile));
      // 兵士の突撃: 交戦中の敵がいれば、その方向へ踏み込む（打ち込みの瞬間に前へ出る）。
      if (person.role === 3 && person._enemy && person._enemy.alive) {
        const lunge = (Math.sin(t * 7 + p * 1.3) * 0.5 + 0.5) * scale * 0.4;
        const ldx = person._enemy.x - person.x, ldy = person._enemy.y - person.y;
        const ll = Math.sqrt(ldx * ldx + ldy * ldy) || 1;
        sx += Math.round(ldx / ll * lunge); sy += Math.round(ldy / ll * lunge);
      }
      const col = k ? k.color : [150, 140, 122];
      const body = "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")";

      // 航海中の入植者は船で描く（海の上を進む）。
      if (person.sailing) {
        const uu = Math.max(1, Math.round(scale * 0.1));
        const faceL = (person.hx || 0) < -0.001;
        // 帆。
        ctx.fillStyle = "#ece6d2";
        ctx.fillRect(sx - uu, sy - 4 * uu, uu, 3 * uu);
        ctx.fillStyle = "#6b4a2a"; // マスト
        ctx.fillRect(sx, sy - 4 * uu, Math.max(1, uu * 0.5) | 0 || 1, 4 * uu);
        // 船体。
        ctx.fillStyle = "#5a3d24";
        ctx.fillRect(sx - 3 * uu, sy, 6 * uu, 2 * uu);
        ctx.fillStyle = "#7a5230";
        ctx.fillRect(sx - 2 * uu, sy - uu, 4 * uu, uu);
        // 航跡。
        ctx.fillStyle = "rgba(220,235,255,0.5)";
        ctx.fillRect(sx + (faceL ? 3 * uu : -4 * uu), sy + uu, uu, uu);
        continue;
      }

      if (!detailed) {
        // 遠景: 頭＋胴の2ドット。
        ctx.fillStyle = body;
        ctx.fillRect(sx - u, sy - u, 2 * u, 2 * u);
        ctx.fillStyle = "#f0c89a";
        ctx.fillRect(sx - u, sy - 2 * u, 2 * u, u);
        continue;
      }

      // 近景: 個人差（肌・髪）と年齢段階（子供は小さく成長、老人は白髪）を持つ人型。
      const faceLeft = (person.hx || 0) < -0.001;
      const fd = faceLeft ? -1 : 1;
      // 個体の見た目を一度だけ決める（描画専用なので乱数で可）。
      let lk = person.look;
      if (lk === undefined) { lk = person.look = (Math.random() * 0x7fffffff) | 0; }
      // 肌・髪は人種から（civ が設定）。未設定なら従来のランダム配色にフォールバック。
      const skin = person.skinCol || SKIN[lk % SKIN.length];
      const LIFE = Game.lifeStages || LIFE_DEFAULT;
      const age = person.age || 0;
      const isChild = age < LIFE.adult;
      const isElder = age >= LIFE.elder;
      const hair = isElder ? "#dcdcdc" : (person.hairCol || HAIR[(lk >> 5) % HAIR.length]);
      // 年齢で体格が変わる（誕生時0.55→成人で1.0、老人は0.95）。人種の体格(build)も乗算。
      const ageGrow = isChild ? (0.55 + 0.45 * (age / LIFE.adult)) : (isElder ? 0.95 : 1);
      const grow = ageGrow * (person.build || 1);
      const uu = Math.max(1, Math.round(u * grow));
      // 歩行の振り（脚は前後、腕は逆位相）＋胴の小さなバウンド。
      const ph = moving ? t * 6 + p * 0.7 : 0;
      const sw = moving ? Math.round(Math.sin(ph) * uu) : 0; // -uu..uu
      const ob = moving ? -Math.round(Math.abs(Math.sin(ph)) * uu * 0.5) : 0; // 上下動
      // 仕事の動作: 建築(6)・耕作(7)・専門職(12)、または交戦中の兵は道具/武器を振る。
      //   瞬時に終わらず、振りかぶって打ち下ろす動きで「働いている」ことが見える。
      const st = person.state;
      const working = (st === 6 || st === 7 || st === 12);
      const swinging = working || (person.role === 3 && person._enemy);
      // 0..1 の打ち下ろし量（上に振り上げ、下に打つ）。
      const ws = swinging ? Math.round((Math.sin(t * 7 + p * 1.3) * 0.5 + 0.5) * uu * 2.2) : 0;
      // 影。
      ctx.fillStyle = "rgba(0,0,0,0.30)";
      ctx.fillRect(sx - 2 * uu, sy + 3 * uu, 4 * uu, uu);
      // 脚（暗・交互に踏み出す）。
      ctx.fillStyle = "#3a2f1e";
      ctx.fillRect(sx - 2 * uu + sw, sy + uu, 2 * uu, 2 * uu);
      ctx.fillRect(sx - sw, sy + uu, 2 * uu, 2 * uu);
      // 胴（王国色）。
      ctx.fillStyle = body;
      ctx.fillRect(sx - 2 * uu, sy - 2 * uu + ob, 4 * uu, 3 * uu);
      // 腕（肌・歩行で前後に振る＝脚と逆）。
      ctx.fillStyle = skin;
      ctx.fillRect(sx - 3 * uu - sw, sy - 2 * uu + ob, uu, 2 * uu);
      ctx.fillRect(sx + 2 * uu + sw, sy - 2 * uu + ob, uu, 2 * uu);
      // 頭（肌）。
      ctx.fillStyle = skin;
      ctx.fillRect(sx - 2 * uu, sy - 5 * uu + ob, 4 * uu, 3 * uu);
      // 髪（老人は白髪）。
      ctx.fillStyle = hair;
      ctx.fillRect(sx - 2 * uu, sy - 5 * uu + ob, 4 * uu, uu);
      // 目（向き側に1ドット）。
      ctx.fillStyle = "#2a1c10";
      ctx.fillRect(sx + (fd > 0 ? uu : -2 * uu), sy - 4 * uu + ob, uu, uu);
      // 役割の帽子（子供は被らない）。
      if (!isChild) {
        const hat = ROLE_HAT[person.role];
        if (hat) {
          ctx.fillStyle = hat;
          ctx.fillRect(sx - 2 * uu, sy - 6 * uu + ob, 4 * uu, uu);
        }
      }
      // 将（その国で最も武名ある兵）には軍旗を掲げる（軍を率いる者が一目で分かる）。
      if (k && k._genRef === person) {
        const fx0 = sx + 3 * uu, fy0 = sy - 7 * uu + ob;
        ctx.fillStyle = "#6b4a2a"; ctx.fillRect(fx0, fy0, Math.max(1, uu * 0.6) | 0 || 1, 5 * uu); // 旗竿
        const wave = Math.round(Math.sin(t * 4 + p) * uu * 0.4);
        ctx.fillStyle = body; ctx.fillRect(fx0 + uu, fy0 + wave, 3 * uu, 2 * uu);                 // 軍旗（国色）
        ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.fillRect(fx0 + uu, fy0 + wave, 3 * uu, Math.max(1, uu * 0.4) | 0 || 1);
      }
      // 名のある人物（英傑・賢人）には金の輝きを頭上に灯す（社会の傑物を可視化）。
      if (person._famed) {
        const tw = 0.6 + 0.4 * Math.sin(t * 4 + p); // きらめき
        ctx.fillStyle = "rgba(255,224,120," + tw.toFixed(2) + ")";
        ctx.fillRect(sx, sy - 8 * uu + ob, uu, uu);          // 上の光点
        ctx.fillRect(sx - uu, sy - 7 * uu + ob, 3 * uu, uu); // 横の光（小さな星形）
      }

      // 道具・武器（子供は持たない。役割と装備段階 gear で見た目が変わる＝実際に持って使う）。
      if (!isChild) {
        const g = person.gear || 0;
        const metal = g >= 4 ? "#e8eef4" : g >= 3 ? "#cdd6df" : g >= 2 ? "#c9a24a" : g >= 1 ? "#b98c4a" : "#9a9a9a";
        const wood = "#6b4a2a";
        const hxp = fd > 0 ? sx + 2 * uu : sx - 3 * uu; // 手の位置
        switch (person.role) {
          case 3: // 兵士: 槍（鋼が進むと剣に鍔がつく）。交戦中は突き出す/振り下ろす。
            ctx.fillStyle = wood; ctx.fillRect(hxp, sy - 5 * uu + ob - ws, uu, 7 * uu);
            ctx.fillStyle = metal; ctx.fillRect(hxp, sy - 6 * uu + ob - ws, uu, 2 * uu);
            if (g >= 3) { ctx.fillStyle = metal; ctx.fillRect(hxp - uu, sy - 5 * uu + ob - ws, 3 * uu, uu); }
            break;
          case 1: // 農民: 鍬（耕作中は振り上げて打ち下ろす）。
            ctx.fillStyle = wood; ctx.fillRect(hxp, sy - 4 * uu + ob - ws, uu, 6 * uu);
            ctx.fillStyle = metal; ctx.fillRect(hxp + (fd > 0 ? uu : -uu), sy - 4 * uu + ob - ws, uu, uu);
            break;
          case 4: // 鍛冶/坑夫: 坑夫はつるはし、鍛冶は槌（採掘・鍛造中は振り下ろす）
            if (person.mining) {
              ctx.fillStyle = wood; ctx.fillRect(hxp, sy - 5 * uu + ob - ws, uu, 7 * uu);       // 柄
              ctx.fillStyle = "#9aa0a8";                                                          // つるはしの頭（両刃）
              ctx.fillRect(hxp - uu, sy - 5 * uu + ob - ws, uu, uu);
              ctx.fillRect(hxp + uu, sy - 6 * uu + ob - ws, uu, uu);
              break;
            }
          /* falls through */
          case 2: // 建築家: 槌（普請中は槌を振る）
            ctx.fillStyle = wood; ctx.fillRect(hxp, sy - 3 * uu + ob - ws, uu, 5 * uu);
            ctx.fillStyle = person.role === 4 ? "#55585f" : metal;
            ctx.fillRect(hxp - uu, sy - 4 * uu + ob - ws, 3 * uu, 2 * uu);
            break;
          case 6: // 神官: 杖（先端が金色）
            ctx.fillStyle = wood; ctx.fillRect(hxp, sy - 5 * uu + ob, uu, 7 * uu);
            ctx.fillStyle = "#e8d05a"; ctx.fillRect(hxp, sy - 6 * uu + ob, uu, uu);
            break;
          case 5: // 商人: 背中の荷
            ctx.fillStyle = "#7a5a32";
            ctx.fillRect(fd > 0 ? sx - 3 * uu : sx + 2 * uu, sy - 2 * uu + ob, uu, 3 * uu);
            break;
        }
      }
    }
  };

  // 天候: 雲の影を地表に落とし、雨域を青く翳らせ、落雷を白く閃かせる。
  Renderer.prototype.drawWeather = function (camera) {
    if (Game.config.settings && Game.config.settings.weather === false) return;
    const weather = Game.state.weather;
    if (!weather || !weather.clouds || weather.clouds.length === 0) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    const ctx = this.ctx;
    const clouds = weather.clouds;
    ctx.save();
    for (let c = 0; c < clouds.length; c++) {
      const cl = clouds[c];
      const sx = camera.worldToScreenX(cl.x * tile);
      const sy = camera.worldToScreenY(cl.y * tile);
      const r = cl.r * scale;
      if (sx < -r || sy < -r || sx - r > this.cssW || sy - r > this.cssH) continue;
      // 雲の影（雨域）。
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      g.addColorStop(0, "rgba(40,55,85,0.30)");
      g.addColorStop(0.7, "rgba(40,55,85,0.18)");
      g.addColorStop(1, "rgba(40,55,85,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      // 落雷フラッシュ。
      if (cl.flash) {
        ctx.fillStyle = "rgba(235,240,255," + (cl.flash / 10).toFixed(2) + ")";
        ctx.beginPath();
        ctx.arc(sx, sy, r * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  // 昼夜の環境光オーバーレイ。夜は青く暗く、朝夕は暖色。夜は都市が灯る。
  Renderer.prototype.drawDayNight = function (camera) {
    if (!Game.lighting) return;
    if (Game.config.settings && Game.config.settings.dayNight === false) return;
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

  // 戦略資源を地図上に小さなアイコンで描く（一定以上ズーム時）。
  Renderer.prototype.drawResources = function (camera) {
    if (Game.config.settings && Game.config.settings.resources === false) return;
    const world = this.world;
    const list = world.resourceList;
    if (!list || !list.length) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 3) return; // 小さすぎる時は省略
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const s = Math.max(3, scale * 0.5);
    for (let k = 0; k < list.length; k++) {
      const r = list[k];
      if (r.x < range.x0 || r.x > range.x1 || r.y < range.y0 || r.y > range.y1) continue;
      const cx = camera.worldToScreenX((r.x + 0.5) * tile);
      const cy = camera.worldToScreenY((r.y + 0.5) * tile);
      if (r.t === 1) { // 鉱石: 岩塊＋鉱脈の粒
        ctx.fillStyle = "#574f47"; ctx.fillRect(cx - s * 0.5, cy - s * 0.4, s, s * 0.8);
        ctx.fillStyle = "#c9a24a"; ctx.fillRect(cx - s * 0.22, cy - s * 0.12, s * 0.26, s * 0.26);
        ctx.fillStyle = "#e7decb"; ctx.fillRect(cx + s * 0.05, cy + s * 0.04, s * 0.2, s * 0.2);
      } else if (r.t === 2) { // 漁場: 波と魚影
        ctx.fillStyle = "rgba(190,230,248,0.85)"; ctx.fillRect(cx - s * 0.5, cy + s * 0.15, s, s * 0.18);
        ctx.fillStyle = "#34637e"; ctx.fillRect(cx - s * 0.28, cy - s * 0.22, s * 0.5, s * 0.22);
        ctx.fillStyle = "#34637e"; ctx.fillRect(cx + s * 0.22, cy - s * 0.16, s * 0.14, s * 0.1);
      } else if (r.t === 4) { // 金鉱石: 岩塊に輝く金塊
        ctx.fillStyle = "#5a4a36"; ctx.fillRect(cx - s * 0.5, cy - s * 0.4, s, s * 0.8);
        ctx.fillStyle = "#f3c433"; ctx.fillRect(cx - s * 0.2, cy - s * 0.16, s * 0.32, s * 0.3);
        ctx.fillStyle = "#ffe98a"; ctx.fillRect(cx - s * 0.1, cy - s * 0.08, s * 0.14, s * 0.14);
        ctx.fillStyle = "#fff6cf"; ctx.fillRect(cx + s * 0.12, cy + s * 0.06, s * 0.12, s * 0.12);
      } else if (r.t === 5) { // 馬: 草地の駿馬（胴＋脚＋首）
        ctx.fillStyle = "#7a4a28"; ctx.fillRect(cx - s * 0.34, cy - s * 0.16, s * 0.62, s * 0.3); // 胴
        ctx.fillRect(cx + s * 0.18, cy - s * 0.42, s * 0.16, s * 0.3); // 首
        ctx.fillStyle = "#5e3a20"; ctx.fillRect(cx - s * 0.28, cy + s * 0.12, s * 0.1, s * 0.26); ctx.fillRect(cx + s * 0.1, cy + s * 0.12, s * 0.1, s * 0.26); // 脚
      } else if (r.t === 6) { // 香辛料: 色鮮やかな実・葉
        ctx.fillStyle = "#3f8f3a"; ctx.fillRect(cx - s * 0.4, cy + s * 0.1, s * 0.8, s * 0.16); // 葉床
        ctx.fillStyle = "#d8542a"; ctx.fillRect(cx - s * 0.28, cy - s * 0.2, s * 0.22, s * 0.22);
        ctx.fillStyle = "#e8a23a"; ctx.fillRect(cx + s * 0.02, cy - s * 0.26, s * 0.2, s * 0.2);
        ctx.fillStyle = "#c23030"; ctx.fillRect(cx + s * 0.16, cy + s * 0.0, s * 0.16, s * 0.16);
      } else if (r.t === 7) { // 塩: 白い結晶の山
        ctx.fillStyle = "#eef2f6";
        ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.42); ctx.lineTo(cx + s * 0.42, cy + s * 0.34); ctx.lineTo(cx - s * 0.42, cy + s * 0.34); ctx.closePath(); ctx.fill();
        ctx.fillStyle = "#ffffff"; ctx.fillRect(cx - s * 0.08, cy - s * 0.1, s * 0.16, s * 0.16);
        ctx.fillStyle = "#c7d2dc"; ctx.fillRect(cx - s * 0.3, cy + s * 0.22, s * 0.6, s * 0.1);
      } else if (r.t === 8) { // 良材: 積まれた丸太
        ctx.fillStyle = "#6b4a2a"; ctx.fillRect(cx - s * 0.42, cy - s * 0.06, s * 0.84, s * 0.22);
        ctx.fillRect(cx - s * 0.3, cy - s * 0.3, s * 0.6, s * 0.2);
        ctx.fillStyle = "#caa06a"; ctx.fillRect(cx - s * 0.42, cy - s * 0.06, s * 0.14, s * 0.22); ctx.fillRect(cx + s * 0.28, cy - s * 0.06, s * 0.14, s * 0.22); // 木口
        ctx.fillRect(cx - s * 0.3, cy - s * 0.3, s * 0.12, s * 0.2);
      } else { // 宝石: きらめく結晶
        ctx.fillStyle = "#46d6c8";
        ctx.beginPath();
        ctx.moveTo(cx, cy - s * 0.5); ctx.lineTo(cx + s * 0.4, cy);
        ctx.lineTo(cx, cy + s * 0.5); ctx.lineTo(cx - s * 0.4, cy); ctx.closePath(); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.fillRect(cx - s * 0.08, cy - s * 0.25, s * 0.16, s * 0.22);
      }
    }
  };

  // 街道・交易路を行き交う荷馬車。経済の流れを可視化する（一定以上ズーム時）。
  Renderer.prototype.drawCaravans = function (camera) {
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 2.5) return;
    const ctx = this.ctx;
    const ks = civ.kingdoms;
    const t = this._t;
    const range = camera.visibleTileRange();
    const size = Math.max(3, scale * 0.5);
    const self = this;
    const world = this.world, isWater = Game.tile.isWater;
    function wagon(ax, ay, bx, by, frac, col) {
      const x = ax + (bx - ax) * frac, y = ay + (by - ay) * frac;
      if (x < range.x0 - 1 || x > range.x1 + 1 || y < range.y0 - 1 || y > range.y1 + 1) return;
      const sx = camera.worldToScreenX((x + 0.5) * tile);
      const sy = camera.worldToScreenY((y + 0.5) * tile);
      // 海上の区間では帆船で、陸上では荷馬車で描く（海路・陸路が見て分かる）。
      const onSea = world && isWater(world.terrain[(y | 0) * world.width + (x | 0)]);
      if (onSea) {
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.fillRect(sx - size * 0.5, sy + size * 0.34, size, size * 0.16);  // 影
        ctx.fillStyle = "#5a3d24";                                            // 船体
        ctx.fillRect(sx - size * 0.5, sy + size * 0.05, size, size * 0.32);
        ctx.fillStyle = "#3a2716"; ctx.fillRect(sx - size * 0.06, sy - size * 0.5, size * 0.12, size * 0.6); // マスト
        ctx.fillStyle = col === "#9a7a3a" ? "#efe4c2" : "#e9dcc0";            // 帆
        ctx.fillRect(sx - size * 0.34, sy - size * 0.42, size * 0.68, size * 0.4);
        return;
      }
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(sx - size * 0.5, sy + size * 0.32, size, size * 0.18); // 影
      ctx.fillStyle = col || "#7a5230";
      ctx.fillRect(sx - size * 0.5, sy - size * 0.3, size, size * 0.6);   // 荷台
      ctx.fillStyle = "#d8c49a";
      ctx.fillRect(sx - size * 0.42, sy - size * 0.5, size * 0.84, size * 0.28); // 幌
      ctx.fillStyle = "#15100a"; // 車輪
      ctx.fillRect(sx - size * 0.4, sy + size * 0.28, size * 0.2, size * 0.2);
      ctx.fillRect(sx + size * 0.2, sy + size * 0.28, size * 0.2, size * 0.2);
    }
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id];
      if (!k || !k.alive || !k.cities || !k.cities.length) continue;
      const cap = k.cities[0];
      // 街道: 首都⇄各都市をゆっくり往復。
      for (let c = 1; c < k.cities.length; c++) {
        const city = k.cities[c];
        const frac = Math.sin(t * 0.35 + id * 1.3 + c * 2.1) * 0.5 + 0.5;
        wagon(cap.x, cap.y, city.x, city.y, frac);
      }
      // 交易路: 実際に交易のある首都間を金色寄りの荷馬車が往来（活発な路ほど多くの隊商）。
      if (k.partners) {
        for (const bStr in k.partners) {
          const b = +bStr;
          if (b <= id) continue;
          const kb = ks[b];
          if (!kb || !kb.alive || !kb.cities || !kb.cities.length) continue;
          const vol = k.partners[b] || 0;
          if (vol < 0.5) continue;
          const cap2 = kb.cities[0];
          // 交易量に応じて1〜5の隊商／船を時間差で走らせる（活発な路ほど賑わう）。
          const wagons = vol > 30 ? 5 : vol > 16 ? 4 : vol > 8 ? 3 : vol > 3 ? 2 : 1;
          for (let wagi = 0; wagi < wagons; wagi++) {
            const frac = (t * 0.06 + id * 0.7 + b * 0.37 + wagi / wagons) % 1;
            wagon(cap.x, cap.y, cap2.x, cap2.y, frac, "#9a7a3a");
          }
        }
      }
    }
  };

  // 街道: 各国の首都と都市を結ぶ線。
  Renderer.prototype.drawRoads = function (camera) {
    const world = this.world;
    const list = world && world.roadList;
    if (!list || !list.length) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 1.4) return;
    // 実際に敷かれた街道タイル（陸地を辿り水を避ける）を描く。直線で水面を突っ切らない。
    const ctx = this.ctx;
    const W = world.width;
    const range = camera.visibleTileRange();
    const x0 = range.x0, x1 = range.x1, y0 = range.y0, y1 = range.y1;
    const seg = Math.ceil(scale) + 1;          // 隣接タイルが繋がって途切れない幅
    const edge = "rgba(58,44,28,0.55)";        // 路肩（暗い縁）
    const surf = "rgba(196,172,122,0.85)";     // 路面（明るい土）
    const inset = Math.max(1, scale * 0.18);
    ctx.save();
    // 2層: まず暗い縁、次に明るい路面。タイルごとに四角を置き、隣接で連続した道に見せる。
    for (let pass = 0; pass < 2; pass++) {
      ctx.fillStyle = pass === 0 ? edge : surf;
      const pad = pass === 0 ? 0 : inset;
      const sz = pass === 0 ? seg : Math.max(1, seg - inset * 2);
      for (let n = 0; n < list.length; n++) {
        const i = list[n];
        const tx = i % W, ty = (i / W) | 0;
        if (tx < x0 - 1 || tx > x1 + 1 || ty < y0 - 1 || ty > y1 + 1) continue;
        const sx = camera.worldToScreenX(tx * tile);
        const sy = camera.worldToScreenY(ty * tile);
        ctx.fillRect((sx + pad) | 0, (sy + pad) | 0, sz | 0, sz | 0);
      }
    }
    // 敷石の質感: 路面に明暗の小石をタイルごと決定的に散らす（ピクセルアートらしさ）。
    if (scale >= 5) {
      const px = Math.max(1, (scale * 0.16) | 0);
      for (let n = 0; n < list.length; n++) {
        const i = list[n];
        const tx = i % W, ty = (i / W) | 0;
        if (tx < x0 || tx > x1 || ty < y0 || ty > y1) continue;
        const sx = camera.worldToScreenX(tx * tile) | 0;
        const sy = camera.worldToScreenY(ty * tile) | 0;
        // タイル index から擬似乱数で2つの小石位置を決める（毎フレーム同じ＝チラつかない）。
        const h1 = (i * 2654435761) >>> 0, h2 = (i * 40503 + 12345) >>> 0;
        const ox1 = (h1 % 1000) / 1000 * (seg - px), oy1 = ((h1 >> 10) % 1000) / 1000 * (seg - px);
        const ox2 = (h2 % 1000) / 1000 * (seg - px), oy2 = ((h2 >> 10) % 1000) / 1000 * (seg - px);
        ctx.fillStyle = "rgba(150,128,86,0.8)";  // 暗い石
        ctx.fillRect(sx + ox1, sy + oy1, px, px);
        ctx.fillStyle = "rgba(220,200,150,0.7)"; // 明るい石
        ctx.fillRect(sx + ox2, sy + oy2, px, px);
      }
    }
    ctx.restore();
  };

  // 田畑: 農場(FARM/GRANARY)のまわりの自国の平地に、畝(うね)の入った耕地を描く。
  //   建物だけでなく「田畑が町を囲う」風景を見せる。建物の下、領土の上に敷く。
  Renderer.prototype.drawFields = function (camera) {
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const world = this.world;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 3.5) return; // 近景のみ（負荷と見栄えの両立）
    const ctx = this.ctx;
    const W = world.width, H = world.height, owner = world.owner;
    const range = camera.visibleTileRange();
    const px = Math.max(1, (scale * 0.16) | 0);
    const kingdoms = civ.kingdoms;
    const T = Game.TERRAIN;
    ctx.save();
    for (let id = 1; id < kingdoms.length; id++) {
      const k = kingdoms[id];
      if (!k || !k.alive || !k.cities) continue;
      for (let c = 0; c < k.cities.length; c++) {
        const bs = k.cities[c].buildings;
        if (!bs) continue;
        for (let bi = 0; bi < bs.length; bi++) {
          const bd = bs[bi];
          if (bd.t !== 5 && bd.t !== 9) continue; // FARM=5 / GRANARY=9 の周りを耕地に
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const fx = bd.x + dx, fy = bd.y + dy;
              if (fx < range.x0 || fx > range.x1 || fy < range.y0 || fy > range.y1) continue;
              if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
              const fi = fy * W + fx;
              if (owner[fi] !== k.id) continue;
              const t = world.terrain[fi];
              if (t !== T.GRASS && t !== T.SAVANNA && t !== T.SAND) continue; // 耕せる平地のみ
              const sx = camera.worldToScreenX(fx * tile) | 0;
              const sy = camera.worldToScreenY(fy * tile) | 0;
              const sz = Math.ceil(scale);
              // 土の下地（耕した畝）。
              ctx.fillStyle = "rgba(102,74,44,0.85)";
              ctx.fillRect(sx, sy, sz, sz);
              // 作物の育ち: 肥沃なほど青々と高く実る。畝(うね)ごとに茎＋穂先を描く。
              const fz = world.fertility ? world.fertility[fi] : 0.6;
              const ripe = 0.55 + 0.45 * Math.min(1, fz);          // 実りの濃さ
              const stem = "rgba(" + (96 + 30 * (1 - ripe)) + "," + (150 + 40 * ripe) + ",70,0.9)";
              const tip = fz > 0.7 ? "rgba(224,200,96,0.95)" : "rgba(150,196,96,0.95)"; // 熟すと黄金の穂
              const step = Math.max(2, px * 2);
              for (let r = px; r < sz - px; r += step) {
                ctx.fillStyle = stem; ctx.fillRect(sx, sy + r, sz, px);          // 茎の列
                ctx.fillStyle = tip; ctx.fillRect(sx, sy + r - px, sz, Math.max(1, px * 0.5)); // 穂先
              }
            }
          }
        }
      }
    }
    ctx.restore();
  };

  // 樹木: 森・密林のタイルに木のドット絵を立てて、平らな緑から「木立」へ。風で梢が揺れる。
  //   近景のみ・可視範囲のみ・本数に上限を設けて負荷を抑える。設定でオフにもできる。
  Renderer.prototype.drawTrees = function (camera) {
    if (Game.config.settings && Game.config.settings.trees === false) return;
    const world = this.world;
    const tile = Game.config.tilePx, scale = tile * camera.zoom;
    if (scale < 5) return;
    const ctx = this.ctx, W = world.width, terr = world.terrain, T = Game.TERRAIN;
    const range = camera.visibleTileRange();
    const u = Math.max(1, scale * 0.13);
    const sway = Math.sin(this._t * 1.6) * scale * 0.04; // そよ風
    let drawn = 0; const CAP = 3600;
    for (let ty = range.y0; ty <= range.y1 && drawn < CAP; ty++) {
      for (let tx = range.x0; tx <= range.x1; tx++) {
        const i = ty * W + tx, tt = terr[i];
        if (tt !== T.FOREST && tt !== T.JUNGLE) continue;
        const hsh = (i * 2654435761) >>> 0;
        const jx = ((hsh % 256) / 256 - 0.5) * scale * 0.45;
        const jy = (((hsh >> 8) % 256) / 256 - 0.5) * scale * 0.35;
        const cx = camera.worldToScreenX((tx + 0.5) * tile) + jx;
        const cy = camera.worldToScreenY((ty + 0.92) * tile) + jy;
        const jungle = tt === T.JUNGLE;
        const sz = u * (jungle ? 1.5 : 1.2) * (0.82 + ((hsh >> 16) % 100) / 100 * 0.4);
        ctx.fillStyle = "rgba(0,0,0,0.16)"; ctx.fillRect((cx - sz * 0.6) | 0, cy | 0, (sz * 1.2) | 0, Math.max(1, sz * 0.3) | 0); // 影
        ctx.fillStyle = "#5a3f24"; ctx.fillRect((cx - sz * 0.16) | 0, (cy - sz * 1.05) | 0, Math.max(1, sz * 0.34) | 0, (sz * 1.05) | 0); // 幹
        const topx = cx + sway * (jungle ? 1.2 : 1);
        ctx.fillStyle = jungle ? "#2f6b34" : "#3f7e3c"; // 梢（風で揺れる）
        ctx.fillRect((topx - sz * 0.9) | 0, (cy - sz * 2.0) | 0, (sz * 1.8) | 0, (sz * 1.1) | 0);
        ctx.fillRect((topx - sz * 0.6) | 0, (cy - sz * 2.5) | 0, (sz * 1.2) | 0, (sz * 0.7) | 0);
        ctx.fillStyle = jungle ? "#3f8746" : "#56a04e"; // 陽の当たる面
        ctx.fillRect((topx - sz * 0.5) | 0, (cy - sz * 2.35) | 0, (sz * 0.75) | 0, (sz * 0.55) | 0);
        if (++drawn >= CAP) break;
      }
    }
  };

  // 伐採の動き: 切られた木が瞬時に消えるのではなく、傾いて倒れていく（civ が伐採点を伝える）。
  Renderer.prototype.drawFellings = function (camera) {
    const fl = Game.state.fellings;
    if (!fl || !fl.length) return;
    const tile = Game.config.tilePx, scale = tile * camera.zoom;
    const ctx = this.ctx, range = camera.visibleTileRange();
    const DUR = 48;
    for (let n = fl.length - 1; n >= 0; n--) {
      const f = fl[n];
      f.age++;
      if (f.age > DUR) { fl.splice(n, 1); continue; }
      if (scale < 4) continue;
      if (f.x < range.x0 - 1 || f.x > range.x1 + 1 || f.y < range.y0 - 1 || f.y > range.y1 + 1) continue;
      const cx = camera.worldToScreenX((f.x + 0.5) * tile), cy = camera.worldToScreenY((f.y + 0.92) * tile);
      const prog = f.age / DUR, sz = Math.max(2, scale * 0.16);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(prog * 1.45);                 // だんだん倒れる
      ctx.globalAlpha = 1 - prog * 0.55;
      ctx.fillStyle = "#5a3f24"; ctx.fillRect(-sz * 0.16, -sz * 1.05, sz * 0.34, sz * 1.05); // 幹
      ctx.fillStyle = "#3f7e3c"; ctx.fillRect(-sz * 0.9, -sz * 2.0, sz * 1.8, sz * 1.1);      // 梢
      ctx.restore();
      if (prog > 0.6) { ctx.fillStyle = "rgba(116,84,48,0.7)"; ctx.fillRect((cx - sz * 0.25) | 0, (cy - sz * 0.25) | 0, (sz * 0.5) | 0, (sz * 0.35) | 0); } // 切り株
    }
  };

  // 戦闘演出: 白刃の火花(clash)・矢(arrow)・銃弾(shot)・流血(blood) を短い寿命で描く。
  //   civ が戦闘イベントで積み、ここで age を進め寿命で消す。
  Renderer.prototype.drawBattleFx = function (camera) {
    const fx = Game.state.battleFx;
    if (!fx || !fx.length) return;
    const tile = Game.config.tilePx, scale = tile * camera.zoom;
    const ctx = this.ctx, range = camera.visibleTileRange();
    const LIFE = { clash: 12, arrow: 12, shot: 10, blood: 30 };
    const sc = (wx) => camera.worldToScreenX((wx + 0.5) * tile);
    const scy = (wy) => camera.worldToScreenY((wy + 0.5) * tile);
    for (let n = fx.length - 1; n >= 0; n--) {
      const f = fx[n];
      f.age++;
      const life = LIFE[f.t] || 12;
      if (f.age > life) { fx.splice(n, 1); continue; }
      if (scale < 2.5) continue;
      if (f.x < range.x0 - 2 || f.x > range.x1 + 2 || f.y < range.y0 - 2 || f.y > range.y1 + 2) continue;
      const pr = f.age / life;
      if (f.t === "clash") {
        // 火花が四方へ弾ける。
        const sx = sc(f.x), sy = scy(f.y), r = scale * (0.2 + pr * 0.5), u = Math.max(1, scale * 0.1);
        ctx.fillStyle = "rgba(255,236,150," + (1 - pr).toFixed(2) + ")";
        for (let a = 0; a < 6; a++) { const ang = a * 1.047 + f.age; ctx.fillRect((sx + Math.cos(ang) * r) | 0, (sy + Math.sin(ang) * r) | 0, u, u); }
        ctx.fillStyle = "rgba(255,255,255," + (1 - pr).toFixed(2) + ")"; ctx.fillRect((sx - u * 0.5) | 0, (sy - u * 0.5) | 0, u, u);
      } else if (f.t === "arrow" || f.t === "shot") {
        // 飛翔体が射手から標的へ飛ぶ。銃は閃光と煙を伴う。
        const x = f.x + (f.x2 - f.x) * pr, y = f.y + (f.y2 - f.y) * pr;
        const sx = sc(x), sy = scy(y), u = Math.max(1, scale * (f.t === "shot" ? 0.13 : 0.1));
        if (f.t === "shot" && pr < 0.3) { ctx.fillStyle = "rgba(255,220,120,0.9)"; ctx.fillRect((sc(f.x) - u) | 0, (scy(f.y) - u) | 0, 2 * u, 2 * u); } // 銃口炎
        ctx.fillStyle = f.t === "shot" ? "#f4f4f4" : "#e8dcb0";
        ctx.fillRect((sx - u * 0.5) | 0, (sy - u * 0.5) | 0, Math.max(1, u * (f.t === "shot" ? 1 : 1.6)) | 0, Math.max(1, u * 0.6) | 0);
      } else if (f.t === "blood") {
        const sx = sc(f.x), sy = scy(f.y), u = Math.max(1, scale * 0.12);
        ctx.fillStyle = "rgba(150,20,20," + (0.8 * (1 - pr)).toFixed(2) + ")";
        const hsh = ((f.x * 131 + f.y * 977) | 0) >>> 0;
        for (let a = 0; a < 5; a++) { const ang = a * 1.257 + (hsh % 7); const rr = scale * 0.3 * (0.4 + (a / 5)); ctx.fillRect((sx + Math.cos(ang) * rr) | 0, (sy + Math.sin(ang) * rr) | 0, u, u); }
      }
    }
  };

  // 交易路: 実際に交易のある国どうしの首都を金色の点線で結ぶ（太さは交易量に比例）。
  Renderer.prototype.drawTradeRoutes = function (camera) {
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 1.4) return;
    const ctx = this.ctx;
    const ks = civ.kingdoms;
    ctx.save();
    ctx.setLineDash([Math.max(3, scale), Math.max(2, scale * 0.7)]);
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id];
      if (!k || !k.alive || !k.partners || !k.cities || !k.cities.length) continue;
      const c0 = k.cities[0];
      for (const bStr in k.partners) {
        const b = +bStr;
        if (b <= id) continue;
        const kb = ks[b];
        if (!kb || !kb.alive || !kb.cities || !kb.cities.length) continue;
        const vol = k.partners[b] || 0;
        if (vol < 0.5) continue;
        const c1 = kb.cities[0];
        // 交易量で線の濃さ・太さを変える（活発な通商路ほど太く明るい）。
        const a = Math.min(0.7, 0.2 + vol * 0.04);
        ctx.strokeStyle = "rgba(240,200,90," + a.toFixed(2) + ")";
        ctx.lineWidth = Math.max(1, scale * (0.08 + Math.min(0.16, vol * 0.012)));
        ctx.beginPath();
        ctx.moveTo(camera.worldToScreenX((c0.x + 0.5) * tile), camera.worldToScreenY((c0.y + 0.5) * tile));
        ctx.lineTo(camera.worldToScreenX((c1.x + 0.5) * tile), camera.worldToScreenY((c1.y + 0.5) * tile));
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  };

  // 国名ラベルを首都の上に描画。
  Renderer.prototype.drawLabels = function (camera) {
    if (Game.config.settings && Game.config.settings.labels === false) return;
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 2.2) return; // 引きすぎでは省略
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const kingdoms = civ.kingdoms;
    const fs = Math.max(10, Math.min(22, scale * 1.4));
    ctx.save();
    ctx.font = "600 " + fs.toFixed(0) + "px -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = Math.max(2, fs * 0.22);
    for (let id = 1; id < kingdoms.length; id++) {
      const k = kingdoms[id];
      if (!k || !k.alive || !k.cities) continue;
      const cap = k.cities[0];
      if (cap.x < range.x0 || cap.x > range.x1 || cap.y < range.y0 || cap.y > range.y1) continue;
      const sx = camera.worldToScreenX((cap.x + 0.5) * tile);
      const sy = camera.worldToScreenY((cap.y + 0.5) * tile) - Math.max(6, scale * 0.9);
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.strokeText(k.name, sx, sy);
      ctx.fillStyle = "#fff";
      ctx.fillText(k.name, sx, sy);
    }
    ctx.restore();
  };

  // 王国の都市マーカーを描画（首都は大きめ）。
  // 都市を描画。十分ズームしていれば家々と砦のドット絵で街並みを表現する。
  Renderer.prototype.drawCities = function (camera) {
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 1.0) return;
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const kingdoms = civ.kingdoms;
    const sprites = Game.sprites;
    const detailed = scale >= 3 && sprites; // 近景は建物、遠景は色点

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (let id = 1; id < kingdoms.length; id++) {
      const k = kingdoms[id];
      if (!k || !k.alive || !k.cities) continue;
      const col = k.color;
      for (let c = 0; c < k.cities.length; c++) {
        const city = k.cities[c];
        if (city.x < range.x0 - 3 || city.x > range.x1 + 3 || city.y < range.y0 - 3 || city.y > range.y1 + 3) continue;
        const sx = camera.worldToScreenX((city.x + 0.5) * tile);
        const sy = camera.worldToScreenY((city.y + 0.5) * tile);
        const level = city.level || 1;

        // 攻囲中の都市: 赤い包囲環と立ち上る煙で「攻められている」ことを示す。
        if (city.siege > 0.12) {
          const sg = Math.min(1, city.siege);
          const rr = Math.max(4, scale * (1.4 + level * 0.25));
          const pulse = 0.35 + 0.25 * Math.sin(this._t * 4);
          ctx.strokeStyle = "rgba(232,70,60," + (pulse * sg).toFixed(2) + ")";
          ctx.lineWidth = Math.max(1.5, scale * 0.18);
          ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke();
          if (scale >= 4) { // 立ち上る煙
            ctx.fillStyle = "rgba(60,55,52," + (0.4 * sg).toFixed(2) + ")";
            const u = Math.max(1, scale * 0.2);
            for (let s = 0; s < 3; s++) { const ph = this._t * 1.5 + s * 2; ctx.fillRect((sx - rr * 0.5 + s * rr * 0.5) | 0, (sy - rr * 0.7 - (this._t * 6 + s * 11) % (rr)) | 0, u, u); }
          }
        }

        if (!detailed) {
          // 遠景: 国色の点。
          const rad = (city.capital ? Math.max(2.5, scale * 0.6) : Math.max(1.5, scale * 0.4)) * (1 + (level - 1) * 0.2);
          ctx.beginPath(); ctx.arc(sx, sy, rad + 1, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fill();
          ctx.beginPath(); ctx.arc(sx, sy, rad, 0, Math.PI * 2);
          ctx.fillStyle = "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")"; ctx.fill();
          continue;
        }

        // 近景: 人間が建てた実際の建物を描く。
        const bs = city.buildings;
        if (bs && bs.length) {
          // 建物は人物より明確に大きく（家で約2タイル幅を基準に、種別で増減）。
          const size = Math.max(10, scale * 1.6);
          for (let bi = 0; bi < bs.length; bi++) {
            const bd = bs[bi];
            const img = sprites.building(bd.t);
            // 種別ごとの相対サイズ: 小屋は小さく、邸宅・砦・神殿・記念碑は大きく。
            const bw = size * (BUILD_SIZE[bd.t] || 1);
            const bh = bw * (img.height / img.width);
            const bx = camera.worldToScreenX((bd.x + 0.5) * tile);
            const by = camera.worldToScreenY((bd.y + 0.5) * tile);
            // 接地影（建物の足元に落として街に立体感を出す）。
            ctx.fillStyle = "rgba(0,0,0,0.26)";
            ctx.beginPath();
            ctx.ellipse(bx, by - bh * 0.06, bw * 0.44, bw * 0.16, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.drawImage(img, (bx - bw * 0.5) | 0, (by - bh) | 0, bw | 0, bh | 0);
            // 鉱山(MINE=10): 採掘の現場を建物の手前に描く。わきにズリ山(残土)とトロッコ。
            if (bd.t === 10 && scale >= 5) {
              const u = Math.max(1, scale * 0.16);
              // ズリ山（採掘で出た残土の山。建物の左下）。
              ctx.fillStyle = "rgba(96,84,64,0.92)";
              ctx.beginPath();
              ctx.moveTo(bx - bw * 0.58, by);
              ctx.lineTo(bx - bw * 0.28, by - bh * 0.32);
              ctx.lineTo(bx - bw * 0.02, by);
              ctx.closePath(); ctx.fill();
              ctx.fillStyle = "rgba(118,104,80,0.9)"; ctx.fillRect((bx - bw * 0.4) | 0, (by - bh * 0.16) | 0, u, u);
              // トロッコ（鉱石を積んだ手押し車。建物の右下）。
              ctx.fillStyle = "#2b2622"; ctx.fillRect((bx + bw * 0.24) | 0, (by - 2 * u) | 0, 3 * u, 2 * u);
              ctx.fillStyle = "#caa24a"; ctx.fillRect((bx + bw * 0.24 + u * 0.5) | 0, (by - 2.7 * u) | 0, 2 * u, u); // 鉱石
              ctx.fillStyle = "#15110e";
              ctx.fillRect((bx + bw * 0.26) | 0, (by - u) | 0, u, u);
              ctx.fillRect((bx + bw * 0.24 + 2 * u) | 0, (by - u) | 0, u, u); // 車輪
            }
          }
        }
        if (city.capital) {
          // 国旗（砦の上）。
          const fs = Math.max(2, scale * 0.5);
          ctx.fillStyle = "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")";
          ctx.fillRect((sx - fs * 0.5) | 0, (sy - Math.max(10, scale * 1.6)) | 0, fs, fs);
        }
      }
    }
    ctx.restore();
  };

  // インスペクタで選択した対象に、脈打つ輪のハイライトを描く。
  Renderer.prototype.drawSelection = function (camera) {
    const sel = Game.state.selection;
    if (!sel) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    const ctx = this.ctx;
    const sx = camera.worldToScreenX(sel.x * tile);
    const sy = camera.worldToScreenY(sel.y * tile);
    const base = sel.kind === "nation" ? Math.max(14, scale * 1.6) : Math.max(9, scale * 0.9);
    const pulse = 1 + 0.16 * Math.sin(this._t * 4);
    const r = base * pulse;
    ctx.save();
    ctx.lineWidth = Math.max(1.5, scale * 0.08);
    ctx.strokeStyle = sel.color || "#8fd0ff";
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    // 内側に薄い白で視認性を上げる。
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = Math.max(1, scale * 0.04);
    ctx.beginPath();
    ctx.arc(sx, sy, r - Math.max(2, scale * 0.08), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  // 戦場の痕跡（戦死地点）を、時間で薄れる赤黒い染みで描く。
  Renderer.prototype.drawMarks = function (camera) {
    const civ = Game.state.civ;
    if (!civ || !civ.marks || !civ.marks.length) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 2) return;
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const marks = civ.marks;
    const s = Math.max(2, scale * 0.5);
    for (let m = 0; m < marks.length; m++) {
      const mk = marks[m];
      if (mk.x < range.x0 || mk.x > range.x1 || mk.y < range.y0 || mk.y > range.y1) continue;
      const a = (mk.ttl / mk.life) * 0.6; // 時間で薄れる
      const cx = camera.worldToScreenX((mk.x + 0.5) * tile);
      const cy = camera.worldToScreenY((mk.y + 0.5) * tile);
      ctx.fillStyle = "rgba(110,18,16," + a.toFixed(3) + ")";
      ctx.fillRect(cx - s * 0.5, cy - s * 0.35, s, s * 0.7);
      ctx.fillStyle = "rgba(60,10,10," + a.toFixed(3) + ")";
      ctx.fillRect(cx - s * 0.2, cy - s * 0.12, s * 0.4, s * 0.28);
    }
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
    if (Game.state.activeToolId === "inspect") return; // 調べるツールはブラシ円を出さない
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
