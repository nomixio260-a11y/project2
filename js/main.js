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

    // 生物ストア + シミュレーションシステム。
    const entities = new Game.Entities(cfg.sim.maxEntities);
    renderer.setEntities(entities);
    const creatures = new Game.CreatureSystem(entities, world, renderer);
    engine.systems.push(creatures);

    // 炎システム。
    const fire = new Game.FireSystem(world, renderer);
    renderer.setFire(fire);
    engine.systems.push(fire);

    // 文明システム。
    const civ = new Game.CivSystem(world, renderer);
    engine.systems.push(civ);

    // 共有状態へ格納。
    Game.state.world = world;
    Game.state.camera = camera;
    Game.state.renderer = renderer;
    Game.state.input = input;
    Game.state.engine = engine;
    Game.state.brush = brush;
    Game.state.entities = entities;
    Game.state.creatures = creatures;
    Game.state.fire = fire;
    Game.state.civ = civ;
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

    Game.setPaused = function (paused) {
      engine.setPaused(paused);
      if (Game.toolbar.setPaused) Game.toolbar.setPaused(paused);
    };

    Game.togglePaused = function () {
      Game.setPaused(cfg.sim.running);
    };

    Game.setSpeed = function (mult) {
      engine.setSpeed(mult);
      if (Game.toolbar.setSpeed) Game.toolbar.setSpeed(mult);
    };

    Game.regenerate = function () {
      cfg.seed = (Math.random() * 1e9) | 0;
      const w = new Game.World(cfg.mapWidth, cfg.mapHeight);
      Game.worldgen.generate(w, cfg.seed);
      Game.state.world = w;
      renderer.setWorld(w);
      input.setWorld(w);
      // シミュレーション状態をリセット。
      entities.clear();
      creatures.setWorld(w);
      fire.setWorld(w);
      civ.setWorld(w);
      civ.clear();
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
