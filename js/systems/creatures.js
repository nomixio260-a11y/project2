// 生物シミュレーション。固定タイムステップ tick(world) で動く。
// 草食: 植生を採食しエネルギー回復→繁殖。肉食: 草食を捕食。
// 餓死・寿命・溺死で死亡。空間グリッドで近傍探索を O(N) に保つ。
(function (Game) {
  "use strict";

  const S = Game.SPECIES;
  const tile = Game.tile;

  // パラメータ（1ティック=シム内100ms 基準）。
  const P = {
    metabolism: [0.010, 0.016], // 種別ごとの基礎代謝
    speed: [0.25, 0.36], // タイル/ティック
    grazeGain: 0.06, // 採食でのエネルギー回復
    preyGain: 0.55, // 捕食でのエネルギー回復
    reproduceAt: 0.82, // この energy で繁殖
    reproduceChance: 0.06,
    offspringEnergy: 0.32,
    maxAge: [1100, 1500],
    eatRadius: 0.7, // 肉食の捕食到達距離
    degradeChance: 0.02, // 採食で植生が一段劣化する確率
  };

  function CreatureSystem(entities, world, renderer) {
    this.entities = entities;
    this.world = world;
    this.renderer = renderer;
    this.rand = Game.utils.mulberry32((Game.config.seed ^ 0x1234abcd) >>> 0);

    // 空間グリッド（近傍探索用）。
    this.cell = 4; // 1セル=4タイル
    this.gw = Math.ceil(world.width / this.cell);
    this.gh = Math.ceil(world.height / this.cell);
    this.head = new Int32Array(this.gw * this.gh);
    this.nextLink = new Int32Array(entities.capacity);
  }

  CreatureSystem.prototype.setWorld = function (world) {
    this.world = world;
    this.gw = Math.ceil(world.width / this.cell);
    this.gh = Math.ceil(world.height / this.cell);
    this.head = new Int32Array(this.gw * this.gh);
  };

  // 生存個体をグリッドに登録。
  CreatureSystem.prototype._buildGrid = function () {
    const e = this.entities;
    const head = this.head;
    head.fill(-1);
    const cell = this.cell;
    const gw = this.gw;
    const next = this.nextLink;
    for (let i = 0; i < e.count; i++) {
      if (!e.alive[i]) continue;
      const cx = (e.x[i] / cell) | 0;
      const cy = (e.y[i] / cell) | 0;
      const c = cy * gw + cx;
      next[i] = head[c];
      head[c] = i;
    }
  };

  // (px,py) 近傍で type に一致する最も近い個体を radius 内で探す。除外 self。
  CreatureSystem.prototype._nearest = function (px, py, type, radius, self) {
    const e = this.entities;
    const cell = this.cell;
    const gw = this.gw;
    const gh = this.gh;
    const r = Math.ceil(radius / cell);
    const cx = (px / cell) | 0;
    const cy = (py / cell) | 0;
    let best = -1;
    let bestD = radius * radius;
    for (let gy = cy - r; gy <= cy + r; gy++) {
      if (gy < 0 || gy >= gh) continue;
      for (let gx = cx - r; gx <= cx + r; gx++) {
        if (gx < 0 || gx >= gw) continue;
        let i = this.head[gy * gw + gx];
        while (i !== -1) {
          if (i !== self && e.alive[i] && e.type[i] === type) {
            const dx = e.x[i] - px;
            const dy = e.y[i] - py;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          i = this.nextLink[i];
        }
      }
    }
    return best;
  };

  CreatureSystem.prototype.tick = function (world) {
    const e = this.entities;
    const rand = this.rand;
    const W = world.width;
    const H = world.height;
    const maxEntities = Game.config.sim.maxEntities;

    this._buildGrid();

    const n = e.count; // 今ティックの個体のみ処理（新生は次ティック）
    for (let i = 0; i < n; i++) {
      if (!e.alive[i]) continue;
      const type = e.type[i];

      e.age[i] += 1;
      e.energy[i] -= P.metabolism[type];

      const tx = e.x[i] | 0;
      const ty = e.y[i] | 0;
      const here = world.terrain[ty * W + tx];

      // 溺死（陸生が深海に出た）。
      if (here === Game.TERRAIN.DEEP_WATER) {
        e.energy[i] -= 0.08;
      }

      let dirX = 0;
      let dirY = 0;

      if (type === S.HERBIVORE) {
        // 採食。
        if (tile.isEdible(here)) {
          e.energy[i] = Math.min(1, e.energy[i] + P.grazeGain);
          // たまに植生を一段劣化させる（過放牧）。
          if (rand() < P.degradeChance) {
            const idx = ty * W + tx;
            const t = world.terrain[idx];
            if (t === Game.TERRAIN.FOREST) world.terrain[idx] = Game.TERRAIN.GRASS;
            else if (t === Game.TERRAIN.JUNGLE) world.terrain[idx] = Game.TERRAIN.SAVANNA;
            else world.terrain[idx] = Game.TERRAIN.SAND;
            if (this.renderer) this.renderer.markDirty(tx, ty);
          }
        } else if (e.energy[i] < 0.6) {
          // 空腹なら近傍の食べられるタイルへ寄る。
          const f = this._seekFood(world, tx, ty);
          dirX = f.x;
          dirY = f.y;
        }
      } else {
        // 肉食: 近くの草食を捕食。
        const prey = this._nearest(e.x[i], e.y[i], S.HERBIVORE, 5, i);
        if (prey !== -1) {
          const dx = e.x[prey] - e.x[i];
          const dy = e.y[prey] - e.y[i];
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= P.eatRadius) {
            e.kill(prey);
            e.energy[i] = Math.min(1, e.energy[i] + P.preyGain);
          } else {
            dirX = dx / dist;
            dirY = dy / dist;
          }
        }
      }

      // 徘徊（食料方向が無ければランダム）。
      if (dirX === 0 && dirY === 0) {
        dirX = rand() - 0.5;
        dirY = rand() - 0.5;
      }
      const len = Math.hypot(dirX, dirY) || 1;
      const sp = P.speed[type];
      let nxp = e.x[i] + (dirX / len) * sp;
      let nyp = e.y[i] + (dirY / len) * sp;
      // 水へ踏み込まない（陸生）。境界もクランプ。
      const ntx = Game.utils.clamp(nxp | 0, 0, W - 1);
      const nty = Game.utils.clamp(nyp | 0, 0, H - 1);
      if (!tile.isWater(world.terrain[nty * W + ntx])) {
        e.x[i] = Game.utils.clamp(nxp, 0, W - 1);
        e.y[i] = Game.utils.clamp(nyp, 0, H - 1);
      }

      // 繁殖。新個体は次ティックの _buildGrid で登録される
      // （ここでグリッドへ挿し込むと、解放スロット再利用時に
      //  リンクリストが循環し _nearest が無限ループするため挿さない）。
      if (e.energy[i] > P.reproduceAt && e.live < maxEntities && rand() < P.reproduceChance) {
        const child = e.spawn(type, e.x[i], e.y[i], P.offspringEnergy);
        if (child !== -1) e.energy[i] -= 0.4;
      }

      // 死亡判定。
      if (e.energy[i] <= 0 || e.age[i] > P.maxAge[type]) {
        e.kill(i);
      }
    }
  };

  // (tx,ty) の周囲±2タイルで最も近い食べられるタイル方向を返す。
  CreatureSystem.prototype._seekFood = function (world, tx, ty) {
    const W = world.width;
    const H = world.height;
    let bx = 0;
    let by = 0;
    let bestD = 1e9;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (tile.isEdible(world.terrain[ny * W + nx])) {
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            bx = dx;
            by = dy;
          }
        }
      }
    }
    return { x: bx, y: by };
  };

  Game.CreatureSystem = CreatureSystem;
})(window.Game);
