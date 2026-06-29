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
    mateRadius: 4,   // 繁殖時に配偶者を探す距離（有性生殖）
    mateMinEnergy: 0.5, // 配偶者がこのエネルギー以上なら繁殖できる
    thinkEvery: 2, // 重い近傍探索の間隔(ティック)。大きいほど低負荷（移動・採食・捕食は毎ティック）
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
    // 行動キャッシュ: 重い近傍探索を間引くため、対象（捕食対象/脅威）と意図方向を保持する。
    this.ct = new Int32Array(entities.capacity).fill(-1);
    this.cdx = new Float32Array(entities.capacity);
    this.cdy = new Float32Array(entities.capacity);
    this.cflag = new Uint8Array(entities.capacity);
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

    // 気候・季節と生態: 寒い季節・寒冷期ほど基礎代謝が上がって飢えやすく（冬枯れ）、暑い
    //   ほど渇きが早まる（夏は水場へ集まる）。これで個体数に季節の波が生まれる（現実の生態）。
    const clk = Game.state.clock;
    const seasonOff = (clk && clk.season) ? (clk.season.tempOffset || 0) : 0;
    const effWarmth = (clk ? (clk.warmth || 0) : 0) + seasonOff;
    // 種で寒さへの強さが違う: 肉食(毛皮・高活動)は寒さに比較的強く、草食はより堪える。
    const coldNeg = Math.max(0, -effWarmth);
    const coldF = 1 + coldNeg * 0.45;                    // 草食基準の寒さ燃費
    const coldFp = 1 + coldNeg * 0.28;                   // 肉食は寒さに比較的強い
    const thirstMul = 1 + Math.max(0, effWarmth) * 0.8;  // 暑いほど渇きが早い
    const tickN = this._tickN = (this._tickN || 0) + 1;
    // 植生・炎システムの参照をループ外で1回だけ解決（毎個体の lookup を避ける）。
    const veg = Game.state.vegetation;
    const vegOK = !!(veg && veg.world === world);
    const fireSys = Game.state.fire;
    const fireActive = !!(fireSys && fireSys.world === world && fireSys.active.length > 0);
    const burnArr = fireActive ? fireSys.burn : null;
    // ホットループ用に TypedArray 参照を局所化。
    const ex = e.x, ey = e.y, et = e.type, energy = e.energy, alive = e.alive, thirst = e.thirst, ageA = e.age;
    const ct = this.ct, cdx = this.cdx, cdy = this.cdy, cfl = this.cflag;
    const THH = P.thinkEvery | 0 || 1; // 草食の探索間引き（多数派）。肉食は少数なので毎ティック探索する
    const DW = Game.TERRAIN.DEEP_WATER;
    const clampF = Game.utils.clamp;
    const PI = Math.PI, Wm = W - 1, Hm = H - 1;

    const n = e.count; // 今ティックの個体のみ処理（新生は次ティック）
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const type = et[i];
      const gene = e.gene[i] || 1;       // 体格
      const gSpd = e.geneSpd[i] || 1;    // 俊敏
      const gSense = e.geneSense[i] || 1; // 感覚
      ageA[i] += 1;
      energy[i] -= P.metabolism[type] * (0.6 + 0.4 * gene) * (type === 0 ? coldF : coldFp); // 大型ほど・寒冷ほど燃費が悪い（肉食は寒さに強い）

      const tx = ex[i] | 0, ty = ey[i] | 0;
      const idx = ty * W + tx;
      const here = terrain[idx];

      // 溺死（陸生が深海に出た）。
      if (here === DW) energy[i] -= 0.08;
      // 炎に巻かれると消耗する。
      if (burnArr && burnArr[idx] > 0) energy[i] -= 0.06;

      // 渇き: 進行し（暑いほど早い）、岸（浅瀬隣接）で飲んでリセット。限界で消耗。
      thirst[i] += P.thirstRate * thirstMul;
      if (((i + tickN) & 3) === 0 && this._nearWater(world, tx, ty)) thirst[i] = 0;
      else if (thirst[i] > 0.85) { energy[i] -= P.dehydration; if (thirst[i] > 1) thirst[i] = 1; }

      // 採食: 草食は足下が食べられるタイルなら毎ティック草を食む。
      if (type === S.HERBIVORE && tile.isEdible(here)) {
        if (vegOK) { const eaten = veg.graze(idx); if (eaten > 0) energy[i] = Math.min(1, energy[i] + eaten * P.grazeGainScale); }
        else energy[i] = Math.min(1, energy[i] + P.grazeGain);
      }

      // ---- 重い近傍探索は thinkEvery ティックに1回だけ（位相分散）。対象・意図をキャッシュ ----
      // 移動・採食・捕食の判定そのものは毎ティック行うため、挙動はほぼ保たれる。
      const th = type === S.PREDATOR ? 1 : THH; // 肉食は毎ティック（捕食を保つ）、草食は間引く
      if (((i + tickN) % th) === 0) {
        let tgt = -1, fx = 0, fy = 0, panic = 0;
        if (type === S.HERBIVORE) {
          // 炎から逃げる（最優先）。
          if (fireActive) { const ff = this._fleeFire(world, tx, ty, burnArr); if (ff) { panic = 1; fx = ff.x; fy = ff.y; } }
          if (!panic) {
            // 捕食者の探知（脅威の index をキャッシュ。方向は毎ティック再計算で機敏に逃げる）。
            tgt = this._nearest(ex[i], ey[i], S.PREDATOR, P.fleeRadius * (0.6 + 0.4 * gSense), -1);
            if (tgt === -1) {
              // 脅威が無ければ意図を決める: 渇き(水が見つかれば)＞採食＞群れ＞徘徊。
              if (thirst[i] > P.thirstSeek) { const w = this._seekWater(world, tx, ty); fx = w.x; fy = w.y; }
              if (fx === 0 && fy === 0 && energy[i] < 0.6) { const f = this._seekFood(world, tx, ty); fx = f.x; fy = f.y; }
              if (fx === 0 && fy === 0) {
                const m = this._nearest(ex[i], ey[i], S.HERBIVORE, P.herdRadius, i);
                if (m !== -1) { const dx = ex[m] - ex[i], dy = ey[m] - ey[i], dl = Math.sqrt(dx * dx + dy * dy) || 1; if (dl > P.herdSpacing) { fx = dx / dl * 0.6; fy = dy / dl * 0.6; } }
              }
            }
          }
        } else {
          // 肉食: 渇いて水が見つかれば水を優先。さもなくば満腹でない限り獲物を探す。
          // （水が近くに無い渇いた捕食者も狩りは続ける＝原行動。これが無いと餓死する。）
          if (thirst[i] > P.thirstSeek) { const w = this._seekWater(world, tx, ty); fx = w.x; fy = w.y; }
          if (fx === 0 && fy === 0 && energy[i] < P.satiation) { tgt = this._nearest(ex[i], ey[i], S.HERBIVORE, P.huntRadius * (0.6 + 0.4 * gSense), i); }
        }
        ct[i] = tgt; cdx[i] = fx; cdy[i] = fy; cfl[i] = panic;

        // 繁殖（探索を伴うため think 時のみ。頻度を TH 倍して総繁殖率を保つ）。
        let canRepro = energy[i] > P.reproduceAt[type] && e.live < maxEntities &&
          rand() < P.reproduceChance[type] * (0.6 + 0.4 * (e.geneFert[i] || 1)) * th;
        if (canRepro && type === S.HERBIVORE && vegOK && fertArr[idx] < P.herbReproFert) canRepro = false;
        if (canRepro) {
          const mate = this._nearest(ex[i], ey[i], type, P.mateRadius, i);
          if (mate !== -1 && energy[mate] > P.mateMinEnergy) {
            const child = e.spawn(type, ex[i], ey[i], P.offspringEnergy,
              mutate(rand, (gene + (e.gene[mate] || 1)) * 0.5),
              mutate(rand, (gSpd + (e.geneSpd[mate] || 1)) * 0.5),
              mutate(rand, (gSense + (e.geneSense[mate] || 1)) * 0.5),
              mutate(rand, ((e.geneFert[i] || 1) + (e.geneFert[mate] || 1)) * 0.5));
            if (child !== -1) { energy[i] -= P.reproCost[type]; energy[mate] -= P.reproCost[type] * 0.5; if (child < ct.length) ct[child] = -1; }
          }
        }
      }

      // ---- 毎ティックの行動解決（キャッシュした対象・意図から方向を定める）----
      let dirX = 0, dirY = 0, fleeing = false, chasing = false;
      const tg = ct[i];
      if (type === S.HERBIVORE) {
        if (cfl[i]) { dirX = cdx[i]; dirY = cdy[i]; fleeing = true; }              // 炎から逃走
        else if (tg >= 0 && alive[tg]) {
          // 捕食者から逃走（距離は毎ティック確認し、脅威が範囲外へ離れたら通常行動に戻る）。
          const dx = ex[i] - ex[tg], dy = ey[i] - ey[tg], d2 = dx * dx + dy * dy;
          const fr = P.fleeRadius * (0.6 + 0.4 * gSense);
          if (d2 < fr * fr) { const dl = Math.sqrt(d2) || 1; dirX = dx / dl; dirY = dy / dl; fleeing = true; }
          else { dirX = cdx[i]; dirY = cdy[i]; }
        }
        else { dirX = cdx[i]; dirY = cdy[i]; }                                      // 採食・群れ・徘徊
      } else {
        if (tg >= 0 && alive[tg] && energy[i] < P.satiation) {
          const dx = ex[tg] - ex[i], dy = ey[tg] - ey[i], dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= P.eatRadius) {
            // 多くの狩りは失敗する（被食者の避難余地＝共存の安定化）。体格で成否が変わる。
            if (rand() < P.catchChance * (0.6 + 0.4 * gene)) { e.kill(tg); energy[i] = Math.min(1, energy[i] + P.preyGain); ct[i] = -1; }
          } else { dirX = dx / dist; dirY = dy / dist; chasing = true; }
        } else { dirX = cdx[i]; dirY = cdy[i]; }
      }

      // 徘徊（目的の意図が無ければ毎ティック軽くランダムに動く＝原行動に近い拡散）。
      if (dirX === 0 && dirY === 0) { dirX = rand() - 0.5; dirY = rand() - 0.5; }
      if (dirX !== 0 || dirY !== 0) {
        const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
        let sp = P.speed[type] * (0.7 + 0.3 * gene) * (0.7 + 0.3 * gSpd);
        if (fleeing) sp *= P.fleeBoost;
        if (chasing) sp *= P.chaseBoost;
        const stepX = (dirX / len) * sp, stepY = (dirY / len) * sp;
        // 向きは左右の判定のみに使う（renderer は cos(heading)<0 で左向き）。atan2 を避ける。
        e.heading[i] = stepX < 0 ? PI : 0;
        let nxp = ex[i] + stepX, nyp = ey[i] + stepY;
        if (nxp < 0) nxp = 0; else if (nxp > Wm) nxp = Wm;
        if (nyp < 0) nyp = 0; else if (nyp > Hm) nyp = Hm;
        if (!tile.isWater(terrain[(nyp | 0) * W + (nxp | 0)])) { ex[i] = nxp; ey[i] = nyp; }
      }

      // 死亡判定。
      if (energy[i] <= 0 || ageA[i] > P.maxAge[type]) e.kill(i);
    }
    // 個体数が激減した後の無駄な空走査を抑えるため、時折ストアの末尾を切り詰める。
    if ((tickN & 127) === 0) e.trim();
    // 辺境からの移入で生態系を長期に保つ（負荷を避け約500ティックに1回）。
    if (tickN % 503 === 0) this._replenish(world);
  };

  // 辺境からの移入・再導入: 長い時間で乱獲・過放牧により野生が絶滅しても、世界の外から
  // 動物が移り住み生態系が保たれる。獲物が十分なら捕食者も戻り、捕食-被食の循環が続く。
  CreatureSystem.prototype._replenish = function (world) {
    const e = this.entities, W = world.width, H = world.height, rand = this.rand;
    const cap = Game.config.sim.maxEntities, owner = world.owner;
    let herb = 0, pred = 0;
    for (let i = 0; i < e.count; i++) { if (!e.alive[i]) continue; if (e.type[i] === 0) herb++; else pred++; }
    const self = this;
    function wildSpot() {
      for (let t = 0; t < 30; t++) { const x = (rand() * W) | 0, y = (rand() * H) | 0, i = y * W + x;
        if (tile.isEdible(world.terrain[i]) && (!owner || owner[i] === 0)) return { x: x, y: y }; }
      return null;
    }
    // 生態系の均衡個体数は地形（可食地）で決まり、生物の格納上限(maxEntities)よりずっと小さい。
    //   再導入のしきい値を maxEntities 基準にすると現実の個体数では永遠に発火しない（捕食者が
    //   絶滅したまま戻らない）。実際の草食数に対する絶対的な目安で判定する。
    // 草食の移入（少なくなったら辺境に小さな群れが現れる）。
    if (herb < Math.min(cap * 0.015, 120)) {
      const sp = wildSpot();
      if (sp) for (let k = 0; k < 12; k++) e.spawn(S.HERBIVORE, sp.x + 0.5 + (rand() - 0.5) * 3, sp.y + 0.5 + (rand() - 0.5) * 3, 0.6);
    }
    // 捕食者の再導入: 獲物が一定数いて捕食者がほぼ絶えていれば、辺境から番（つがい）が移り住む。
    //   低密度では伴侶を見つけられず自然回復できないため、互いに近い小群で導入し再興を促す。
    if (pred < 2 && herb >= 24 && rand() < 0.6) {
      const sp = wildSpot();
      if (sp) for (let k = 0; k < 5; k++) e.spawn(S.PREDATOR, sp.x + 0.5 + (rand() - 0.5) * 2, sp.y + 0.5 + (rand() - 0.5) * 2, 0.9);
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

  // (tx,ty) の周囲±4タイルで最も近い燃焼タイルを探し、そこから「離れる」方向を返す。
  // 近くに火が無ければ null（呼び出し側は延焼中のみ呼ぶ）。
  CreatureSystem.prototype._fleeFire = function (world, tx, ty, burn) {
    const W = world.width, H = world.height, R = 4;
    let bx = 0, by = 0, bestD = 1e9;
    for (let dy = -R; dy <= R; dy++) {
      const ny = ty + dy;
      if (ny < 0 || ny >= H) continue;
      const row = ny * W;
      for (let dx = -R; dx <= R; dx++) {
        const nx = tx + dx;
        if (nx < 0 || nx >= W) continue;
        if (burn[row + nx] > 0) {
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; bx = dx; by = dy; }
        }
      }
    }
    if (bestD === 1e9) return null; // 近くに火は無い
    const dl = Math.sqrt(bestD) || 1;
    return { x: -bx / dl, y: -by / dl }; // 火から離れる向き
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
