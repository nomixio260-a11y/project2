// 生物シミュレーション。固定タイムステップ tick(world) で動く。
// 草食: 植生を採食しエネルギー回復→繁殖。肉食: 草食を捕食。
// 餓死・寿命・溺死で死亡。空間グリッドで近傍探索を O(N) に保つ。
(function (Game) {
  "use strict";

  const S = Game.SPECIES;
  const tile = Game.tile;

  // パラメータ（1ティック=シム内100ms 基準）。
  const P = {
    // 捕食者は「稀で頑健・繁殖は遅い」頂点捕食者として設計する。獲物を絶やさず、
    // かつ過剰増殖もしない少数の安定層が、被食者を緩やかに調整して共存する。
    metabolism: [0.008, 0.0052], // 基礎代謝（肉食は低燃費＝狩りの間隔があいても飢えにくい）
    speed: [0.25, 0.31], // タイル/ティック（肉食はやや速い）
    huntRadius: 7, // 肉食が獲物を探す半径
    grazeGainScale: 0.95, // 採食量(fertility)→エネルギーの変換係数
    grazeGain: 0.06, // 植生システム未接続時のフォールバック回復
    preyGain: 0.8, // 捕食でのエネルギー回復（1度の狩りで長く保つ）
    catchChance: 0.45, // 接近しても狩りが成功する確率（残りは取り逃がす＝被食者の避難余地）
    satiation: 0.82, // 飽食した捕食者は狩らない（捕食を「必要分」に抑え乱獲を防ぐ最重要要素）
    reproduceAt: [0.8, 0.9], // この energy で繁殖（肉食は満腹時のみ＝過剰増殖を抑える）
    reproduceChance: [0.045, 0.012], // 繁殖確率（草食は旺盛で捕食を支え、肉食は稀）
    reproCost: [0.4, 0.5], // 繁殖で失うエネルギー
    herbReproFert: 0.4, // 草食はこの肥沃度未満では繁殖を控える（過放牧と暴落を抑える）
    offspringEnergy: 0.36,
    maxAge: [1200, 2900],
    eatRadius: 0.7, // 肉食の捕食到達距離
    thirstRate: 0.0025, // 1ティックの渇きの進行
    dehydration: 0.008, // 渇き限界でのエネルギー消耗
    thirstSeek: 0.45, // この渇きで水を探し始める
    geneMutate: 0.06, // 遺伝子の変異幅
    fleeRadius: 3.2, // 草食が捕食者に気づいて逃げ出す距離（近づくまで気づかない）
    fleeBoost: 1.12, // 逃走時の速度倍率（パニック）
    chaseBoost: 1.45, // 肉食が獲物を追うときの速度倍率（しっかり捕らえる）
    youngAge: 140, // この齢未満は「仔」（描画が小さい）
    herdRadius: 5,   // 草食が群れの仲間を探す距離
    herdSpacing: 1.6, // これより近ければ寄らない（密集しすぎない）
  };

  // 遺伝子を継承（軽い変異つき、0.7..1.3 にクランプ）。
  function mutate(rand, gene) {
    let g = gene + (rand() - 0.5) * 2 * P.geneMutate;
    if (g < 0.7) g = 0.7; else if (g > 1.3) g = 1.3;
    return g;
  }

  function CreatureSystem(entities, world, renderer) {
    this.entities = entities;
    this.world = world;
    this.renderer = renderer;
    this.rand = Game.utils.mulberry32((Game.config.seed ^ 0x1234abcd) >>> 0);

    // 空間グリッド（近傍探索用）。種別ごとに別の連結リストを持つことで、
    // 「捕食者を探す」走査が密集した草食の鎖を辿らずに済む（探索コストを大幅に削減）。
    this.cell = 4; // 1セル=4タイル
    this.gw = Math.ceil(world.width / this.cell);
    this.gh = Math.ceil(world.height / this.cell);
    this.ncells = this.gw * this.gh;
    this.head = new Int32Array(this.ncells * 2).fill(-1); // [type0 セル..., type1 セル...]
    this.nextLink = new Int32Array(entities.capacity);
  }

  CreatureSystem.prototype.setWorld = function (world) {
    this.world = world;
    this.gw = Math.ceil(world.width / this.cell);
    this.gh = Math.ceil(world.height / this.cell);
    this.ncells = this.gw * this.gh;
    this.head = new Int32Array(this.ncells * 2).fill(-1);
  };

  // 生存個体を種別ごとのグリッドに登録。
  CreatureSystem.prototype._buildGrid = function () {
    const e = this.entities;
    const head = this.head;
    head.fill(-1);
    const cell = this.cell;
    const gw = this.gw;
    const nc = this.ncells;
    const next = this.nextLink;
    const ex = e.x, ey = e.y, et = e.type, alive = e.alive;
    for (let i = 0; i < e.count; i++) {
      if (!alive[i]) continue;
      const cx = (ex[i] / cell) | 0;
      const cy = (ey[i] / cell) | 0;
      const c = (et[i] === 0 ? 0 : nc) + cy * gw + cx; // 種別でオフセット
      next[i] = head[c];
      head[c] = i;
    }
  };

  // (px,py) 近傍で type に一致する最も近い個体を radius 内で探す。除外 self。
  // type の連結リストのみを辿るため、対象種が少なければ非常に速い。
  CreatureSystem.prototype._nearest = function (px, py, type, radius, self) {
    const e = this.entities;
    const cell = this.cell;
    const gw = this.gw;
    const gh = this.gh;
    const r = (radius / cell + 0.999) | 0;
    const cx = (px / cell) | 0;
    const cy = (py / cell) | 0;
    const base = type === 0 ? 0 : this.ncells;
    const head = this.head, next = this.nextLink, ex = e.x, ey = e.y, alive = e.alive;
    let best = -1;
    let bestD = radius * radius;
    let gy0 = cy - r; if (gy0 < 0) gy0 = 0;
    let gy1 = cy + r; if (gy1 >= gh) gy1 = gh - 1;
    let gx0 = cx - r; if (gx0 < 0) gx0 = 0;
    let gx1 = cx + r; if (gx1 >= gw) gx1 = gw - 1;
    for (let gy = gy0; gy <= gy1; gy++) {
      const row = base + gy * gw;
      for (let gx = gx0; gx <= gx1; gx++) {
        let i = head[row + gx];
        while (i !== -1) {
          if (i !== self && alive[i]) { // 種別はリスト分離済み。途中で死んだ個体だけ除外
            const dx = ex[i] - px;
            const dy = ey[i] - py;
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = i; }
          }
          i = next[i];
        }
      }
    }
    return best;
  };

  // 外部（文明の狩り）から最寄りの動物を引く公開API。grid は creature tick で更新済み。
  CreatureSystem.prototype.nearestAnimal = function (px, py, type, radius) {
    return this._nearest(px, py, type, radius, -1);
  };

  CreatureSystem.prototype.tick = function (world) {
    const e = this.entities;
    const rand = this.rand;
    const W = world.width;
    const H = world.height;
    const maxEntities = Game.config.sim.maxEntities;
    // ホットループで繰り返す world のフィールド参照を局所化（プロパティ解決を削減）。
    const terrain = world.terrain, fertArr = world.fertility;

    this._buildGrid();

    // 長期気候: 寒冷な時代は基礎代謝が上がり（寒さに耐えるため）個体数が抑えられる。
    const clk = Game.state.clock;
    const coldF = 1 + Math.max(0, -(clk ? (clk.warmth || 0) : 0)) * 0.5;
    // 群れ凝集を間引くための位相（4ティックで一巡）。
    this._tickN = (this._tickN || 0) + 1;
    const herdPhase = this._tickN & 3;
    // 植生システムの参照をループ外で1回だけ解決（毎個体の lookup を避ける）。
    const veg = Game.state.vegetation;
    const vegOK = !!(veg && veg.world === world);

    const n = e.count; // 今ティックの個体のみ処理（新生は次ティック）
    for (let i = 0; i < n; i++) {
      if (!e.alive[i]) continue;
      const type = e.type[i];

      const gene = e.gene[i] || 1;       // 体格
      const gSpd = e.geneSpd[i] || 1;    // 俊敏
      const gSense = e.geneSense[i] || 1; // 感覚
      e.age[i] += 1;
      e.energy[i] -= P.metabolism[type] * (0.6 + 0.4 * gene) * coldF; // 大型ほど・寒冷ほど燃費が悪い

      const tx = e.x[i] | 0;
      const ty = e.y[i] | 0;
      const idx = ty * W + tx;
      const here = terrain[idx];

      // 溺死（陸生が深海に出た）。
      if (here === Game.TERRAIN.DEEP_WATER) {
        e.energy[i] -= 0.08;
      }

      // 渇き: 進行し、岸（浅瀬隣接）で飲んでリセット。限界で消耗。
      // 渇きの進行は緩やかなので、岸の確認（3x3走査）は4ティックに1回に間引く。
      e.thirst[i] += P.thirstRate;
      if (((i + this._tickN) & 3) === 0 && this._nearWater(world, tx, ty)) {
        e.thirst[i] = 0;
      } else if (e.thirst[i] > 0.85) {
        e.energy[i] -= P.dehydration;
        if (e.thirst[i] > 1) e.thirst[i] = 1;
      }

      let dirX = 0;
      let dirY = 0;
      let fleeing = false;
      let chasing = false;

      // 渇きが強ければ水を最優先で探す。
      if (e.thirst[i] > P.thirstSeek) {
        const wseek = this._seekWater(world, tx, ty);
        dirX = wseek.x;
        dirY = wseek.y;
      }

      if (type === S.HERBIVORE) {
        // 捕食者から逃げる（採食・渇きより最優先＝生存本能）。感覚が鋭いほど早く気づく。
        const pred = this._nearest(e.x[i], e.y[i], S.PREDATOR, P.fleeRadius * (0.6 + 0.4 * gSense), -1);
        if (pred !== -1) {
          const dx = e.x[i] - e.x[pred];
          const dy = e.y[i] - e.y[pred];
          const dl = Math.sqrt(dx * dx + dy * dy) || 1;
          dirX = dx / dl; dirY = dy / dl;
          fleeing = true;
        }
        // 採食（植生 fertility を消費。未接続時はフォールバック）。
        if (tile.isEdible(here)) {
          if (vegOK) {
            const eaten = veg.graze(idx);
            if (eaten > 0) e.energy[i] = Math.min(1, e.energy[i] + eaten * P.grazeGainScale);
          } else {
            e.energy[i] = Math.min(1, e.energy[i] + P.grazeGain);
          }
        }
        // 逃走中でなく、空腹かつ水も探していないなら、食べられるタイルへ寄る。
        if (!fleeing && dirX === 0 && dirY === 0 && e.energy[i] < 0.6) {
          const f = this._seekFood(world, tx, ty);
          dirX = f.x;
          dirY = f.y;
        }
        // 群れ行動: 逃走・採食でなく満ち足りているときは仲間に寄り集まる
        // （数の安全）。緩やかな凝集なので個体ごとに4ティックに1回だけ評価して負荷を抑える。
        if (!fleeing && dirX === 0 && dirY === 0 && ((e.age[i] + i) & 3) === herdPhase) {
          const mate = this._nearest(e.x[i], e.y[i], S.HERBIVORE, P.herdRadius, i);
          if (mate !== -1) {
            const dx = e.x[mate] - e.x[i], dy = e.y[mate] - e.y[i];
            const dl = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dl > P.herdSpacing) { dirX = dx / dl * 0.6; dirY = dy / dl * 0.6; }
          }
        }
      } else if (dirX === 0 && dirY === 0 && e.energy[i] < P.satiation) {
        // 肉食: 満腹でないときだけ近くの草食を追って捕食する。感覚が鋭いほど遠くの獲物に気づく。
        // 飽食した捕食者は獲物を見過ごす＝捕食を必要分に抑え、被食者の乱獲・崩壊を防ぐ。
        const prey = this._nearest(e.x[i], e.y[i], S.HERBIVORE, P.huntRadius * (0.6 + 0.4 * gSense), i);
        if (prey !== -1) {
          const dx = e.x[prey] - e.x[i];
          const dy = e.y[prey] - e.y[i];
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= P.eatRadius) {
            // 多くの狩りは失敗する（獲物の警戒・逃げ足＝避難の余地）。これが
            // 捕食圧を和らげ、被食者を絶滅させずに捕食者と共存させる安定化要素。
            // 体格の大きな捕食者ほど仕留めやすい（体格遺伝子への選択圧）。
            if (rand() < P.catchChance * (0.6 + 0.4 * gene)) {
              e.kill(prey);
              e.energy[i] = Math.min(1, e.energy[i] + P.preyGain);
            }
          } else {
            dirX = dx / dist;
            dirY = dy / dist;
            chasing = true;
          }
        }
      }

      // 徘徊（食料方向が無ければランダム）。
      if (dirX === 0 && dirY === 0) {
        dirX = rand() - 0.5;
        dirY = rand() - 0.5;
      }
      const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
      let sp = P.speed[type] * (0.7 + 0.3 * gene) * (0.7 + 0.3 * gSpd); // 体格＋俊敏で速度が決まる
      if (fleeing) sp *= P.fleeBoost;   // 逃走で加速
      if (chasing) sp *= P.chaseBoost;  // 追跡で加速（獲物を捕らえる）
      const stepX = (dirX / len) * sp;
      const stepY = (dirY / len) * sp;
      e.heading[i] = Math.atan2(stepY, stepX); // 描画の向き
      let nxp = e.x[i] + stepX;
      let nyp = e.y[i] + stepY;
      // 水へ踏み込まない（陸生）。境界もクランプ。
      const ntx = Game.utils.clamp(nxp | 0, 0, W - 1);
      const nty = Game.utils.clamp(nyp | 0, 0, H - 1);
      if (!tile.isWater(terrain[nty * W + ntx])) {
        e.x[i] = Game.utils.clamp(nxp, 0, W - 1);
        e.y[i] = Game.utils.clamp(nyp, 0, H - 1);
      }

      // 繁殖。新個体は次ティックの _buildGrid で登録される
      // （ここでグリッドへ挿し込むと、解放スロット再利用時に
      //  リンクリストが循環し _nearest が無限ループするため挿さない）。
      // 多産遺伝子(geneFert)が高いほど繁殖しやすい（多産戦略への選択圧）。
      let canRepro = e.energy[i] > P.reproduceAt[type] && e.live < maxEntities &&
        rand() < P.reproduceChance[type] * (0.6 + 0.4 * (e.geneFert[i] || 1));
      // 草食は局所の食料(fertility)が乏しいと繁殖を控える（密度依存で暴走を防ぐ）。
      if (canRepro && type === S.HERBIVORE && vegOK && fertArr[idx] < P.herbReproFert) canRepro = false;
      if (canRepro) {
        // 4つの遺伝子をそれぞれ継承＋変異させて子に渡す（多形質の進化）。
        const child = e.spawn(type, e.x[i], e.y[i], P.offspringEnergy,
          mutate(rand, gene), mutate(rand, gSpd), mutate(rand, gSense), mutate(rand, e.geneFert[i] || 1));
        if (child !== -1) e.energy[i] -= P.reproCost[type];
      }

      // 死亡判定。
      if (e.energy[i] <= 0 || e.age[i] > P.maxAge[type]) {
        e.kill(i);
      }
    }
  };

  // (tx,ty) が水（浅瀬/深海）に隣接していれば true（飲水判定）。
  CreatureSystem.prototype._nearWater = function (world, tx, ty) {
    const W = world.width;
    const H = world.height;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = ty + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = tx + dx;
        if (nx < 0 || nx >= W) continue;
        if (tile.isWater(world.terrain[ny * W + nx])) return true;
      }
    }
    return false;
  };

  // (tx,ty) の周囲±3タイルで最も近い水タイル方向を返す（無ければ {0,0}）。
  CreatureSystem.prototype._seekWater = function (world, tx, ty) {
    const W = world.width;
    const H = world.height;
    let bx = 0;
    let by = 0;
    let bestD = 1e9;
    for (let dy = -3; dy <= 3; dy++) {
      const ny = ty + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -3; dx <= 3; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = tx + dx;
        if (nx < 0 || nx >= W) continue;
        if (tile.isWater(world.terrain[ny * W + nx])) {
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
  CreatureSystem.P = P; // チューニング/検証用にパラメータを公開（挙動はこの参照を使う）
})(window.Game);
