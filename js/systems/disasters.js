// 自然災害システム。ときおり火山の噴火・地震・干ばつが自然発生し、世界に
// 起伏のあるドラマを与える。いずれも稀で局所的。年代記に記録される。
// engine から固定ステップ tick(world) で駆動される（civ の後に登録）。
(function (Game) {
  "use strict";

  function DisasterSystem(world, renderer) {
    this.world = world;
    this.renderer = renderer;
    this.rand = Game.utils.mulberry32((Game.config.seed ^ 0xd15a57e5) >>> 0);
    this._t = 0;
  }

  DisasterSystem.prototype.setWorld = function (world) { this.world = world; };
  DisasterSystem.prototype.clear = function () {};

  DisasterSystem.prototype.tick = function (world) {
    this._t++;
    if (this._t % 50 !== 0) return; // 評価は50ティックごと（=低頻度）
    const st = Game.config.settings;
    if (st && st.disasters === false) return; // 設定で無効化
    const rand = this.rand;
    if (rand() < 0.03) this._eruption(world);
    if (rand() < 0.03) this._earthquake(world);
    const season = Game.state.clock && Game.state.clock.season;
    if (season && season.name === "夏" && rand() < 0.04) this._drought(world);
  };

  // 火山噴火: 山岳タイルを中心に、可燃地を発火させ、周囲を焼け地にする。
  DisasterSystem.prototype._eruption = function (world) {
    const W = world.width, H = world.height, rand = this.rand;
    const tile = Game.tile, T = Game.TERRAIN;
    let ex = -1, ey = -1;
    for (let s = 0; s < 40; s++) {
      const x = (rand() * W) | 0, y = (rand() * H) | 0;
      if (world.terrain[y * W + x] === T.MOUNTAIN) { ex = x; ey = y; break; }
    }
    if (ex < 0) return;
    const fire = Game.state.fire, R = 3;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = ex + dx, y = ey + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const d = dx * dx + dy * dy;
        if (d > R * R) continue;
        const i = y * W + x, ter = world.terrain[i];
        if (tile.isFlammable(ter)) { if (fire && fire.ignite) fire.ignite(x, y); }
        else if (d <= 2 && tile.isLand(ter)) {
          world.terrain[i] = T.SCORCHED;
          if (this.renderer) this.renderer.markDirty(x, y);
        }
      }
    }
    this._log("🌋 " + this._place(world, ex, ey) + "で火山が噴火した");
  };

  // 地震: 都市を震源に、砦以外の建物が倒壊し、付近の住民に犠牲が出る。
  DisasterSystem.prototype._earthquake = function (world) {
    const civ = Game.state.civ;
    if (!civ || !civ.kingdoms) return;
    const rand = this.rand;
    const cands = [];
    for (let id = 1; id < civ.kingdoms.length; id++) {
      const k = civ.kingdoms[id];
      if (k && k.alive && k.cities && k.cities.length) cands.push(k);
    }
    if (!cands.length) return;
    const k = cands[(rand() * cands.length) | 0];
    const city = k.cities[(rand() * k.cities.length) | 0];

    // 建物倒壊（砦=3 以外を最大2棟）。
    let destroyed = 0;
    if (city.buildings) {
      for (let n = 0; n < 2; n++) {
        const idxs = [];
        for (let bi = 0; bi < city.buildings.length; bi++) if (city.buildings[bi].t !== 3) idxs.push(bi);
        if (!idxs.length) break;
        city.buildings.splice(idxs[(rand() * idxs.length) | 0], 1);
        destroyed++;
      }
    }
    // 住民の犠牲（震源 8タイル以内・確率・上限つき）。
    const ex = city.x, ey = city.y, R2 = 64;
    let killed = 0;
    const people = civ.people;
    for (let p = 0; p < people.length; p++) {
      const o = people[p];
      if (!o.alive || !o.kid) continue;
      const dx = o.x - ex, dy = o.y - ey;
      if (dx * dx + dy * dy > R2) continue;
      if (rand() < 0.12) {
        o.alive = false;
        if (civ._addMark) civ._addMark(o.x, o.y);
        if (++killed >= 12) break;
      }
    }
    k.unrest = Math.min(100, (k.unrest || 0) + 10);
    this._log("🌐 " + k.name + "の" + (city.capital ? "首都" : "都市") + "で地震 — 建物" + destroyed + "棟が倒壊");
  };

  // 干ばつ: 帯状の地域の肥沃度を半減させ、食料事情を悪化させる。
  DisasterSystem.prototype._drought = function (world) {
    if (!world.fertility) return;
    const W = world.width, H = world.height, rand = this.rand;
    const y0 = (rand() * H * 0.6) | 0;
    const y1 = Math.min(H, y0 + 20 + ((rand() * 20) | 0));
    const f = world.fertility;
    for (let y = y0; y < y1; y++) {
      const base = y * W;
      for (let x = 0; x < W; x++) f[base + x] *= 0.5;
    }
    this._log("☀️ 干ばつが大地を干上がらせた");
  };

  // 災害地点の帰属（国名 or 辺境）。
  DisasterSystem.prototype._place = function (world, x, y) {
    const o = world.owner[y * world.width + x];
    const civ = Game.state.civ;
    if (o && civ && civ.kingdoms[o] && civ.kingdoms[o].alive) return civ.kingdoms[o].name + "領";
    return "辺境";
  };

  DisasterSystem.prototype._log = function (text) {
    const civ = Game.state.civ;
    if (civ && civ._logEvent) civ._logEvent(text);
  };

  Game.DisasterSystem = DisasterSystem;
})(window.Game);
