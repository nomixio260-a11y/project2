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
  const BUILD_SIZE = [0.78, 1.0, 1.28, 1.55, 1.4, 0.95, 1.02, 0.88, 1.2, 1.0, 0.85, 2.1, 1.45, 1.15, 0.98, 1.35, 1.25];
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

  // タイルの領土色（地図ビュー対応）。領地ビューでは「その国のどの都市の勢力圏か」で塗り分ける。
  function territoryTileColor(civ, id, x, y) {
    if ((Game.state && Game.state.mapView) === "province" && civ.provinceColorAt) return civ.provinceColorAt(id, x, y);
    return civ.viewColorOf ? civ.viewColorOf(id) : civ.colorOf(id);
  }

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
        const c = territoryTileColor(civ, id, x, y);
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
        const c = territoryTileColor(civ, id, x, y); // 領地ビューでは州ごとに塗り分け
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

  // 1タイルの色（標高＋陰影）をオフスクリーン地形バッファへ描き直す。
  Renderer.prototype._paintTile = function (world, rgb, tctx, x, y) {
    const i = y * world.width + x;
    const c = rgb[world.terrain[i]];
    const shade = this._tileShade(world, i, x, y);
    const r = Math.min(255, (c[0] * shade) | 0), g = Math.min(255, (c[1] * shade) | 0), b = Math.min(255, (c[2] * shade) | 0);
    tctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
    tctx.fillRect(x, y, 1, 1);
  };

  // dirty タイルをオフスクリーンへ反映。
  Renderer.prototype.flushDirty = function () {
    if (this.dirty.length === 0) return;
    const world = this.world;
    const rgb = Game.TERRAIN_RGB;
    const tctx = this.terrainCtx;
    const W = world.width, H = world.height;
    for (let k = 0; k < this.dirty.length; k += 2) {
      const x = this.dirty[k], y = this.dirty[k + 1];
      this._paintTile(world, rgb, tctx, x, y);
      // 陰影は西・北の隣接標高から算出するため、編集タイルは東・南の隣の陰影も変える。
      //   その2タイルも塗り直さないと縁に古い陰影が残る（改変後の照明のズレ）。
      if (x + 1 < W) this._paintTile(world, rgb, tctx, x + 1, y);
      if (y + 1 < H) this._paintTile(world, rgb, tctx, x, y + 1);
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

    // 地表の質感（近景で草・砂粒・岩肌・雪の粒立ちを添える。平坦な塗りに生命を与える）。
    this.drawTerrainDetail(camera);

    // 水面のきらめき（海・湖が穏やかに波打つ。静的な地形に生命を与える）。
    this.drawWater(camera);

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

    // 国情勢バッジ（戦争・飢饉・疫病・反乱・黄金/暗黒時代を首都上に表示）。世界の情勢を一目で。
    this.drawStatusBadges(camera);

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
        // 種別で実寸が違う: 草食(鹿)は人と同程度の背丈、肉食(狼)はより低い。
        //   人物の縮小に合わせ、動物も現実的な対比に保つ（鹿≈人の肩丈、狼≈人の腰丈）。
        const species = type === SP.PREDATOR ? 0.46 : 0.68;
        const dh = Math.max(4, scale * species * gene * grow);
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
    // ドット単位。人物は建物に対し現実的に小さく（家の高さの約1/4、城砦の約1/6）、
    //   都市が「人の集う大きな構造物」として実感できる対比にする。
    const u = Math.max(1, Math.round(scale * 0.065));
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
      let ob = moving ? -Math.round(Math.abs(Math.sin(ph)) * uu * 0.5) : 0; // 上下動
      // 仕事の動作: 建築(6)・耕作(7)・専門職(12)、または交戦中の兵は道具/武器を振る。
      //   瞬時に終わらず、振りかぶって打ち下ろす動きで「働いている」ことが見える。
      const st = person.state;
      const working = (st === 6 || st === 7 || st === 12);
      const swinging = working || (person.role === 3 && person._enemy);
      // 0..1 の打ち下ろし量（上に振り上げ、下に打つ）。
      const ws = swinging ? Math.round((Math.sin(t * 7 + p * 1.3) * 0.5 + 0.5) * uu * 2.2) : 0;
      // 状態ごとの動き（余暇・休息で姿が多彩に動く）。子は跳ね、踊り手は揺れ、祈る者は頭を垂れ、
      //   野宿は寝息、立ち止まる者も微かに呼吸する＝世界が凍りつかず、何をしているか姿で分かる。
      let hx = 0, emote = 0;
      if (st === 20) { ob -= Math.round(Math.abs(Math.sin(t * 6 + p)) * uu * (moving ? 0.5 : 1.0)); if (!moving) emote = 3; } // 遊ぶ子: 跳ねる(+喜び)
      else if (!moving && !swinging) {
        if (st === 17) { hx = Math.round(Math.sin(t * 5 + p * 1.7) * uu * 0.8); emote = 1; }            // 祭り: 踊る ♪
        else if (st === 18) { ob += Math.round((Math.sin(t * 1.1 + p) * 0.5 + 0.5) * uu * 0.9); }       // 礼拝: 頭を垂れる
        else if (st === 13 && !person._sheltered) { emote = 2; ob += Math.round((Math.sin(t * 1.4 + p) * 0.5 + 0.5) * uu * 0.3); } // 野宿: 寝息 Zzz
        else { ob += Math.round(Math.sin(t * 1.8 + p) * uu * 0.18); }                                    // 静止時の呼吸
      }
      // 影（地面に固定。踊りで胴は揺れても影は動かさない）。
      ctx.fillStyle = "rgba(0,0,0,0.30)";
      ctx.fillRect(sx - 2 * uu, sy + 3 * uu, 4 * uu, uu);
      if (hx) sx += hx; // 踊り手は体を左右に揺らす（影の後に適用して足元は留める）
      // 脚（暗・交互に踏み出す）。
      ctx.fillStyle = "#3a2f1e";
      ctx.fillRect(sx - 2 * uu + sw, sy + uu, 2 * uu, 2 * uu);
      ctx.fillRect(sx - sw, sy + uu, 2 * uu, 2 * uu);
      // 胴（王国色）。
      ctx.fillStyle = body;
      ctx.fillRect(sx - 2 * uu, sy - 2 * uu + ob, 4 * uu, 3 * uu);
      // 役割の装い（胴に重ねる。国色の上に職掌を示す衣で、役割が姿で見分けられる）。
      if (!isChild) {
        const ry = sy - 2 * uu + ob;
        switch (person.role) {
          case 6: // 神官: 白い法衣（胴を覆い、裾が長く垂れる）
            ctx.fillStyle = "rgba(236,233,224,0.82)";
            ctx.fillRect(sx - 2 * uu, ry, 4 * uu, 3 * uu);
            ctx.fillRect(sx - 2 * uu, ry + 3 * uu, 4 * uu, uu); // 裾
            break;
          case 3: { // 兵士: 具足（金属の胸当てと左肩の照り。装備段階で輝きが増す）
            const g0 = person.gear || 0;
            const arm = g0 >= 4 ? "#e8eef4" : g0 >= 3 ? "#cdd6df" : g0 >= 2 ? "#c9a24a" : "#8b8f96";
            ctx.fillStyle = arm; ctx.fillRect(sx - 2 * uu, ry, 4 * uu, uu); // 肩当て
            ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.fillRect(sx - 2 * uu, ry, uu, 3 * uu); // 左の照り
            break;
          }
          case 4: // 鍛冶/坑夫: 煤けた革の前掛け
            ctx.fillStyle = "#5a3f28"; ctx.fillRect(sx - uu, ry + uu, 2 * uu, 2 * uu);
            break;
          case 5: // 商人: 金の帯と巾着（実りある商いの証）
            ctx.fillStyle = "#c9a24a"; ctx.fillRect(sx - 2 * uu, ry + 2 * uu, 4 * uu, Math.max(1, uu * 0.7) | 0 || 1);
            break;
          case 1: // 農民: 生成りの前掛け
            ctx.fillStyle = "rgba(212,198,152,0.72)"; ctx.fillRect(sx - uu, ry + uu, 2 * uu, 2 * uu);
            break;
        }
      }
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
      // 将旗: 軍を率いる将は国色の軍旗を掲げる（軍勢の所在と所属が戦場で一目で分かる）。
      if (k && k._genRef === person) {
        const top = sy - 10 * uu + ob;
        ctx.fillStyle = "#6b4a2a";
        ctx.fillRect(sx + 3 * uu, top, Math.max(1, uu * 0.6) | 0, 7 * uu); // 旗竿
        const wv = Math.round(Math.sin(t * 5 + p) * uu * 0.7);
        ctx.fillStyle = body;
        ctx.fillRect(sx + 3 * uu + uu, top + wv, 3 * uu, 2 * uu); // 国色の旗
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.fillRect(sx + 3 * uu + uu, top + wv, 3 * uu, Math.max(1, uu * 0.4) | 0); // 上辺の照り
      }
      // 役割の被り物（子供は被らない）。兵は兜、神官は頭巾、他は職掌の帽子で役割が一目で分かる。
      if (!isChild) {
        if (person.role === 3) {
          // 兵士: 金属の兜（装備段階で輝きが増し、頂に鶏冠、面頬の陰）。
          const g0 = person.gear || 0;
          const helm = g0 >= 4 ? "#e8eef4" : g0 >= 3 ? "#c9d0d8" : g0 >= 2 ? "#c9a24a" : "#9aa0a8";
          ctx.fillStyle = helm;
          ctx.fillRect(sx - 2 * uu, sy - 6 * uu + ob, 4 * uu, 2 * uu); // 兜の鉢
          ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(sx - 2 * uu, sy - 6 * uu + ob, uu, 2 * uu); // 左の照り
          ctx.fillStyle = "rgba(0,0,0,0.28)"; ctx.fillRect(sx - 2 * uu, sy - 4 * uu + ob, 4 * uu, Math.max(1, uu * 0.5) | 0 || 1); // 面頬の陰
        } else if (person.role === 6) {
          // 神官: 頭巾（頭と両脇を覆う白い布）。
          ctx.fillStyle = "#ece9e0";
          ctx.fillRect(sx - 2 * uu, sy - 6 * uu + ob, 4 * uu, uu);       // 頭頂
          ctx.fillRect(sx - 3 * uu, sy - 5 * uu + ob, uu, 2 * uu);       // 左の垂れ
          ctx.fillRect(sx + 2 * uu, sy - 5 * uu + ob, uu, 2 * uu);       // 右の垂れ
        } else {
          const hat = ROLE_HAT[person.role];
          if (hat) {
            ctx.fillStyle = hat;
            ctx.fillRect(sx - 2 * uu, sy - 6 * uu + ob, 4 * uu, uu);
            // 農民は麦わら帽のつば、建築家は工人帽のつばを少し広げる。
            if (person.role === 1 || person.role === 2) ctx.fillRect(sx - 3 * uu, sy - 5 * uu + ob, 6 * uu, Math.max(1, uu * 0.5) | 0 || 1);
          }
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
      // 感情・行動のしるし（頭上に小さく）: 祭り=♪音符 / 野宿=Zzz / 遊び=喜びの光。
      if (emote && scale >= 6) {
        const ey = sy - 6 * uu + ob, bob = Math.round(Math.sin(t * 3 + p) * uu * 0.4);
        if (emote === 1) {            // ♪ 音符（祭り・団欒）
          ctx.fillStyle = "#ffe27a";
          ctx.fillRect((sx + 2 * uu) | 0, (ey - uu + bob) | 0, uu, 3 * uu);            // 棒
          ctx.fillRect((sx + uu) | 0, (ey + 2 * uu + bob) | 0, 2 * uu, Math.max(1, uu * 1.2) | 0); // 玉
        } else if (emote === 2) {     // Zzz（野宿の眠り）
          ctx.fillStyle = "rgba(220,230,255,0.8)";
          const zb = Math.round(Math.sin(t * 1.4 + p) * uu * 0.6);
          ctx.fillRect((sx + uu) | 0, (ey + zb) | 0, Math.max(1, uu * 1.6) | 0, Math.max(1, uu * 0.6) | 0);
          ctx.fillRect((sx + 2 * uu) | 0, (ey + uu + zb) | 0, Math.max(1, uu) | 0, Math.max(1, uu * 0.6) | 0);
        } else if (emote === 3) {     // 喜びの光（遊ぶ子）
          const tw = 0.5 + 0.5 * Math.sin(t * 6 + p);
          ctx.fillStyle = "rgba(255,236,150," + tw.toFixed(2) + ")";
          ctx.fillRect((sx - uu) | 0, (ey + bob) | 0, uu, uu);
          ctx.fillRect((sx + uu) | 0, (ey - uu + bob) | 0, uu, uu);
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
      // 降雨: 水分の多い雲は雨脚を落とす（風に流れる斜めの雨筋が降りそそぐ）。
      if (cl.water > 0.45 && scale >= 2.5) {
        const rainA = Math.min(0.4, (cl.water - 0.45) * 1.0);
        ctx.strokeStyle = "rgba(170,196,230," + rainA.toFixed(3) + ")";
        ctx.lineWidth = Math.max(1, scale * 0.05);
        const wind = (weather.wind || { x: 0, y: 0 });
        const slant = (wind.x || 0) * scale * 2 + scale * 0.18;
        const len = scale * 0.9;
        const t = this._t;
        ctx.beginPath();
        for (let d = 0; d < 14; d++) {
          const hx = ((d * 73) % 100) / 100 - 0.5;
          const hz = ((d * 137) % 100) / 100;
          const px = sx + hx * r * 1.4;
          const fall = (t * 1.6 + hz) % 1;
          const py = sy - r * 0.6 + fall * r * 1.6;
          ctx.moveTo(px, py);
          ctx.lineTo(px + slant * 0.3, py + len);
        }
        ctx.stroke();
      }
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
        // 蛍火: 夜の集落のまわりを、いくつかの淡い光がふわふわと漂いまたたく（夜の生命感）。
        if (scale >= 6) {
          const t = this._t;
          const n = city.capital ? 6 : 3;
          for (let f = 0; f < n; f++) {
            const seed = id * 13 + c * 7 + f * 3.1;
            const fx = sx + Math.sin(t * 0.7 + seed) * rad * 1.4 + Math.cos(t * 0.4 + seed * 1.7) * rad * 0.5;
            const fy = sy + Math.cos(t * 0.6 + seed * 1.3) * rad * 1.1 + Math.sin(t * 0.9 + seed) * rad * 0.4;
            const tw = 0.5 + 0.5 * Math.sin(t * 3.5 + seed * 2.2);
            const fsz = Math.max(1, scale * 0.1) | 0;
            ctx.fillStyle = "rgba(210,255,150," + (0.7 * tw * glow).toFixed(3) + ")";
            ctx.fillRect(fx | 0, fy | 0, fsz, fsz);
          }
        }
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
    const world = this.world, isWater = Game.tile.isWater;
    // cargo: 積荷の色（交易される財を表す）。trade: 交易路の隊商か（街道の荷車と区別）。
    function wagon(ax, ay, bx, by, frac, cargo, trade) {
      const x = ax + (bx - ax) * frac, y = ay + (by - ay) * frac;
      if (x < range.x0 - 1 || x > range.x1 + 1 || y < range.y0 - 1 || y > range.y1 + 1) return;
      const sx = camera.worldToScreenX((x + 0.5) * tile);
      const sy = camera.worldToScreenY((y + 0.5) * tile);
      const dir = bx - ax; const faceL = dir < 0; const fs = faceL ? -1 : 1; // 進行方向
      cargo = cargo || "#c9a86a";
      // 海上の区間では帆船で、陸上では荷馬車で描く（海路・陸路が見て分かる）。
      const onSea = world && isWater(world.terrain[(y | 0) * world.width + (x | 0)]);
      if (onSea) {
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.fillRect(sx - size * 0.5, sy + size * 0.34, size, size * 0.16);  // 影
        ctx.fillStyle = "#5a3d24";                                            // 船体
        ctx.fillRect(sx - size * 0.5, sy + size * 0.05, size, size * 0.32);
        ctx.fillStyle = cargo; ctx.fillRect(sx - size * 0.3, sy - size * 0.08, size * 0.6, size * 0.16); // 甲板の積荷
        ctx.fillStyle = "#3a2716"; ctx.fillRect(sx - size * 0.06, sy - size * 0.5, size * 0.12, size * 0.6); // マスト
        ctx.fillStyle = trade ? "#efe4c2" : "#e9dcc0";                        // 帆
        ctx.fillRect(sx - size * 0.34, sy - size * 0.42, size * 0.68, size * 0.4);
        return;
      }
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(sx - size * 0.5, sy + size * 0.32, size, size * 0.18); // 影
      // 荷を牽く役畜（進行方向の前に配置。交易が「運ばれている」ことが分かる）。
      const ox = sx + fs * size * 0.62;
      ctx.fillStyle = "#5a4028";
      ctx.fillRect(ox - size * 0.16, sy - size * 0.14, size * 0.32, size * 0.34); // 胴
      ctx.fillRect(ox + fs * size * 0.16, sy - size * 0.2, size * 0.16, size * 0.2); // 頭
      ctx.fillStyle = "#15100a";
      ctx.fillRect(ox - size * 0.12, sy + size * 0.2, size * 0.08, size * 0.16);
      ctx.fillRect(ox + size * 0.04, sy + size * 0.2, size * 0.08, size * 0.16); // 脚
      // 荷台（木枠）と積荷（財の色）。
      ctx.fillStyle = "#6b4a2a";
      ctx.fillRect(sx - size * 0.5, sy - size * 0.28, size * 0.9, size * 0.58);   // 荷台の枠
      ctx.fillStyle = cargo;
      ctx.fillRect(sx - size * 0.42, sy - size * 0.2, size * 0.74, size * 0.42);  // 積荷
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(sx - size * 0.42, sy - size * 0.2, size * 0.74, size * 0.1);   // 積荷のハイライト
      ctx.fillStyle = "#15100a"; // 車輪
      ctx.fillRect(sx - size * 0.4, sy + size * 0.28, size * 0.2, size * 0.2);
      ctx.fillRect(sx + size * 0.12, sy + size * 0.28, size * 0.2, size * 0.2);
    }
    // 交易される財の色パレット（二国が豊かに持つ財から積荷を決め、何が運ばれているか見せる）。
    function cargoPool(ka, kb) {
      const pool = [];
      for (let s = 0; s < 2; s++) {
        const kk = s === 0 ? ka : kb; if (!kk) continue;
        const r = kk.res || {};
        if ((kk.food || 0) > 20) pool.push("#e0c85a");   // 穀物（金色）
        if ((kk.tools || 0) > 8) pool.push("#b8c0c8");   // 鉄・道具（鋼色）
        if ((r.spice || 0) > 0) pool.push("#d8622a");    // 香辛料（橙）
        if ((r.gems || 0) > 0) pool.push("#46d6c8");     // 宝石（碧）
        if ((r.gold || 0) > 0) pool.push("#f3c433");     // 金（黄金）
        if ((r.salt || 0) > 0) pool.push("#eef2f6");     // 塩（白）
        if ((r.timber || 0) > 0) pool.push("#8a5a2e");   // 木材（茶）
        if ((r.horses || 0) > 0) pool.push("#9a6a3a");   // 馬・家畜（黄褐）
        if ((r.fish || 0) > 0) pool.push("#7ea8c0");     // 魚（水色）
        if ((kk.wealth || 0) > 40) pool.push("#6a5aa8"); // 奢侈品・織物（紫）
      }
      if (!pool.length) pool.push("#c9a86a"); // 一般の荷
      return pool;
    }
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id];
      if (!k || !k.alive || !k.cities || !k.cities.length) continue;
      const cap = k.cities[0];
      // 街道: 首都⇄各都市をゆっくり往復（自国の産物を運ぶ）。
      const localPool = cargoPool(k, null);
      for (let c = 1; c < k.cities.length; c++) {
        const city = k.cities[c];
        const frac = Math.sin(t * 0.35 + id * 1.3 + c * 2.1) * 0.5 + 0.5;
        wagon(cap.x, cap.y, city.x, city.y, frac, localPool[(id + c) % localPool.length], false);
      }
      // 交易路: 実際に交易のある首都間を隊商が往来（活発な路ほど多くの隊商）。積荷は両国の
      //   産物を表す色で、何が運ばれているか（穀物・鉄・香辛料・宝石・奢侈品…）が見て分かる。
      if (k.partners) {
        for (const bStr in k.partners) {
          const b = +bStr;
          if (b <= id) continue;
          const kb = ks[b];
          if (!kb || !kb.alive || !kb.cities || !kb.cities.length) continue;
          const vol = k.partners[b] || 0;
          if (vol < 0.5) continue;
          const cap2 = kb.cities[0];
          const pool = cargoPool(k, kb);
          // 交易量に応じて1〜5の隊商／船を時間差で走らせる（活発な路ほど賑わう）。
          const wagons = vol > 30 ? 5 : vol > 16 ? 4 : vol > 8 ? 3 : vol > 3 ? 2 : 1;
          for (let wagi = 0; wagi < wagons; wagi++) {
            const frac = (t * 0.06 + id * 0.7 + b * 0.37 + wagi / wagons) % 1;
            // 隊商ごとに違う財を積む（路に多彩な物流が行き交って見える）。
            wagon(cap.x, cap.y, cap2.x, cap2.y, frac, pool[(id + b + wagi) % pool.length], true);
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
    const H = world.height, road = world.road;
    // 時代で進化する道: 法典（土木を組織する社会）を得た国の領内は石畳の街道、それ以外は土の道。
    //   同じ一本道でも先進国の区間だけ石畳になり、道が文明の到達を物語る。
    const civ = Game.state.civ;
    const owner = world.owner;
    const stoneK = []; // kingdom id → 石畳か（フレーム内キャッシュ）
    function isStone(i) {
      const o = owner ? owner[i] : 0;
      if (!o) return false;
      if (stoneK[o] === undefined) {
        const k = civ && civ.kingdoms[o];
        stoneK[o] = !!(k && k.alive && k.techBits && k.techBits.law);
      }
      return stoneK[o];
    }
    const edgeDirt = "rgba(52,40,26,0.6)";      // 土道の路肩（暗い縁）
    const surfDirt = "rgba(198,174,124,0.9)";   // 土道の路面
    const edgeStone = "rgba(58,56,50,0.7)";     // 石畳の縁石
    const surfStone = "rgba(172,166,152,0.95)"; // 石畳の路面
    // 実際の道幅（タイルより細い帯）。隣接する街道タイルへ「スポーク」を伸ばして繋ぐことで、
    //   四角の羅列ではなく曲がり・十字路のある連続した一本道に見せる。
    const cw = Math.max(2, scale * 0.42);      // 路面の幅
    const ew = cw + Math.max(2, scale * 0.16); // 路肩込みの幅
    const reach = Math.ceil(scale * 0.5) + 1;  // 隣タイルへ伸ばす長さ（途切れ防止）
    const hasRoad = function (tx, ty) { return tx >= 0 && ty >= 0 && tx < W && ty < H && road && road[ty * W + tx]; };
    const isWater = Game.tile.isWater, terr = world.terrain;
    ctx.save();
    // 2層: まず暗い路肩（太）、次に明るい路面（細）。タイル中心を8方向の線分（丸端）で結んで
    //   描く＝斜めの区間は斜めの線になり、従来の「四角の階段」のカクカクが消える。
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (let pass = 0; pass < 2; pass++) {
      const wdt = pass === 0 ? ew : cw;
      ctx.lineWidth = wdt;
      for (let n = 0; n < list.length; n++) {
        const i = list[n];
        const tx = i % W, ty = (i / W) | 0;
        if (tx < x0 - 1 || tx > x1 + 1 || ty < y0 - 1 || ty > y1 + 1) continue;
        const stone = isStone(i);
        ctx.strokeStyle = pass === 0 ? (stone ? edgeStone : edgeDirt) : (stone ? surfStone : surfDirt);
        const cx = camera.worldToScreenX((tx + 0.5) * tile);
        const cy = camera.worldToScreenY((ty + 0.5) * tile);
        // 東・南・南東・南西の4方向だけ描けば、全タイルの走査で全結線が一度ずつ引かれる。
        let drawn = false;
        ctx.beginPath();
        if (hasRoad(tx + 1, ty)) { ctx.moveTo(cx, cy); ctx.lineTo(cx + scale, cy); drawn = true; }
        if (hasRoad(tx, ty + 1)) { ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + scale); drawn = true; }
        // 斜め: 直交の両隣で既に繋がる場合は省く（太り過ぎを防ぐ）。片側だけなら斜線で滑らかに。
        if (hasRoad(tx + 1, ty + 1) && !(hasRoad(tx + 1, ty) && hasRoad(tx, ty + 1))) {
          ctx.moveTo(cx, cy); ctx.lineTo(cx + scale, cy + scale); drawn = true;
        }
        if (hasRoad(tx - 1, ty + 1) && !(hasRoad(tx - 1, ty) && hasRoad(tx, ty + 1))) {
          ctx.moveTo(cx, cy); ctx.lineTo(cx - scale, cy + scale); drawn = true;
        }
        ctx.stroke();
        if (!drawn && !hasRoad(tx - 1, ty) && !hasRoad(tx, ty - 1) &&
            !hasRoad(tx - 1, ty - 1) && !hasRoad(tx + 1, ty - 1)) {
          // 孤立タイル（端点）: 丸い結節点を打つ。
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath(); ctx.arc(cx, cy, wdt * 0.5, 0, Math.PI * 2); ctx.fill();
        }
        // 木橋: 道が川・水路で途切れる所（1〜2タイルの水の切れ目の先に道が続く）には橋を渡す。
        //   街道が川を「渡っている」ことが見え、水辺が交通の要衝になる。
        if (pass === 1) {
          for (const [dx0, dy0] of [[1, 0], [0, 1]]) {
            for (let gap = 1; gap <= 2; gap++) {
              const bx2 = tx + dx0 * (gap + 1), by2 = ty + dy0 * (gap + 1);
              if (!hasRoad(bx2, by2)) continue;
              let allWater = true;
              for (let g = 1; g <= gap; g++) {
                const gi = (ty + dy0 * g) * W + (tx + dx0 * g);
                if (!isWater(terr[gi])) { allWater = false; break; }
              }
              if (!allWater) continue;
              // 橋板（濃い木の帯）と欄干（両側の細線）を水面に渡す。
              const bx = camera.worldToScreenX((tx + 0.5 + dx0 * 0.5) * tile);
              const by = camera.worldToScreenY((ty + 0.5 + dy0 * 0.5) * tile);
              const blen = scale * (gap + 1);
              const bw2 = cw * 0.92;
              ctx.fillStyle = "rgba(96,68,40,0.95)"; // 橋板
              if (dx0) {
                ctx.fillRect(bx | 0, (by - bw2 * 0.5) | 0, blen | 0, bw2 | 0);
                ctx.fillStyle = "rgba(60,42,26,0.9)"; // 欄干
                ctx.fillRect(bx | 0, (by - bw2 * 0.5) | 0, blen | 0, Math.max(1, bw2 * 0.18) | 0);
                ctx.fillRect(bx | 0, (by + bw2 * 0.5 - Math.max(1, bw2 * 0.18)) | 0, blen | 0, Math.max(1, bw2 * 0.18) | 0);
              } else {
                ctx.fillRect((bx - bw2 * 0.5) | 0, by | 0, bw2 | 0, blen | 0);
                ctx.fillStyle = "rgba(60,42,26,0.9)";
                ctx.fillRect((bx - bw2 * 0.5) | 0, by | 0, Math.max(1, bw2 * 0.18) | 0, blen | 0);
                ctx.fillRect((bx + bw2 * 0.5 - Math.max(1, bw2 * 0.18)) | 0, by | 0, Math.max(1, bw2 * 0.18) | 0, blen | 0);
              }
              break; // この向きの橋は一本で十分
            }
          }
        }
      }
    }
    // 石畳の目地: 石の街道は近景で敷石の継ぎ目が見える（濃い横線を等間隔に刻む）。
    if (scale >= 7) {
      ctx.fillStyle = "rgba(120,114,102,0.5)";
      const jw = Math.max(1, (cw * 0.1) | 0);
      for (let n = 0; n < list.length; n++) {
        const i = list[n];
        const tx = i % W, ty = (i / W) | 0;
        if (tx < x0 || tx > x1 || ty < y0 || ty > y1 || !isStone(i)) continue;
        const cx = camera.worldToScreenX((tx + 0.5) * tile) | 0;
        const cy = camera.worldToScreenY((ty + 0.5) * tile) | 0;
        const horiz = hasRoad(tx + 1, ty) || hasRoad(tx - 1, ty);
        if (horiz) { // 東西の道: 縦の目地を2本
          ctx.fillRect((cx - scale * 0.25) | 0, (cy - cw * 0.5) | 0, jw, cw | 0);
          ctx.fillRect((cx + scale * 0.25) | 0, (cy - cw * 0.5) | 0, jw, cw | 0);
        } else { // 南北の道: 横の目地を2本
          ctx.fillRect((cx - cw * 0.5) | 0, (cy - scale * 0.25) | 0, cw | 0, jw);
          ctx.fillRect((cx - cw * 0.5) | 0, (cy + scale * 0.25) | 0, cw | 0, jw);
        }
      }
    }
    // 轍(わだち): 荷車が刻んだ2本の平行な溝を、道の走る向きに沿って刻む（近景のみ）。
    if (scale >= 6) {
      const rw = Math.max(1, (cw * 0.14) | 0);       // 溝の太さ
      const gap = Math.max(1, (cw * 0.28) | 0);      // 2本の間隔（中心からのオフセット）
      ctx.fillStyle = "rgba(120,98,64,0.55)";
      for (let n = 0; n < list.length; n++) {
        const i = list[n];
        const tx = i % W, ty = (i / W) | 0;
        if (tx < x0 || tx > x1 || ty < y0 || ty > y1) continue;
        if (isStone(i)) continue; // 轍は土の道だけに刻まれる（石畳は目地で表現）
        const cx = camera.worldToScreenX((tx + 0.5) * tile) | 0;
        const cy = camera.worldToScreenY((ty + 0.5) * tile) | 0;
        const horiz = hasRoad(tx + 1, ty) || hasRoad(tx - 1, ty);
        const vert = hasRoad(tx, ty + 1) || hasRoad(tx, ty - 1);
        if (horiz) { // 東西の轍（横向き）
          ctx.fillRect(cx - reach, cy - gap, reach * 2, rw);
          ctx.fillRect(cx - reach, cy + gap - rw, reach * 2, rw);
        }
        if (vert && !horiz) { // 南北の轍（縦向き。交差点では横を優先して二重描画を避ける）
          ctx.fillRect(cx - gap, cy - reach, rw, reach * 2);
          ctx.fillRect(cx + gap - rw, cy - reach, rw, reach * 2);
        }
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
          if ((bd.t !== 5 && bd.t !== 9) || bd.site) continue; // FARM=5 / GRANARY=9 の周りを耕地に（建設中はまだ耕されない）
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

  // 水面のきらめき: 可視範囲の水タイルに、位相をずらした淡い波筋を加算で重ねて揺らす。
  //   穏やかに寄せては返す光で、静的な海・湖・川が生きて見える。近景のみ・上限つきで軽量。
  Renderer.prototype.drawWater = function (camera) {
    if (Game.config.settings && Game.config.settings.water === false) return;
    const world = this.world;
    const tile = Game.config.tilePx, scale = tile * camera.zoom;
    if (scale < 4) return; // 近景のみ（負荷と見栄えの両立。引きの海はベタ塗りで十分）
    const ctx = this.ctx, W = world.width, terr = world.terrain, isWater = Game.tile.isWater;
    const range = camera.visibleTileRange();
    // visibleTileRange の x1/y1 は W/H まで（排他上限）に丸められるため、末端でのタイル参照は W-1/H-1 に留める。
    const xb = Math.min(range.x1, W - 1), yb = Math.min(range.y1, world.height - 1);
    const t = this._t;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    let drawn = 0; const CAP = 8000;
    for (let ty = range.y0; ty <= yb && drawn < CAP; ty++) {
      const sy0 = camera.worldToScreenY(ty * tile);
      for (let tx = range.x0; tx <= xb; tx++) {
        if (!isWater(terr[ty * W + tx])) continue;
        const sx = camera.worldToScreenX(tx * tile);
        // タイルごとに位相をずらした2筋のさざ波（寄せては返す）。
        const ph = t * 1.2 + tx * 0.6 + ty * 0.45;
        const a = 0.04 + 0.06 * (Math.sin(ph) * 0.5 + 0.5);
        const yo = (Math.sin(ph) * 0.5 + 0.5) * scale * 0.55;
        ctx.fillStyle = "rgba(150,205,238," + a.toFixed(3) + ")";
        ctx.fillRect(sx, sy0 + yo, scale, Math.max(1, scale * 0.1));
        const yo2 = (Math.sin(ph + 2.1) * 0.5 + 0.5) * scale * 0.7;
        ctx.fillStyle = "rgba(190,225,245," + (a * 0.7).toFixed(3) + ")";
        ctx.fillRect(sx + scale * 0.3, sy0 + yo2, scale * 0.5, Math.max(1, scale * 0.08));
        // 陽光のきらめき: 水面のあちこちで反射がまたたく（点在してチカチカと輝く）。
        const spk = Math.sin(t * 2.6 + tx * 1.7 + ty * 2.3);
        if (spk > 0.9) {
          const gs = Math.max(1, scale * 0.16) | 0;
          const gx = (sx + scale * (0.3 + 0.4 * ((tx * 7 + ty * 3) % 5) / 5)) | 0;
          const gy = (sy0 + scale * (0.2 + 0.5 * ((tx * 3 + ty * 5) % 5) / 5)) | 0;
          ctx.fillStyle = "rgba(245,252,255," + ((spk - 0.9) * 6).toFixed(2) + ")";
          ctx.fillRect(gx, gy, gs, gs);
        }
        if (++drawn >= CAP) break;
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
    const xb = Math.min(range.x1, W - 1), yb = Math.min(range.y1, world.height - 1); // 末端で範囲外参照を避ける
    // 木は人の背丈を超える高さに（人・建物との対比を現実的に保つ）。
    const u = Math.max(1, scale * 0.2);
    const tt0 = this._t;
    // 風: ゆるやかに強弱する突風（全体の風速）。木ごとに位相をずらして波打つように揺れる。
    const gust = 0.7 + 0.3 * Math.sin(tt0 * 0.5);
    const detail = scale >= 9; // 十分近ければ落ち葉・梢の細部まで
    let drawn = 0; const CAP = 3600;
    for (let ty = range.y0; ty <= yb && drawn < CAP; ty++) {
      for (let tx = range.x0; tx <= xb; tx++) {
        const i = ty * W + tx, tt = terr[i];
        if (tt !== T.FOREST && tt !== T.JUNGLE) continue;
        const hsh = (i * 2654435761) >>> 0;
        const jx = ((hsh % 256) / 256 - 0.5) * scale * 0.45;
        const jy = (((hsh >> 8) % 256) / 256 - 0.5) * scale * 0.35;
        const cx = camera.worldToScreenX((tx + 0.5) * tile) + jx;
        const cy = camera.worldToScreenY((ty + 0.92) * tile) + jy;
        const jungle = tt === T.JUNGLE;
        const sz = u * (jungle ? 1.5 : 1.2) * (0.82 + ((hsh >> 16) % 100) / 100 * 0.4);
        // 木ごとに位相と揺れ幅が異なる（風が林を渡っていくように梢がうねる）。
        const ph = tt0 * 1.7 + (hsh % 360) * 0.0175 + tx * 0.35;
        const sway = Math.sin(ph) * scale * 0.055 * gust * (jungle ? 1.25 : 1);
        ctx.fillStyle = "rgba(0,0,0,0.16)"; ctx.fillRect((cx - sz * 0.6) | 0, cy | 0, (sz * 1.2) | 0, Math.max(1, sz * 0.3) | 0); // 影
        // 幹も梢の揺れにつれて根元からわずかにしなる。
        ctx.fillStyle = "#5a3f24"; ctx.fillRect((cx - sz * 0.16 + sway * 0.3) | 0, (cy - sz * 1.05) | 0, Math.max(1, sz * 0.34) | 0, (sz * 1.05) | 0); // 幹
        const topx = cx + sway;
        ctx.fillStyle = jungle ? "#2f6b34" : "#3f7e3c"; // 梢（風で揺れる）
        ctx.fillRect((topx - sz * 0.9) | 0, (cy - sz * 2.0) | 0, (sz * 1.8) | 0, (sz * 1.1) | 0);
        ctx.fillRect((topx - sz * 0.6) | 0, (cy - sz * 2.5) | 0, (sz * 1.2) | 0, (sz * 0.7) | 0);
        // 陽の当たる面（そよぐたびに木漏れ日がちらつく）。
        const shimmer = 0.5 + 0.5 * Math.sin(ph * 1.3 + 1.2);
        ctx.fillStyle = jungle
          ? (shimmer > 0.6 ? "#4a976f" : "#3f8746")
          : (shimmer > 0.6 ? "#6cb85e" : "#56a04e");
        ctx.fillRect((topx - sz * 0.5) | 0, (cy - sz * 2.35) | 0, (sz * 0.75) | 0, (sz * 0.55) | 0);
        // 落ち葉: 強い風の折り、時おり一葉が舞い落ちる（木ごとにまれ・接写のみ）。
        if (detail && ((hsh >> 20) & 7) === 0) {
          const lf = (tt0 * 0.4 + (hsh % 100) * 0.06) % 1;
          const lx = topx + Math.sin(lf * 6.28 + i) * sz * 1.4;
          const ly = cy - sz * 2.0 + lf * sz * 2.6;
          ctx.fillStyle = jungle ? "rgba(180,150,70,0.7)" : "rgba(200,140,60,0.75)";
          ctx.fillRect(lx | 0, ly | 0, Math.max(1, sz * 0.22) | 0, Math.max(1, sz * 0.22) | 0);
        }
        if (++drawn >= CAP) break;
      }
    }
  };

  // 地表の質感: 近景で平坦なタイル塗りに、地形ごとの微細なドット絵を重ねる。
  //   草地は葉のそよぎ、砂・砂漠は砂粒と風紋、丘・山は岩肌、雪・ツンドラは粒立ち、
  //   湿地は淀みと葦、焼け地は炭と残り火。位置はタイル index のハッシュで決定的（チラつかない）。
  //   近景のみ・可視範囲のみ・上限つきで負荷を抑える。設定でオフにできる。
  Renderer.prototype.drawTerrainDetail = function (camera) {
    if (Game.config.settings && Game.config.settings.terrainDetail === false) return;
    const world = this.world;
    const tile = Game.config.tilePx, scale = tile * camera.zoom;
    if (scale < 5) return; // 近景のみ（引きの地形はベタ塗り＋陰影で十分）
    const ctx = this.ctx, W = world.width, terr = world.terrain, T = Game.TERRAIN;
    const range = camera.visibleTileRange();
    const xb = Math.min(range.x1, W - 1), yb = Math.min(range.y1, world.height - 1); // 末端で範囲外参照を避ける
    const sz = Math.ceil(scale);
    const u = Math.max(1, (scale * 0.12) | 0);       // 粒の基本サイズ
    const u2 = Math.max(1, (u * 0.7) | 0);           // 細かい粒
    const bend = (Math.sin(this._t * 1.6) * u * 0.7) | 0; // 草のそよぎ（風）
    let drawn = 0; const CAP = 16000;
    ctx.save();
    for (let ty = range.y0; ty <= yb && drawn < CAP; ty++) {
      const syT = camera.worldToScreenY(ty * tile) | 0;
      for (let tx = range.x0; tx <= xb; tx++) {
        const i = ty * W + tx, tt = terr[i];
        // 森・密林・水は専用描画（drawTrees/drawWater）や陰影に任せてスキップ。
        if (tt === T.FOREST || tt === T.JUNGLE || tt === T.DEEP_WATER || tt === T.SHALLOW_WATER) continue;
        const sx = camera.worldToScreenX(tx * tile) | 0;
        // タイル index から2組のドット位置を決定的に散らす（毎フレーム同じ＝チラつかない）。
        const h = (i * 2654435761) >>> 0;
        const px = (sx + ((h & 255) / 256) * (sz - u)) | 0;
        const py = (syT + (((h >> 8) & 255) / 256) * (sz - u)) | 0;
        const px2 = (sx + (((h >> 4) & 255) / 256) * (sz - u)) | 0;
        const py2 = (syT + (((h >> 12) & 255) / 256) * (sz - u)) | 0;
        switch (tt) {
          case T.GRASS: case T.SAVANNA: {
            // 草の葉: 細い縦筋を明暗2本、風でわずかに穂先が傾く。
            const savanna = tt === T.SAVANNA;
            ctx.fillStyle = savanna ? "rgba(150,140,70,0.5)" : "rgba(58,118,48,0.5)";
            ctx.fillRect(px, py, u2, u * 2);
            ctx.fillStyle = savanna ? "rgba(206,194,112,0.5)" : "rgba(122,192,92,0.5)";
            ctx.fillRect(px2 + bend, py2 - u, u2, u * 2);
            break;
          }
          case T.SAND: case T.DESERT: {
            // 砂粒（明るい粒＋暗い粒）と、横に流れる風紋。
            ctx.fillStyle = "rgba(255,246,206,0.35)"; ctx.fillRect(px, py, u2, u2);
            ctx.fillStyle = "rgba(150,128,78,0.3)"; ctx.fillRect(px2, py2, u2, u2);
            ctx.fillStyle = "rgba(192,170,110,0.22)";
            ctx.fillRect(sx, (syT + (((h >> 16) & 255) / 256) * (sz - u)) | 0, sz, Math.max(1, (u * 0.4) | 0));
            break;
          }
          case T.HILL: case T.MOUNTAIN: {
            // 岩肌: 暗い割れ目と明るい稜線の欠片（角ばった質感）。
            ctx.fillStyle = "rgba(38,36,32,0.4)"; ctx.fillRect(px, py, u, u);
            ctx.fillStyle = "rgba(204,200,190,0.28)"; ctx.fillRect(px2, py2, u2, u2);
            break;
          }
          case T.SNOW: case T.TUNDRA: {
            // 雪原の粒立ち: 白い煌めきと、わずかに青い陰の粒。
            ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.fillRect(px, py, u2, u2);
            ctx.fillStyle = "rgba(150,180,212,0.32)"; ctx.fillRect(px2, py2, u2, Math.max(1, (u2 * 0.8) | 0));
            break;
          }
          case T.SWAMP: {
            // 淀み: 暗い水溜まりの斑と、立ち上がる葦。
            ctx.fillStyle = "rgba(28,44,24,0.42)"; ctx.fillRect(px, py, u * 2, u);
            ctx.fillStyle = "rgba(96,124,72,0.42)"; ctx.fillRect(px2 + bend, py2 - u, u2, u * 2);
            break;
          }
          case T.SCORCHED: {
            // 焼け地: 炭の黒い粒と、くすぶる残り火。
            ctx.fillStyle = "rgba(10,8,6,0.5)"; ctx.fillRect(px, py, u, u);
            ctx.fillStyle = "rgba(206,92,30,0.3)"; ctx.fillRect(px2, py2, u2, u2);
            break;
          }
          default: continue; // 質感を持たない地形は描かない
        }
        if (++drawn >= CAP) break;
      }
    }
    ctx.restore();
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

  // 飛翔体: 実際の遠戦で放たれた矢(arrow)・銃弾(shot)の飛跡を、射手から標的へ短く描く
  //   （戦闘という行為そのもの。装飾ではなく実際の射撃の弾道）。
  Renderer.prototype.drawBattleFx = function (camera) {
    const fx = Game.state.battleFx;
    if (!fx || !fx.length) return;
    const tile = Game.config.tilePx, scale = tile * camera.zoom;
    const ctx = this.ctx, range = camera.visibleTileRange();
    const sc = (wx) => camera.worldToScreenX((wx + 0.5) * tile);
    const scy = (wy) => camera.worldToScreenY((wy + 0.5) * tile);
    for (let n = fx.length - 1; n >= 0; n--) {
      const f = fx[n];
      f.age++;
      const life = f.t === "shot" ? 10 : f.t === "clash" ? 9 : 12;
      if (f.age > life) { fx.splice(n, 1); continue; }
      if (scale < 2.5) continue;
      if (f.x < range.x0 - 2 || f.x > range.x1 + 2 || f.y < range.y0 - 2 || f.y > range.y1 + 2) continue;
      const pr = f.age / life;
      // 剣戟の火花: 白兵の打ち合いの瞬間、火花が散り土埃が舞う（戦闘が起きている場所が分かる）。
      if (f.t === "clash") {
        const cx0 = sc(f.x), cy0 = scy(f.y);
        const rr = Math.max(2, scale * 0.34) * (0.5 + pr);
        ctx.strokeStyle = "rgba(255,236,150," + (0.95 * (1 - pr)).toFixed(2) + ")";
        ctx.lineWidth = Math.max(1, scale * 0.06);
        ctx.beginPath();
        for (let s = 0; s < 4; s++) {
          const a = s * 1.5708 + 0.6 + (f.x2 || 0); // 向きは対象位置で散らす
          ctx.moveTo(cx0 + Math.cos(a) * rr * 0.3, cy0 + Math.sin(a) * rr * 0.3);
          ctx.lineTo(cx0 + Math.cos(a) * rr, cy0 + Math.sin(a) * rr);
        }
        ctx.stroke();
        // 足元の土埃。
        ctx.fillStyle = "rgba(150,132,104," + (0.3 * (1 - pr)).toFixed(2) + ")";
        const du = Math.max(1, scale * 0.22 * (0.4 + pr));
        ctx.fillRect((cx0 - du) | 0, (cy0 + scale * 0.1) | 0, (du * 2) | 0, Math.max(1, du * 0.5) | 0);
        continue;
      }
      const x = f.x + (f.x2 - f.x) * pr, y = f.y + (f.y2 - f.y) * pr;
      const sx = sc(x), sy = scy(y), u = Math.max(1, scale * (f.t === "shot" ? 0.13 : 0.1));
      if (f.t === "shot" && pr < 0.3) { ctx.fillStyle = "rgba(255,220,120,0.9)"; ctx.fillRect((sc(f.x) - u) | 0, (scy(f.y) - u) | 0, 2 * u, 2 * u); } // 銃口炎
      ctx.fillStyle = f.t === "shot" ? "#f4f4f4" : "#e8dcb0";
      ctx.fillRect((sx - u * 0.5) | 0, (sy - u * 0.5) | 0, Math.max(1, u * (f.t === "shot" ? 1 : 1.6)) | 0, Math.max(1, u * 0.6) | 0);
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
    const t = this._t;
    ctx.save();
    ctx.lineCap = "round";
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
        // 交易量で線の濃さ・太さを変える（活発な通商路ほど太く明るい）。ゆるやかな明滅で活気を添える。
        const a = Math.min(0.7, 0.2 + vol * 0.04) * (0.82 + 0.18 * Math.sin(t * 2 + id + b));
        ctx.strokeStyle = "rgba(240,200,90," + a.toFixed(2) + ")";
        ctx.lineWidth = Math.max(1, scale * (0.08 + Math.min(0.16, vol * 0.012)));
        // 破線を c0→c1 の向きへ流す（財が実際に流れているように見える。活発な路ほど速い）。
        ctx.lineDashOffset = -t * (0.7 + Math.min(3, vol * 0.09)) * scale;
        ctx.beginPath();
        ctx.moveTo(camera.worldToScreenX((c0.x + 0.5) * tile), camera.worldToScreenY((c0.y + 0.5) * tile));
        ctx.lineTo(camera.worldToScreenX((c1.x + 0.5) * tile), camera.worldToScreenY((c1.y + 0.5) * tile));
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
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
      const label = k.realmName || k.name; // 国号（政治が定める呼び名）を地図に示す
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.strokeText(label, sx, sy);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, sx, sy);
    }
    ctx.restore();
  };

  // 国情勢バッジ: 各国の首都の上に、いま起きている顕著な状態を色付きの絵文字バッジで示す。
  //   ⚔戦争 / 🌾飢饉 / 🦠疫病 / ✊反乱(高不満) / ✨黄金時代 / 🌑暗黒時代。地図を見るだけで
  //   「どこで何が起きているか」が分かる（クリックして調べなくても世界の情勢が一望できる）。
  //   色付き背景で状態を二重符号化し、絵文字が単色描画の環境でも状態が伝わる。
  Renderer.prototype.drawStatusBadges = function (camera) {
    if (Game.config.settings && Game.config.settings.statusBadges === false) return;
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 2.2) return; // 引きすぎでは省略
    const range = camera.visibleTileRange();
    const ctx = this.ctx;
    const kingdoms = civ.kingdoms;
    const sz = Math.max(12, Math.min(24, scale * 1.5)); // バッジの一辺
    const gap = Math.max(1, sz * 0.12);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = (sz * 0.66).toFixed(0) + "px 'Noto Color Emoji','Apple Color Emoji','Segoe UI Emoji',sans-serif";
    for (let id = 1; id < kingdoms.length; id++) {
      const k = kingdoms[id];
      if (!k || !k.alive || !k.cities || !k.cities.length) continue;
      const cap = k.cities[0];
      if (cap.x < range.x0 - 2 || cap.x > range.x1 + 2 || cap.y < range.y0 - 2 || cap.y > range.y1 + 2) continue;
      // 優先度順に状態グリフを集める（最大4つ）。[絵文字, 背景色]。
      const badges = [];
      let atWar = false;
      if (k.wars) { for (const w in k.wars) { atWar = true; break; } }
      if (atWar) badges.push(["⚔", "rgba(200,50,45,0.92)"]);
      if (k.famine) badges.push(["🌾", "rgba(196,132,40,0.92)"]);
      if (k.plague > 0) badges.push(["🦠", "rgba(120,60,168,0.92)"]);
      if ((k.unrest || 0) > 70) badges.push(["✊", "rgba(214,170,40,0.92)"]);
      if (k.goldenAge) badges.push(["✨", "rgba(196,150,40,0.92)"]);
      else if (k.darkAge) badges.push(["🌑", "rgba(40,44,70,0.92)"]);
      if (!badges.length) continue;
      if (badges.length > 4) badges.length = 4;
      const sx = camera.worldToScreenX((cap.x + 0.5) * tile);
      // ラベルより更に上の帯に、中央揃えで横並び。
      const by = camera.worldToScreenY((cap.y + 0.5) * tile) - Math.max(6, scale * 0.9) - sz * 1.55;
      const totalW = badges.length * sz + (badges.length - 1) * gap;
      let bx = sx - totalW * 0.5;
      const rad = Math.max(2, sz * 0.22);
      for (let b = 0; b < badges.length; b++) {
        const cx = bx + sz * 0.5;
        // 角丸の色付き背景（状態を色で二重符号化）。
        ctx.fillStyle = badges[b][1];
        this._roundRect(ctx, bx, by, sz, sz, rad);
        ctx.fill();
        // 縁取りで地図から浮かせる。
        ctx.lineWidth = Math.max(1, sz * 0.06);
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        this._roundRect(ctx, bx, by, sz, sz, rad);
        ctx.stroke();
        // 絵文字（色絵文字非対応環境でも背景色で状態が伝わる）。
        ctx.fillStyle = "#fff";
        ctx.fillText(badges[b][0], cx, by + sz * 0.56);
        bx += sz + gap;
      }
    }
    ctx.restore();
  };

  // 角丸矩形のパスを引く（塗り/線は呼び出し側）。
  Renderer.prototype._roundRect = function (ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
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
    const t = this._t; // 煙・旗のなびきなどのアニメ用
    // 夜の度合い（酒場の灯・窓明かりを夜ほど暖かく強める）。
    const nightAmt = (Game.lighting && Game.state.clock && !(Game.config.settings && Game.config.settings.dayNight === false))
      ? Game.lighting(Game.state.clock).darkness : 0;

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

        // 攻囲中の都市: 実際の攻囲度に応じた赤い包囲環で「攻められている」状態を示す（状態表示）。
        if (city.siege > 0.12) {
          const sg = Math.min(1, city.siege);
          const rr = Math.max(4, scale * (1.4 + level * 0.25));
          ctx.strokeStyle = "rgba(232,70,60," + (0.3 + 0.4 * sg).toFixed(2) + ")";
          ctx.lineWidth = Math.max(1.5, scale * 0.16);
          ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke();
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
          // 建物は人物よりはるかに大きく（家で約2タイル幅・人の背丈の約4倍を基準に、種別で増減）。
          //   城砦・神殿・記念碑はさらに大きく、人が構造物を見上げる現実的な対比になる。
          const size = Math.max(12, scale * 2.0);
          for (let bi = 0; bi < bs.length; bi++) {
            const bd = bs[bi];
            // 段階(lvl)で建物は大きく育ち、状態(cond)が悪いと荒れて見える（街並みに盛衰が出る）。
            const lvl = bd.lvl || 1;
            const cond = bd.cond == null ? 1 : bd.cond;
            // 荒廃の黒ずみはスプライトに焼き込んだ変種で描く（建物の形の内側だけが黒ずみ、はみ出さない）。
            const wornB = cond < 0.78 ? Math.min(3, 1 + ((0.78 - cond) * 4) | 0) : 0;
            const img = wornB && !bd.site ? sprites.buildingWorn(bd.t, wornB) : sprites.building(bd.t);
            // 種別ごとの相対サイズ: 小屋は小さく、邸宅・砦・神殿・記念碑は大きく。育った建物は一回り大きい。
            const bw = size * (BUILD_SIZE[bd.t] || 1) * (1 + (lvl - 1) * 0.18);
            const bh = bw * (img.height / img.width);
            const bx = camera.worldToScreenX((bd.x + 0.5) * tile);
            const by = camera.worldToScreenY((bd.y + 0.5) * tile);
            // 建設現場: 躯体が工事の進みに応じて下から立ち上がり、木の足場が組まれている。
            //   完成した建物とはひと目で違い、街が「建てられていく」様が見える。
            if (bd.site) {
              const frac = Math.max(0.12, Math.min(1, (bd.prog || 0) / (bd.need || 1)));
              const ph = bh * frac;
              // 接地影（小さめ）。
              ctx.fillStyle = "rgba(0,0,0,0.2)";
              ctx.beginPath();
              ctx.ellipse(bx, by - bh * 0.06, bw * 0.4, bw * 0.14, 0, 0, Math.PI * 2);
              ctx.fill();
              // 立ち上がる躯体（スプライトの下部 frac 分だけを描く＝建ちかけ）。
              ctx.globalAlpha = 0.92;
              ctx.drawImage(img, 0, img.height * (1 - frac), img.width, Math.max(1, img.height * frac),
                (bx - bw * 0.5) | 0, (by - ph) | 0, bw | 0, Math.max(1, ph | 0));
              ctx.globalAlpha = 1;
              if (scale >= 3) {
                // 木の足場: 両脇の支柱と横桟（工事の印）。
                ctx.strokeStyle = "rgba(146,110,62,0.95)";
                ctx.lineWidth = Math.max(1, scale * 0.07);
                const lx = (bx - bw * 0.56) | 0, rx = (bx + bw * 0.56) | 0, top = by - bh * 1.04;
                ctx.beginPath();
                ctx.moveTo(lx, by); ctx.lineTo(lx, top);
                ctx.moveTo(rx, by); ctx.lineTo(rx, top);
                for (let s = 1; s <= 2; s++) { const yy = (by - bh * 0.34 * s) | 0; ctx.moveTo(lx, yy); ctx.lineTo(rx, yy); }
                ctx.stroke();
                // 資材（積まれた木材）を足元に。
                ctx.fillStyle = "rgba(160,124,72,0.9)";
                ctx.fillRect((bx + bw * 0.3) | 0, (by - Math.max(1, scale * 0.16)) | 0, (bw * 0.3) | 0 || 1, Math.max(1, scale * 0.16) | 0);
              }
              continue;
            }
            // 接地影（建物の足元に落として街に立体感を出す）。
            ctx.fillStyle = "rgba(0,0,0,0.26)";
            ctx.beginPath();
            ctx.ellipse(bx, by - bh * 0.06, bw * 0.44, bw * 0.16, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.drawImage(img, (bx - bw * 0.5) | 0, (by - bh) | 0, bw | 0, bh | 0);
            // 竈の煙: 鍛冶場(6)・酒場(14)・住居(0..2)の炉から煙が立ちのぼり、街に営みの気配を添える。
            //   損なわれた建物（cond低）は火が消え煙も細る。近景のみ・各棟2筋で軽量。
            if (scale >= 5 && cond > 0.3 && (bd.t === 6 || bd.t === 14 || bd.t <= 2)) {
              const strong = (bd.t === 6 || bd.t === 14); // 工房・酒場は濃い煙
              const cx0 = bx + bw * (bd.t === 6 ? 0.18 : 0.1);
              for (let s = 0; s < 2; s++) {
                const ph = (t * (strong ? 0.5 : 0.34) + bi * 0.7 + s * 0.5) % 1;
                const ry = by - bh - ph * bh * (strong ? 1.0 : 0.7);
                const drift = Math.sin(t * 1.1 + bi + s * 2) * bw * 0.12;
                const rr = Math.max(1, bw * (0.1 + ph * 0.16));
                ctx.fillStyle = "rgba(150,148,150," + ((strong ? 0.32 : 0.2) * (1 - ph) * cond).toFixed(3) + ")";
                ctx.fillRect((cx0 + drift - rr) | 0, (ry - rr) | 0, (rr * 2) | 0 || 1, (rr * 2) | 0 || 1);
              }
            }
            // 荒廃の表現: 黒ずみはスプライト変種（buildingWorn）で焼き込み済み。
            //   ひどく荒れた建物にだけ亀裂を描き足す（建物の内側に収める）。
            if (cond < 0.78) {
              if (cond < 0.4 && scale >= 4) {
                ctx.strokeStyle = "rgba(30,24,20,0.6)";
                ctx.lineWidth = Math.max(1, scale * 0.06);
                ctx.beginPath();
                ctx.moveTo((bx - bw * 0.14) | 0, (by - bh * 0.72) | 0);
                ctx.lineTo((bx + bw * 0.08) | 0, (by - bh * 0.35) | 0);
                ctx.lineTo((bx - bw * 0.02) | 0, (by - bh * 0.08) | 0);
                ctx.stroke();
              }
            } else if (lvl >= 3 && scale >= 5 && (bd.t === 4 || bd.t === 7 || bd.t === 11 || bd.t === 12)) {
              // 最高段階の公共建築（神殿・市・記念碑・学院）には風になびく小旗を立て、発展を示す。
              //   旗は根元から旗先へ波が伝わるように、細切りにして翻らせる（布のうねり）。
              const fs = Math.max(1.5, scale * 0.22);
              const poleX = (bx - fs * 0.1) | 0, poleTop = (by - bh - fs * 2) | 0;
              ctx.fillStyle = "#6b4a2a"; ctx.fillRect(poleX, poleTop, Math.max(1, fs * 0.3) | 0, (fs * 2) | 0); // 旗竿
              const fcol = "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")";
              const fx1 = bx + fs * 0.2, segw = fs / 3;
              for (let fsg = 0; fsg < 3; fsg++) {
                const wv = Math.round(Math.sin(t * 4 + bi + fsg * 0.9) * fs * 0.34 * (0.4 + 0.3 * fsg)); // 旗先ほど大きくうねる
                ctx.fillStyle = fcol;
                ctx.fillRect((fx1 + fsg * segw) | 0, (poleTop + wv) | 0, Math.max(1, segw + 1) | 0, (fs * 0.7) | 0);
              }
            }
            // 生きた建物: 炉の火・作物のそよぎ・記念碑の輝き・灯のまたたきを添え、街が「営んでいる」様を描く。
            if (scale >= 5 && cond > 0.35) {
              if (bd.t === 6) {
                // 鍛冶場: 炉の火が明滅し、火花が舞い上がる（鍛造の営み）。
                const flick = 0.55 + 0.45 * Math.sin(t * 9 + bi * 2.3) * Math.sin(t * 13 + bi);
                const fgx = bx, fgy = by - bh * 0.42;
                ctx.save(); ctx.globalCompositeOperation = "lighter";
                const g = ctx.createRadialGradient(fgx, fgy, 0, fgx, fgy, bw * 0.42);
                g.addColorStop(0, "rgba(255,150,40," + (0.5 * flick).toFixed(3) + ")");
                g.addColorStop(1, "rgba(255,120,20,0)");
                ctx.fillStyle = g; ctx.beginPath(); ctx.arc(fgx, fgy, bw * 0.42, 0, Math.PI * 2); ctx.fill();
                for (let s = 0; s < 2; s++) {
                  const sp = (t * 1.6 + bi + s * 0.5) % 1;
                  const spx = (fgx + Math.sin(t * 6 + s * 3 + bi) * bw * 0.14) | 0;
                  const spy = (fgy - sp * bh * 0.55) | 0;
                  const ss = Math.max(1, bw * 0.06) | 0;
                  ctx.fillStyle = "rgba(255," + ((190 - sp * 130) | 0) + ",60," + ((1 - sp) * 0.9).toFixed(2) + ")";
                  ctx.fillRect(spx, spy, ss, ss);
                }
                ctx.restore();
              } else if (bd.t === 5) {
                // 農場: 手前の畝の作物が風にそよぐ（実りの営み）。
                const cy0 = by - bh * 0.06;
                ctx.lineWidth = Math.max(1, bw * 0.05);
                for (let cbl = 0; cbl < 5; cbl++) {
                  const bxp = bx - bw * 0.4 + cbl * bw * 0.2;
                  const bend = Math.sin(t * 2.2 + cbl * 0.9 + bi) * bw * 0.09;
                  ctx.strokeStyle = cbl % 2 ? "#7fae4a" : "#9ac85e";
                  ctx.beginPath(); ctx.moveTo(bxp, cy0); ctx.lineTo(bxp + bend, cy0 - bh * 0.22); ctx.stroke();
                }
              } else if (bd.t === 11) {
                // 大記念碑: 黄金が陽に輝き、頂に光がまたたく（国の誇り）。
                const gl = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 2 + bi));
                ctx.save(); ctx.globalCompositeOperation = "lighter";
                ctx.fillStyle = "rgba(255,230,140," + (0.22 * gl).toFixed(3) + ")";
                ctx.fillRect((bx - bw * 0.18) | 0, (by - bh) | 0, (bw * 0.36) | 0, bh | 0);
                const tw = 0.5 + 0.5 * Math.sin(t * 5 + bi);
                const ts = Math.max(1, bw * 0.12) | 0;
                ctx.fillStyle = "rgba(255,248,205," + tw.toFixed(2) + ")";
                ctx.fillRect((bx - ts * 0.5) | 0, (by - bh - ts) | 0, ts, ts);
                ctx.restore();
              } else if (bd.t === 14) {
                // 酒場: 灯窓が蝋燭のようにまたたく（夜ほど暖かい憩いの灯）。
                const flick = 0.6 + 0.4 * Math.sin(t * 7 + bi * 1.7) * Math.sin(t * 11 + bi);
                ctx.save(); ctx.globalCompositeOperation = "lighter";
                ctx.fillStyle = "rgba(255,190,90," + ((0.16 + 0.28 * nightAmt) * flick).toFixed(3) + ")";
                ctx.fillRect((bx - bw * 0.34) | 0, (by - bh * 0.62) | 0, (bw * 0.68) | 0, (bh * 0.34) | 0);
                ctx.restore();
              }
            }
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
          // 国旗（砦の上）: 布が根元から旗先へうねって翻る。旗竿に翻る旗で首都が一目で分かる。
          //   砦が高くそびえるようになったため、旗もその頂に合わせて高く掲げる。
          const fs = Math.max(2, scale * 0.5);
          const fy = sy - (detailed ? Math.max(14, scale * 4.1) : Math.max(10, scale * 1.6));
          ctx.fillStyle = "#3a2716"; ctx.fillRect((sx - fs * 0.5) | 0, (fy - fs * 0.6) | 0, Math.max(1, fs * 0.3) | 0, (fs * 2) | 0); // 旗竿
          const fcol = "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")";
          const fx1 = sx - fs * 0.2, segw = fs / 4;
          for (let fsg = 0; fsg < 4; fsg++) {
            const wv = Math.round(Math.sin(t * 3.5 + id + fsg * 0.85) * fs * 0.3 * (0.35 + 0.25 * fsg)); // 旗先ほど大きく翻る
            const segy = (fy - fs * 0.6 + wv) | 0, segX = (fx1 + fsg * segw) | 0, sw = Math.max(1, segw + 1) | 0;
            ctx.fillStyle = fcol; ctx.fillRect(segX, segy, sw, (fs * 0.8) | 0);
            ctx.fillStyle = "rgba(255,255,255,0.42)"; ctx.fillRect(segX, segy, sw, Math.max(1, fs * 0.25) | 0); // 上辺の照り
          }
        }
      }
    }

    // 廃都: 滅んだ国の建物は立ったまま残る。旗も煙も無く、灰色に沈んだ静かな街並みが
    //   風化しながら佇む（傷むほど暗く、ひび割れて見える）。
    const gts = civ.ghostTowns;
    if (gts && gts.length && detailed) {
      const size = Math.max(12, scale * 2.0);
      for (let g = 0; g < gts.length; g++) {
        const town = gts[g];
        if (town.x < range.x0 - 4 || town.x > range.x1 + 4 || town.y < range.y0 - 4 || town.y > range.y1 + 4) continue;
        const bs = town.buildings;
        for (let bi = 0; bi < bs.length; bi++) {
          const bd = bs[bi];
          const lvl = bd.lvl || 1;
          const cond = bd.cond == null ? 1 : bd.cond;
          // 廃屋の翳り: 灰に沈んだスプライト変種で描く（翳りが建物からはみ出さない）。
          const img = sprites.buildingGhost(bd.t, Math.min(3, 1 + ((1 - cond) * 3) | 0));
          const bw = size * (BUILD_SIZE[bd.t] || 1) * (1 + (lvl - 1) * 0.18);
          const bh = bw * (img.height / img.width);
          const bx = camera.worldToScreenX((bd.x + 0.5) * tile);
          const by = camera.worldToScreenY((bd.y + 0.5) * tile);
          ctx.fillStyle = "rgba(0,0,0,0.2)";
          ctx.beginPath(); ctx.ellipse(bx, by - bh * 0.06, bw * 0.44, bw * 0.16, 0, 0, Math.PI * 2); ctx.fill();
          ctx.drawImage(img, (bx - bw * 0.5) | 0, (by - bh) | 0, bw | 0, bh | 0);
          if (cond < 0.45 && scale >= 4) { // 崩れかけの亀裂
            ctx.strokeStyle = "rgba(28,24,20,0.65)";
            ctx.lineWidth = Math.max(1, scale * 0.06);
            ctx.beginPath();
            ctx.moveTo((bx - bw * 0.14) | 0, (by - bh * 0.72) | 0);
            ctx.lineTo((bx + bw * 0.08) | 0, (by - bh * 0.3) | 0);
            ctx.stroke();
          }
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
    const u = Math.max(1, scale * 0.12);
    for (let m = 0; m < marks.length; m++) {
      const mk = marks[m];
      if (mk.x < range.x0 || mk.x > range.x1 || mk.y < range.y0 || mk.y > range.y1) continue;
      const a = (mk.ttl / mk.life); // 時間で薄れる（土に還る）
      const cx = camera.worldToScreenX((mk.x + 0.5) * tile);
      const cy = camera.worldToScreenY((mk.y + 0.5) * tile);
      if (mk.type === "ruin") {
        // 廃墟: 滅んだ国の建物跡。崩れかけた石壁と折れた柱が苔むして残る（倒れた文明の痕跡）。
        //   長寿命なので序盤はくっきり、時とともにゆっくり土に還る。
        const av = Math.min(1, 0.55 + 0.45 * a); // 長く濃く残す
        ctx.fillStyle = "rgba(64,60,54," + (0.7 * av).toFixed(3) + ")";      // 基壇（崩れた土台）
        ctx.fillRect((cx - s * 0.5) | 0, (cy + s * 0.05) | 0, (s) | 0, (s * 0.3) | 0);
        ctx.fillStyle = "rgba(122,116,104," + (0.85 * av).toFixed(3) + ")";  // 折れた壁・柱
        ctx.fillRect((cx - s * 0.42) | 0, (cy - s * 0.35) | 0, Math.max(1, s * 0.16) | 0, (s * 0.45) | 0);
        ctx.fillRect((cx + s * 0.26) | 0, (cy - s * 0.2) | 0, Math.max(1, s * 0.16) | 0, (s * 0.3) | 0); // 低く折れた柱
        ctx.fillStyle = "rgba(140,134,120," + (0.8 * av).toFixed(3) + ")";   // 崩れた石材
        ctx.fillRect((cx - s * 0.08) | 0, (cy - s * 0.18) | 0, Math.max(1, s * 0.2) | 0, (s * 0.28) | 0);
        ctx.fillStyle = "rgba(74,110,64," + (0.35 * av).toFixed(3) + ")";    // 苔・草に覆われる
        ctx.fillRect((cx - s * 0.5) | 0, (cy + s * 0.28) | 0, (s) | 0, Math.max(1, u * 0.6) | 0);
      } else if (mk.type === "rubble") {
        // 瓦礫: 戦火に崩れた建物の残骸。灰色の石材が散らばる（戦争が生んだ廃墟）。
        ctx.fillStyle = "rgba(70,66,60," + (0.75 * a).toFixed(3) + ")";
        ctx.fillRect((cx - s * 0.45) | 0, (cy - s * 0.1) | 0, (s * 0.9) | 0, (s * 0.5) | 0);
        ctx.fillStyle = "rgba(120,114,104," + (0.8 * a).toFixed(3) + ")";
        ctx.fillRect((cx - s * 0.4) | 0, (cy - s * 0.3) | 0, u, u);
        ctx.fillRect((cx + s * 0.1) | 0, (cy - s * 0.22) | 0, u, u);
        ctx.fillRect((cx - s * 0.05) | 0, (cy + s * 0.02) | 0, u, u);
      } else {
        // 亡骸: 倒れた兵が横たわる（演出でなく実際の戦死の跡。やがて土に還る）。
        ctx.fillStyle = "rgba(70,60,46," + (0.7 * a).toFixed(3) + ")"; // 胴（横たわる）
        ctx.fillRect((cx - s * 0.4) | 0, (cy - u * 0.5) | 0, (s * 0.7) | 0, Math.max(1, u * 1.4) | 0);
        ctx.fillStyle = "rgba(214,180,140," + (0.7 * a).toFixed(3) + ")"; // 頭
        ctx.fillRect((cx + s * 0.28) | 0, (cy - u * 0.5) | 0, Math.max(1, u * 1.2) | 0, Math.max(1, u * 1.2) | 0);
        ctx.fillStyle = "rgba(120,24,20," + (0.5 * a).toFixed(3) + ")"; // 流れた血だまり
        ctx.fillRect((cx - s * 0.5) | 0, (cy + u) | 0, (s) | 0, Math.max(1, u * 0.6) | 0);
      }
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
