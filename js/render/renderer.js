// レンダラ。地形はオフスクリーン canvas（1タイル=1px）にキャッシュし、
// 毎フレームは drawImage 一発で可視領域を拡大ブリットする。
// タイル編集時は dirty タイルだけ ImageData で部分更新する。
(function (Game) {
  "use strict";

  // 役割ごとの被り物の色（ROLE: 0=開拓者,1=農民,2=建築家,3=兵士,4=鍛冶,5=商人,6=神官）。
  const ROLE_HAT = [null, "#4fae4f", "#e08a2a", "#b9c2cc", "#6a6a72", "#d8b84a", "#ece9e0"];
  // 建物タイプごとの相対サイズ（実世界の規模感に合わせる。index=建物タイプ）。
  // 0小屋 1家 2邸宅 3砦 4神殿 5農場 6工房 7市場 8兵舎 9穀倉 10鉱山 11大記念碑
  const BUILD_SIZE = [0.78, 1.0, 1.28, 1.55, 1.4, 0.95, 1.02, 0.88, 1.2, 1.0, 0.85, 2.1];
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
    const c = civ.colorOf(id);
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
        const c = civ.colorOf(id);
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

    // 街道（首都と各都市を結ぶ）。
    this.drawRoads(camera);

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

    // 選択ハイライト（インスペクタで選んだ対象）。
    this.drawSelection(camera);

    // 天候（雲の影・雨・落雷）。
    this.drawWeather(camera);

    // 昼夜の環境光（全要素の上に重ねて統一した照明にする）。
    this.drawDayNight(camera);

    // 国名ラベル（照明の影響を受けず常に読める）。
    this.drawLabels(camera);

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

    for (let p = 0; p < people.length; p++) {
      const person = people[p];
      // 移動検知（前フレーム座標を各人に保持し、しばらく歩行アニメを継続）。
      const ddx = person.x - (person._px || 0), ddy = person.y - (person._py || 0);
      if (ddx * ddx + ddy * ddy > 1e-5) person._mv = 16;
      person._px = person.x; person._py = person.y;
      if (person.x < range.x0 || person.x > range.x1 || person.y < range.y0 || person.y > range.y1) continue;
      const moving = (person._mv || 0) > 0;
      if (moving) person._mv--;
      const k = person.kid ? civ.kingdoms[person.kid] : null;
      const sx = Math.round(camera.worldToScreenX((person.x + 0.5) * tile));
      const sy = Math.round(camera.worldToScreenY((person.y + 0.5) * tile));
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
      const skin = SKIN[lk % SKIN.length];
      const LIFE = Game.lifeStages || LIFE_DEFAULT;
      const age = person.age || 0;
      const isChild = age < LIFE.adult;
      const isElder = age >= LIFE.elder;
      const hair = isElder ? "#dcdcdc" : HAIR[(lk >> 5) % HAIR.length];
      // 年齢で体格が変わる（誕生時0.55→成人で1.0、老人は0.95）。
      const grow = isChild ? (0.55 + 0.45 * (age / LIFE.adult)) : (isElder ? 0.95 : 1);
      const uu = Math.max(1, Math.round(u * grow));
      // 歩行の振り（脚は前後、腕は逆位相）＋胴の小さなバウンド。
      const ph = moving ? t * 6 + p * 0.7 : 0;
      const sw = moving ? Math.round(Math.sin(ph) * uu) : 0; // -uu..uu
      const ob = moving ? -Math.round(Math.abs(Math.sin(ph)) * uu * 0.5) : 0; // 上下動
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
          case 3: // 兵士: 槍（鋼が進むと剣に鍔がつく）
            ctx.fillStyle = wood; ctx.fillRect(hxp, sy - 5 * uu + ob, uu, 7 * uu);
            ctx.fillStyle = metal; ctx.fillRect(hxp, sy - 6 * uu + ob, uu, 2 * uu);
            if (g >= 3) { ctx.fillStyle = metal; ctx.fillRect(hxp - uu, sy - 5 * uu + ob, 3 * uu, uu); }
            break;
          case 1: // 農民: 鍬
            ctx.fillStyle = wood; ctx.fillRect(hxp, sy - 4 * uu + ob, uu, 6 * uu);
            ctx.fillStyle = metal; ctx.fillRect(hxp + (fd > 0 ? uu : -uu), sy - 4 * uu + ob, uu, uu);
            break;
          case 2: // 建築家: 槌
          case 4: // 鍛冶: 槌（頭は鉄黒）
            ctx.fillStyle = wood; ctx.fillRect(hxp, sy - 3 * uu + ob, uu, 5 * uu);
            ctx.fillStyle = person.role === 4 ? "#55585f" : metal;
            ctx.fillRect(hxp - uu, sy - 4 * uu + ob, 3 * uu, 2 * uu);
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
    function wagon(ax, ay, bx, by, frac, col) {
      const x = ax + (bx - ax) * frac, y = ay + (by - ay) * frac;
      if (x < range.x0 - 1 || x > range.x1 + 1 || y < range.y0 - 1 || y > range.y1 + 1) return;
      const sx = camera.worldToScreenX((x + 0.5) * tile);
      const sy = camera.worldToScreenY((y + 0.5) * tile);
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
          // 交易量に応じて1〜3台の隊商を時間差で走らせる。
          const wagons = vol > 8 ? 3 : vol > 3 ? 2 : 1;
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
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const tile = Game.config.tilePx;
    const scale = tile * camera.zoom;
    if (scale < 1.4) return;
    const ctx = this.ctx;
    const kingdoms = civ.kingdoms;
    ctx.save();
    ctx.lineCap = "round";
    const wBase = Math.max(1.5, scale * 0.22);
    // 2層描き（暗い縁＋明るい路面）で「道」らしく。
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? "rgba(60,46,30,0.6)" : "rgba(190,168,120,0.7)";
      ctx.lineWidth = pass === 0 ? wBase : wBase * 0.55;
      for (let id = 1; id < kingdoms.length; id++) {
        const k = kingdoms[id];
        if (!k || !k.alive || !k.cities || k.cities.length < 2) continue;
        const cap = k.cities[0];
        const cx = camera.worldToScreenX((cap.x + 0.5) * tile);
        const cy = camera.worldToScreenY((cap.y + 0.5) * tile);
        for (let c = 1; c < k.cities.length; c++) {
          const city = k.cities[c];
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(camera.worldToScreenX((city.x + 0.5) * tile), camera.worldToScreenY((city.y + 0.5) * tile));
          ctx.stroke();
        }
      }
    }
    ctx.restore();
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
