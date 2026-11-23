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
    const clk = Game.state.clock;
    const warmth = clk ? (clk.warmth || 0) : 0;
    const wetness = clk ? (clk.wetness || 0) : 0;
    const season = clk && clk.season;

    if (rand() < 0.03) this._eruption(world);
    if (rand() < 0.03) this._earthquake(world);
    // 干ばつ: 夏に加え、乾燥・温暖な気候の時代ほど起きやすい（気候→災害の因果）。
    const droughtChance = (season && season.name === "夏" ? 0.04 : 0.005) +
      Math.max(0, -wetness) * 0.10 + Math.max(0, warmth) * 0.04;
    if (rand() < droughtChance) this._drought(world);
    // 洪水: 多雨の時代ほど起きやすい。沿岸・低地を浸し、田畑を肥やしつつ犠牲も出す。
    if (wetness > 0.08 && rand() < wetness * 0.18) this._flood(world);
  };

  // 火山噴火: 山岳タイルを中心に、規模に応じて溶岩・降灰・延焼が広がる。噴火は火山錐を
  //   成長させ（標高上昇）、降灰は周囲の土を痩せさせ乾かす。大噴火ほど火山の冬を招く。
  DisasterSystem.prototype._eruption = function (world) {
    const W = world.width, H = world.height, rand = this.rand;
    const tile = Game.tile, T = Game.TERRAIN;
    let ex = -1, ey = -1;
    for (let s = 0; s < 40; s++) {
      const x = (rand() * W) | 0, y = (rand() * H) | 0;
      if (world.terrain[y * W + x] === T.MOUNTAIN) { ex = x; ey = y; break; }
    }
    if (ex < 0) return;
    // 規模(VEI 風): 小噴火が大半、稀に大噴火（rand^3 で裾の重い分布）。
    const mag = rand() * rand() * rand();          // 0..1（小さいほど多い）
    const R = 2 + Math.round(mag * 5);             // 影響半径 2..7
    const fire = Game.state.fire;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = ex + dx, y = ey + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const d = dx * dx + dy * dy;
        if (d > R * R) continue;
        const i = y * W + x, ter = world.terrain[i];
        const core = d <= 2.2;
        if (core && tile.isLand(ter)) {
          world.terrain[i] = T.SCORCHED;           // 溶岩流＝焼け地
          if (world.moisture) world.moisture[i] = 0.05;
          if (this.renderer) this.renderer.markDirty(x, y);
        } else if (tile.isFlammable(ter)) {
          if (fire && fire.ignite) fire.ignite(x, y); // 噴石・熱で延焼
        }
        // 降灰: 火口周縁の土を痩せさせ、乾かす（灰は一時的に保水を奪う）。
        if (!core && tile.isLand(ter)) {
          if (world.fertility) world.fertility[i] *= 0.6;
          if (world.moisture) world.moisture[i] *= 0.8;
        }
      }
    }
    // 火山錐の成長: 噴出物が火口を高くする（標高上昇→地形が険しくなる。地形は静的でない）。
    if (world.raise) {
      world.raise(ex, ey, 0.04 + mag * 0.08);
      this._reclass(world, ex, ey, 1);
    }
    const big = mag > 0.55;
    this._log("🌋 " + this._place(world, ex, ey) + "で" + (big ? "大規模な" : "") + "火山が噴火した");
    // 大噴火だけが「火山の冬」を招く（成層圏まで噴煙が届く規模）。従来は小噴火でも2割以上が
    //   火山の冬を起こし、山の多い世界では冷え込み（半減期 約2年）が明ける前に次が来て、
    //   世界がほぼ常に冬だった。噴火そのものの頻度は変えず、気候を揺るがすのは大噴火だけに。
    const clk = Game.state.clock;
    if (clk && mag > 0.4 && rand() < 0.35 + mag * 0.6) {
      clk.coolShock = Math.min(0.5, (clk.coolShock || 0) + 0.12 + mag * 0.3);
      this._log("🌋❄ 噴煙が空を覆い、火山の冬が世界を冷え込ませた");
    }
  };

  // 標高が変わったタイル周辺の地形を再分類する（断層・火山錐で地形が動いたとき）。
  DisasterSystem.prototype._reclass = function (world, cx, cy, r) {
    const W = world.width, H = world.height, tile = Game.tile;
    if (!tile.classify) return;
    const th = Game.config.thresholds;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        const nt = tile.classify(world.elevation[i], world.moisture[i], world.temperature[i], th);
        if (nt !== world.terrain[i]) { world.terrain[i] = nt; if (this.renderer) this.renderer.markDirty(x, y); }
      }
    }
  };

  // 洪水: 水は低きへ流れる。起点から、増水位より低い陸地を辿って氾濫し（＝谷・低地が浸る）、
  //   肥沃な泥(silt)を残しつつ、浸かった土地の住民に犠牲を出す（恵みと災いの両面）。
  DisasterSystem.prototype._flood = function (world, srcX, srcY) {
    const W = world.width, H = world.height, rand = this.rand;
    const tile = Game.tile, T = Game.TERRAIN;
    let cx = srcX, cy = srcY;
    if (cx === undefined) { // 起点未指定なら浅瀬を探す
      cx = -1;
      for (let s = 0; s < 40; s++) {
        const x = (rand() * W) | 0, y = (rand() * H) | 0;
        if (world.terrain[y * W + x] === T.SHALLOW_WATER) { cx = x; cy = y; break; }
      }
      if (cx < 0) return;
    }
    // 増水位: 起点標高＋高潮。これより低い陸地を辿って水が広がる。
    const floodLevel = world.elevation[cy * W + cx] + 0.025 + rand() * 0.04;
    const maxTiles = 600;
    const seen = new Set();
    const queue = [cy * W + cx];
    seen.add(cy * W + cx);
    const flooded = [];
    let qi = 0;
    while (qi < queue.length && flooded.length < maxTiles) {
      const i = queue[qi++];
      const x = i % W, y = (i / W) | 0;
      const nb = [i - 1, i + 1, i - W, i + W];
      for (let n = 0; n < 4; n++) {
        const j = nb[n];
        if (j < 0 || j >= W * H || seen.has(j)) continue;
        const jx = j % W;
        if (Math.abs(jx - x) > 1) continue;        // 横の巻き込み防止
        seen.add(j);
        const ter = world.terrain[j];
        if (tile.isWater(ter)) { queue.push(j); continue; } // 水は伝う
        if (tile.isLand(ter) && world.elevation[j] <= floodLevel) {
          flooded.push(j); queue.push(j);
        }
      }
    }
    for (let n = 0; n < flooded.length; n++) {
      const i = flooded[n];
      if (world.moisture) { const m = world.moisture[i] + 0.35; world.moisture[i] = m > 1 ? 1 : m; }
      if (world.fertility) { const f = world.fertility[i] + 0.15; world.fertility[i] = f > 1 ? 1 : f; } // 沃土
      if (this.renderer) this.renderer.markDirty(i % W, (i / W) | 0);
    }
    // 浸水域の住民に犠牲。
    const civ = Game.state.civ;
    if (civ && civ.people && flooded.length) {
      const fset = seen; // 浸水近傍
      let killed = 0;
      const people = civ.people;
      for (let p = 0; p < people.length; p++) {
        const o = people[p];
        if (!o.alive || !o.kid) continue;
        const oi = (o.y | 0) * W + (o.x | 0);
        if (!fset.has(oi)) continue;
        if (rand() < 0.1) { o.alive = false; if (civ._addMark) civ._addMark(o.x, o.y); if (++killed >= 12) break; }
      }
    }
    this._log("🌊 " + this._place(world, cx, cy) + "で洪水が起きた（" + flooded.length + "タイルが冠水、沃土を残した）");
  };

  // 地震: 断層の応力が解放される。震源は起伏の大きい（断層帯らしい）土地を選び、規模に
  //   応じて地盤がずれ（標高変動→地形変化）、建物が倒壊し住民に犠牲が出る。大地震は余震を
  //   伴い、沿岸では津波（洪水）を誘発しうる（規模→被害・地形・連鎖の因果）。
  //   (fx, fy, fmag) を渡すと震源と規模を指定して起こす（検証・演出用）。省略時は断層帯から選ぶ。
  DisasterSystem.prototype._earthquake = function (world, fx, fy, fmag) {
    const civ = Game.state.civ;
    const rand = this.rand, W = world.width, H = world.height, tile = Game.tile;
    // 震源: 断層帯（起伏の大きい土地・山地の縁）で起きる。従来は「最も断層に近い都市」を
    //   震源に選んでいたため、地震が毎回どこかの街を直撃していた。現実の地震は街の有無に関係なく
    //   断層で起き、たまたま近くにある街だけが被害を受ける。
    const T = Game.TERRAIN;
    const nearMountain = function (x, y) {
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const t = world.terrain[yy * W + xx];
        if (t === T.MOUNTAIN || t === T.SNOW) return true;
      }
      return false;
    };
    let ex = -1, ey = -1, best = -1;
    if (fx != null) { ex = fx; ey = fy; }
    else for (let s = 0; s < 48; s++) {
      const x = 2 + ((rand() * (W - 4)) | 0), y = 2 + ((rand() * (H - 4)) | 0);
      const i = y * W + x;
      if (!tile.isLand(world.terrain[i])) continue;
      // 断層帯らしさ: 周囲（半径2）の標高差。山地の縁のような急な起伏の帯ほど高い。
      let lo = 9, hi = -9;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const e = world.elevation[i + dy * W + dx];
        if (e < lo) lo = e; if (e > hi) hi = e;
      }
      const score = (hi - lo) * 3 + (nearMountain(x, y) ? 0.25 : 0) + rand() * 0.05;
      if (score > best) { best = score; ex = x; ey = y; }
    }
    if (ex < 0) return;
    const mag = fmag != null ? fmag : rand() * rand(); // 0..1（大半は小さい）
    const R = 4 + Math.round(mag * 8);             // 被害半径 4..12
    // 断層変位: 震源付近の地盤が上下にずれ、地形が変わる（地形は静的でない）。
    if (world.raise && mag > 0.3) {
      const shift = (rand() < 0.5 ? -1 : 1) * (0.03 + mag * 0.1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = ex + dx, y = ey + dy;
        if (x >= 0 && y >= 0 && x < W && y < H) world.raise(x, y, shift);
      }
      this._reclass(world, ex, ey, 2);
    }
    // 被害: 揺れは震源から遠ざかるほど弱まる。国を問わず、揺れの届く範囲の街はみな傷む
    //   （従来は震源の土地を持つ国の街だけが被害を受けていた）。
    let destroyed = 0, killed = 0, hitName = this._place(world, ex, ey);
    if (civ && civ.kingdoms) {
      const reach = R * 1.25;
      for (let id = 1; id < civ.kingdoms.length; id++) {
        const k = civ.kingdoms[id];
        if (!k || !k.alive || !k.cities) continue;
        let hit = 0;
        for (let ci = 0; ci < k.cities.length; ci++) {
          const city = k.cities[ci];
          const ddx = city.x - ex, ddy = city.y - ey, d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d > reach) continue;
          const inten = mag * (1 - d / reach);       // その街での揺れの強さ
          hit = Math.max(hit, inten);
          const nB = Math.round(inten * 5);          // 倒壊棟数は揺れの強さで増える
          if (city.buildings) for (let n = 0; n < nB && city.buildings.length; n++) {
            const idxs = [];
            for (let bi = 0; bi < city.buildings.length; bi++) if (city.buildings[bi].t !== 3) idxs.push(bi);
            if (!idxs.length) break;
            city.buildings.splice(idxs[(rand() * idxs.length) | 0], 1); destroyed++;
          }
          // 倒壊を免れた建物も揺れで傷む（状態が下がる＝後の維持で直す）。
          if (city.buildings) {
            for (let bi = 0; bi < city.buildings.length; bi++) {
              const b = city.buildings[bi];
              if (b.t === 3 || b.site) continue; // 砦は揺れに耐える。建設中は状態でなく倒壊で失う
              b.cond = Math.max(0, (b.cond == null ? 1 : b.cond) - 0.3 * inten);
            }
          }
          // 倒壊で建物が減れば都市の格も落ちる。
          if (civ._cityLevel) city.level = civ._cityLevel(city);
        }
        if (hit > 0) k.unrest = Math.min(100, (k.unrest || 0) + 4 + hit * 22);
      }
      const R2 = R * R, kcap = 4 + ((mag * 24) | 0), people = civ.people;
      for (let p = 0; p < people.length; p++) {
        const o = people[p];
        if (!o.alive || !o.kid) continue;
        const dx = o.x - ex, dy = o.y - ey, d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        const inten = mag * (1 - Math.sqrt(d2) / R);
        if (rand() < 0.04 + inten * 0.3) { o.alive = false; if (civ._addMark) civ._addMark(o.x, o.y); if (++killed >= kcap) break; }
      }
    }
    // 人知れず辺境で揺れただけの小さな地震は記録しない（年代記と通知を埋めない）。
    if (destroyed === 0 && killed === 0 && mag <= 0.4) return;
    const scale = mag > 0.7 ? "大地震" : mag > 0.4 ? "地震" : "弱い地震";
    this._log("🌐 " + hitName + "で" + scale + " — 建物" + destroyed + "棟倒壊・" + killed + "人犠牲");
    // 沿岸の大地震は津波（洪水）を誘発する（連鎖災害）。
    if (mag > 0.55 && this._nearWater(world, ex, ey, 3) && rand() < 0.5) {
      this._log("🌊 海底地震が津波を呼んだ");
      this._flood(world, ex, ey);
    }
    // 余震: 大地震ほど続く。
    if (mag > 0.6 && rand() < mag) { this._log("（余震が続いている）"); }
  };

  DisasterSystem.prototype._nearWater = function (world, cx, cy, r) {
    const W = world.width, H = world.height, tile = Game.tile;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (tile.isWater(world.terrain[y * W + x])) return true;
    }
    return false;
  };

  // 干ばつ: ある地点を中心に、湿度を奪って大地を干上がらせる（放射状に弱まる）。水循環が
  //   緩やかに回復させるが、乾燥・温暖な気候の時代には長引く。乾いた大地は燃えやすくなる。
  DisasterSystem.prototype._drought = function (world) {
    if (!world.moisture) return;
    const W = world.width, H = world.height, rand = this.rand, tile = Game.tile;
    // 発生地: 元々乾きがちな内陸ほど干ばつに見舞われる（数点を下見し、気候の素地の湿度が
    //   最も低い陸地を選ぶ）。従来は海の上も含めて完全にランダムだった。
    const mb = world.moistureBase || world.moisture;
    let cx = -1, cy = -1, dry = 2;
    for (let s = 0; s < 8; s++) {
      const x = (rand() * W) | 0, y = (rand() * H) | 0, i = y * W + x;
      if (!tile.isLand(world.terrain[i])) continue;
      if (mb[i] < dry) { dry = mb[i]; cx = x; cy = y; }
    }
    if (cx < 0) return;
    const R = 14 + ((rand() * 18) | 0);            // 影響半径
    const R2 = R * R, m = world.moisture, f = world.fertility;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        const i = y * W + x;
        if (!tile.isLand(world.terrain[i])) continue;
        const fall = 1 - d2 / R2;                   // 中心ほど強く
        m[i] *= 1 - 0.6 * fall;                     // 湿度を奪う（火災・植生・農業へ波及）
        if (f) f[i] *= 1 - 0.4 * fall;              // 草木も枯れる
      }
    }
    this._log("☀️ " + this._place(world, cx, cy) + "を干ばつが干上がらせた");
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
