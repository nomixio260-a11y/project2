// 起動。全モジュールを生成・配線してループを開始する。
(function (Game) {
  "use strict";

  function boot() {
    const cfg = Game.config;
    const canvas = document.getElementById("game");

    // ワールド生成。
    const world = new Game.World(cfg.mapWidth, cfg.mapHeight);
    Game.worldgen.generate(world, cfg.seed);

    // カメラはCSSピクセル基準のビューサイズで動く。
    const camera = new Game.Camera(window.innerWidth, window.innerHeight);

    const renderer = new Game.Renderer(canvas, world);
    renderer.resize(); // 高DPI対応で実バッファを確保
    camera.fitToMap();

    const brush = new Game.Brush(3);
    const input = new Game.Input(canvas, camera, world, renderer);
    const engine = new Game.Engine(renderer, camera, input);

    // 共有状態へ格納。
    Game.state.world = world;
    Game.state.camera = camera;
    Game.state.renderer = renderer;
    Game.state.input = input;
    Game.state.engine = engine;
    Game.state.brush = brush;
    Game.state.activeToolId = "raise";

    // UI からも呼べる公開 API。
    Game.setActiveTool = function (id) {
      if (!Game.godpowers.get(id)) return;
      Game.state.activeToolId = id;
      Game.toolbar.setActive(id);
    };

    Game.setBrushSize = function (size) {
      size = Game.utils.clamp(size | 0, 1, 40);
      Game.state.brush.size = size;
      Game.toolbar.setBrushSize(size);
    };

    Game.regenerate = function () {
      cfg.seed = (Math.random() * 1e9) | 0;
      const w = new Game.World(cfg.mapWidth, cfg.mapHeight);
      Game.worldgen.generate(w, cfg.seed);
      Game.state.world = w;
      renderer.setWorld(w);
      input.setWorld(w);
      camera.fitToMap();
    };

    Game.toolbar.init();

    // リサイズ / 端末回転対応。カメラには CSSピクセルを渡す。
    function handleResize() {
      renderer.resize();
      camera.resize(renderer.cssW, renderer.cssH);
    }
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);

    engine.start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window.Game);
