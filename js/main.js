// 起動。全モジュールを生成・配線してループを開始する。
(function (Game) {
  "use strict";

  function boot() {
    const cfg = Game.config;
    // 端末ごとに地図サイズ・上限・初期ズームを最適化。
    if (Game.applyDeviceProfile) Game.applyDeviceProfile();
    const canvas = document.getElementById("game");

    // ワールド生成。
    const world = new Game.World(cfg.mapWidth, cfg.mapHeight);
    Game.worldgen.generate(world, cfg.seed);

    // カメラはCSSピクセル基準のビューサイズで動く。
    const camera = new Game.Camera(window.innerWidth, window.innerHeight);

    const renderer = new Game.Renderer(canvas, world);
    renderer.resize(); // 高DPI対応で実バッファを確保
    camera.fitTiles(cfg.initialFitTiles || 130); // 操作しやすい初期ズーム（全体ではなく一帯を表示）

    const brush = new Game.Brush(5);
    const input = new Game.Input(canvas, camera, world, renderer);
    const engine = new Game.Engine(renderer, camera, input);

    // 気候・季節（最初に tick して clock を更新）。
    const climate = new Game.ClimateSystem();
    engine.systems.push(climate);

    // 天候（雲・雨・落雷）。
    const weather = new Game.WeatherSystem(world, renderer);
    engine.systems.push(weather);

    // 植生・生態系（fertility を初期化してから配線）。
    const vegetation = new Game.VegetationSystem(world, renderer);
    vegetation.seed(world);
    engine.systems.push(vegetation);

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

    // 自然災害（噴火・地震・干ばつ）。civ の後に評価。
    const disasters = new Game.DisasterSystem(world, renderer);
    engine.systems.push(disasters);

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
    Game.state.climate = climate;
    Game.state.weather = weather;
    Game.state.vegetation = vegetation;
    Game.state.disasters = disasters;
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
      climate.reset();
      weather.setWorld(w);
      vegetation.setWorld(w);
      vegetation.seed(w);
      creatures.setWorld(w);
      fire.setWorld(w);
      civ.setWorld(w);
      civ.clear();
      disasters.setWorld(w);
      camera.fitTiles(cfg.initialFitTiles || 130);
      if (Game.minimap) Game.minimap._fit();
      seedLife(); // 新しい世界にも文明と野生を芽吹かせる（最初から「生きた世界」を観られる）
    };

    // 世界に初期生命を芽吹かせる: いくつかの文明を建国し、野生（草食・肉食）を放つ。
    //   これにより読み込んだ瞬間から世界が動き出し、放っておいても勝手に栄枯盛衰が進む。
    //   規模は地図の広さに応じて加減する。ユーザーは神の手ツールでさらに足せる。
    function seedLife() {
      const w = Game.state.world, civ = Game.state.civ, ent = Game.state.entities;
      if (!w || !civ || !ent) return;
      const W = w.width, H = w.height, area = W * H;
      const tile = Game.tile, S = Game.SPECIES;
      // 文明（建国数は広さに比例、6〜18国）。
      const nK = Math.max(6, Math.min(18, Math.round(area / 16000)));
      let founded = 0;
      for (let a = 0; a < nK * 600 && founded < nK; a++) {
        const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
        if (tile.isLand(w.terrain[y * W + x]) && civ.foundAt(x, y) > 0) founded++;
      }
      // 野生（草食を広く、肉食をひとつまみ）。
      const nH = Math.min(1500, Math.round(area / 900));
      const nP = Math.round(nH * 0.08);
      const rg = () => 0.8 + Math.random() * 0.4;
      let herb = 0, pred = 0;
      for (let a = 0; a < nH * 8 && herb < nH; a++) {
        const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
        if (tile.isEdible(w.terrain[y * W + x])) { ent.spawn(S.HERBIVORE, x + 0.5, y + 0.5, 0.8, rg(), rg(), rg(), rg()); herb++; }
      }
      for (let a = 0; a < nP * 40 && pred < nP; a++) {
        const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
        if (tile.isEdible(w.terrain[y * W + x])) { ent.spawn(S.PREDATOR, x + 0.5, y + 0.5, 0.85, rg(), rg(), rg(), rg()); pred++; }
      }
    }

    Game.toolbar.init();
    if (Game.hud) Game.hud.init();
    if (Game.minimap) Game.minimap.init();
    if (Game.nations) Game.nations.init();
    if (Game.chronicle) Game.chronicle.init();
    if (Game.inspector) Game.inspector.init();
    if (Game.settings) Game.settings.init();
    if (Game.overview) Game.overview.init();
    if (Game.mapview) Game.mapview.init();
    if (Game.toasts) Game.toasts.init();
    if (Game.help) Game.help.init();

    // リサイズ / 端末回転対応。カメラには CSSピクセルを渡す。
    function handleResize() {
      renderer.resize();
      camera.resize(renderer.cssW, renderer.cssH);
    }
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);

    seedLife();   // 起動時から世界に生命を満たす（最初から栄枯盛衰が進む）
    engine.start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window.Game);
