// 入力処理。マウス（描画/パン/ズーム）とキーボード（パン/ツール/ブラシ）。
(function (Game) {
  "use strict";

  function Input(canvas, camera, world, renderer) {
    this.canvas = canvas;
    this.camera = camera;
    this.world = world;
    this.renderer = renderer;

    this.keys = {}; // 押下中キー（engine がポーリングしてパン）
    this.painting = false;
    this.panning = false;
    this.lastMouse = { x: 0, y: 0 };

    // タッチ用ジェスチャ状態。
    this.touchPainting = false;
    this.gesture = null; // 2本指: { midX, midY, dist }

    this._bind();
    this._bindTouch();
  }

  Input.prototype.setWorld = function (world) {
    this.world = world;
  };

  Input.prototype._bind = function () {
    const self = this;
    const canvas = this.canvas;

    canvas.addEventListener("mousedown", function (e) {
      if (e.button === 1 || e.button === 2 || (e.button === 0 && self.keys[" "])) {
        // 中ボタン / 右ボタン / Space+左 → パン
        self.panning = true;
        canvas.classList.add("panning");
      } else if (e.button === 0) {
        self.painting = true;
        self.applyAt(e.clientX, e.clientY);
      }
      self.lastMouse.x = e.clientX;
      self.lastMouse.y = e.clientY;
      e.preventDefault();
    });

    window.addEventListener("mousemove", function (e) {
      const dx = e.clientX - self.lastMouse.x;
      const dy = e.clientY - self.lastMouse.y;
      self.lastMouse.x = e.clientX;
      self.lastMouse.y = e.clientY;

      // ホバー中のタイルを更新（ブラシプレビュー / 座標表示）。
      const t = self.camera.screenToTile(e.clientX, e.clientY);
      Game.state.mouseTile.x = t.x;
      Game.state.mouseTile.y = t.y;

      if (self.panning) {
        self.camera.panByScreen(dx, dy);
      } else if (self.painting) {
        self.applyAt(e.clientX, e.clientY);
      }
    });

    window.addEventListener("mouseup", function () {
      self.painting = false;
      self.panning = false;
      canvas.classList.remove("panning");
    });

    // 右クリックメニュー抑止（右ドラッグパン用）。
    canvas.addEventListener("contextmenu", function (e) {
      e.preventDefault();
    });

    // ホイールズーム（カーソル基点）。
    canvas.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        self.camera.zoomAt(e.clientX, e.clientY, factor);
      },
      { passive: false }
    );

    // キーボード。
    window.addEventListener("keydown", function (e) {
      // 入力欄にフォーカス中は無視。
      if (e.target.tagName === "INPUT") return;
      self.keys[e.key.toLowerCase()] = true;
      self.keys[e.key] = true;

      // ツール選択（数字キー）。
      const tool = Game.godpowers.list.find(function (t) {
        return t.hotkey === e.key;
      });
      if (tool) {
        Game.setActiveTool(tool.id);
      }

      // ブラシサイズ [ ]
      if (e.key === "[") Game.setBrushSize(Game.state.brush.size - 1);
      if (e.key === "]") Game.setBrushSize(Game.state.brush.size + 1);

      // P でシミュレーション一時停止/再生。
      if (e.key === "p" || e.key === "P") {
        if (Game.togglePaused) Game.togglePaused();
      }
    });

    window.addEventListener("keyup", function (e) {
      self.keys[e.key.toLowerCase()] = false;
      self.keys[e.key] = false;
    });
  };

  // ===== タッチ操作 =====
  // 1本指ドラッグ = 視点移動（パン） / 1本指タップ = ツール適用 /
  // 2本指 = パン + ピンチズーム。
  // 「動かそうとしただけで配置/地形変更される」を防ぐため、指が一定距離
  // 動いたらパン扱いにし、タップ（ほぼ動かさず離す）だけツールを適用する。
  Input.prototype._bindTouch = function () {
    const self = this;
    const canvas = this.canvas;
    const TAP_SLOP = 12; // これ以上動いたらタップではなくドラッグ

    function touchMid(t0, t1) {
      return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
    }
    function touchDist(t0, t1) {
      const dx = t0.clientX - t1.clientX;
      const dy = t0.clientY - t1.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    canvas.addEventListener(
      "touchstart",
      function (e) {
        e.preventDefault();
        if (e.touches.length === 1) {
          // 1本指: まだ何もしない（タップかドラッグか確定するまで待つ）。
          const t = e.touches[0];
          self.gesture = null;
          self.touch = { sx: t.clientX, sy: t.clientY, lx: t.clientX, ly: t.clientY, moved: 0, mode: "pending" };
          self._updateMouseTile(t.clientX, t.clientY);
        } else if (e.touches.length === 2) {
          // 2本指: パン/ズーム。配置はしない。
          self.touch = null;
          const t0 = e.touches[0], t1 = e.touches[1];
          const mid = touchMid(t0, t1);
          self.gesture = { midX: mid.x, midY: mid.y, dist: touchDist(t0, t1) };
        }
      },
      { passive: false }
    );

    canvas.addEventListener(
      "touchmove",
      function (e) {
        e.preventDefault();
        if (e.touches.length === 1 && self.touch) {
          const t = e.touches[0];
          const dx = t.clientX - self.touch.lx;
          const dy = t.clientY - self.touch.ly;
          self.touch.lx = t.clientX;
          self.touch.ly = t.clientY;
          self.touch.moved += Math.abs(dx) + Math.abs(dy);
          // 一定距離動いたら「パン」に確定。
          if (self.touch.mode === "pending" && self.touch.moved > TAP_SLOP) {
            self.touch.mode = "pan";
          }
          if (self.touch.mode === "pan") {
            self.camera.panByScreen(dx, dy);
            self._updateMouseTile(t.clientX, t.clientY);
          }
        } else if (e.touches.length === 2 && self.gesture) {
          const t0 = e.touches[0], t1 = e.touches[1];
          const mid = touchMid(t0, t1);
          const dist = touchDist(t0, t1);
          self.camera.panByScreen(mid.x - self.gesture.midX, mid.y - self.gesture.midY);
          if (self.gesture.dist > 0) self.camera.zoomAt(mid.x, mid.y, dist / self.gesture.dist);
          self.gesture.midX = mid.x;
          self.gesture.midY = mid.y;
          self.gesture.dist = dist;
        }
      },
      { passive: false }
    );

    function endTouch(e) {
      if (e.touches.length === 0) {
        // 指が全部離れた。タップ（ほぼ動かしていない）ならツールを1回適用。
        if (self.touch && self.touch.mode === "pending" && self.touch.moved <= TAP_SLOP) {
          self.applyAt(self.touch.sx, self.touch.sy);
        }
        self.touch = null;
        self.gesture = null;
        Game.state.mouseTile.x = -1;
        Game.state.mouseTile.y = -1;
      } else {
        // 指が減った（2→1 等）: 誤適用を避けてジェスチャ終了のみ。
        self.gesture = null;
        self.touch = null;
      }
    }
    canvas.addEventListener("touchend", endTouch, { passive: false });
    canvas.addEventListener("touchcancel", endTouch, { passive: false });
  };

  // ホバー中タイルを更新（プレビュー / 座標HUD用）。
  Input.prototype._updateMouseTile = function (sx, sy) {
    const t = this.camera.screenToTile(sx, sy);
    Game.state.mouseTile.x = t.x;
    Game.state.mouseTile.y = t.y;
  };

  // スクリーン座標 (sx,sy) に現在のツールをブラシ適用。
  Input.prototype.applyAt = function (sx, sy) {
    const t = this.camera.screenToTile(sx, sy);
    if (!this.world.inBounds(t.x, t.y)) return;
    const tool = Game.godpowers.get(Game.state.activeToolId);
    const brush = Game.state.brush;
    const world = this.world;
    const renderer = this.renderer;
    brush.forEachTile(world, t.x, t.y, function (x, y, falloff) {
      tool.apply(world, x, y, falloff);
      renderer.markDirty(x, y);
    });
  };

  // engine からの毎フレーム更新（キー押下による滑らかなパン）。
  Input.prototype.update = function (dt) {
    const k = this.keys;
    const speed = (600 / this.camera.zoom) * (dt / 1000); // ワールドpx/秒
    let dwx = 0;
    let dwy = 0;
    if (k["w"] || k["arrowup"]) dwy -= speed;
    if (k["s"] || k["arrowdown"]) dwy += speed;
    if (k["a"] || k["arrowleft"]) dwx -= speed;
    if (k["d"] || k["arrowright"]) dwx += speed;
    if (dwx !== 0 || dwy !== 0) {
      this.camera.panByWorld(dwx, dwy);
    }
  };

  Game.Input = Input;
})(window.Game);
