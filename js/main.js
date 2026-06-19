// 起動。全モジュールを生成・配線してループを開始する。
(function (Game) {
  "use strict";

  function boot() {
    const cfg = Game.config;
    const canvas = document.getElementById("game");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // ワールド生成。
    const world = new Game.World(cfg.mapWidth, cfg.mapHeight);
    Game.worldgen.generate(world, cfg.seed);

    // カメラ・レンダラ・入力・エンジン。
    const camera = new Game.Camera(canvas.width, canvas.height);
    camera.fitToMap();

    const renderer = new Game.Renderer(canvas, world);
    renderer.resize();

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

    // リサイズ対応。
    window.addEventListener("resize", function () {
      renderer.resize();
      camera.resize(canvas.width, canvas.height);
    });

    engine.start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window.Game);
