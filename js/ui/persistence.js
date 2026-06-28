// セーブ/ロードとスクリーンショット。世界・気候・生物・炎・文明の全状態を
// JSON にシリアライズして保存/復元する。乱数は seed 駆動で決定的なため、
// 状態のスナップショットだけで歴史を正確に再開できる。
(function (Game) {
  "use strict";

  const VERSION = 1;

  // ---- TypedArray <-> base64（巨大配列でもスタックを溢れさせないよう分割）----
  function encA(typed) {
    const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    let bin = "", CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(bin);
  }
  function bytes(b64) {
    const bin = atob(b64), n = bin.length, u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function decF32(b64) { return new Float32Array(bytes(b64).buffer); }
  function decU8(b64) { return bytes(b64); }
  function decU16(b64) { return new Uint16Array(bytes(b64).buffer); }
  function decI32(b64) { return new Int32Array(bytes(b64).buffer); }

  // 人物の描画用・一時フィールド（保存不要）。
  const PERSON_DROP = { _px: 1, _py: 1, _mv: 1, look: 1, _enemy: 1 };
  // 王国の一時集計・参照（保存不要。復元時に再構築/再計算）。
  const K_DROP = { rulerRef: 1, _topRef: 1, prices: 1, _moodS: 1, _moodN: 1, _cultS: 1,
    _lxS: 1, _lyS: 1, _fireLoss: 1, _raceCnt: 1, _topP: 1, _famineDeaths: 1 };

  function serialize() {
    const st = Game.state;
    const world = st.world, civ = st.civ, ent = st.entities, fire = st.fire, clk = st.clock;
    const w = {
      width: world.width, height: world.height,
      terrain: encA(world.terrain), elevation: encA(world.elevation),
      moisture: encA(world.moisture), temperature: encA(world.temperature),
      fertility: encA(world.fertility), owner: encA(world.owner),
      resource: encA(world.resource), resourceList: world.resourceList || [],
    };
    const e = {
      capacity: ent.capacity, count: ent.count, live: ent.live, freeTop: ent._freeTop,
      x: encA(ent.x), y: encA(ent.y), type: encA(ent.type), energy: encA(ent.energy),
      age: encA(ent.age), alive: encA(ent.alive), gene: encA(ent.gene), geneSpd: encA(ent.geneSpd),
      geneSense: encA(ent.geneSense), geneFert: encA(ent.geneFert), thirst: encA(ent.thirst),
      heading: encA(ent.heading), free: encA(ent._free),
    };
    const fr = { burn: encA(fire.burn), active: fire.active.slice() };
    const people = civ.people.map(function (p) {
      const o = {};
      for (const k in p) {
        if (PERSON_DROP[k]) continue;
        if (k === "partner") { o._partnerPid = p.partner ? (p.partner.pid || 0) : 0; continue; }
        if (k === "bonds") { o._bondsPids = p.bonds ? p.bonds.map(function (b) { return b.pid || 0; }) : null; continue; }
        o[k] = p[k];
      }
      return o;
    });
    const kingdoms = civ.kingdoms.map(function (k) {
      if (!k) return null;
      const o = {};
      for (const key in k) { if (K_DROP[key]) continue; o[key] = k[key]; }
      return o;
    });
    const clock = {};
    if (clk) for (const k in clk) { if (k === "season") continue; clock[k] = clk[k]; }
    return {
      v: VERSION, seed: Game.config.seed, mapWidth: world.width, mapHeight: world.height,
      world: w, entities: e, fire: fr, clock: clock,
      climate: st.climate ? { _wphase: st.climate._wphase, _dphase: st.climate._dphase, _epoch: st.climate._epoch } : null,
      civ: { tickN: civ._tickN || 0, pidSeq: civ._pidSeq || 0, kingdoms: kingdoms, people: people },
    };
  }

  function deserialize(snap) {
    if (!snap || !snap.world || !snap.civ) throw new Error("無効なセーブデータ");
    const st = Game.state, cfg = Game.config;
    const W = snap.world.width, H = snap.world.height;

    // 世界を再構築。
    const world = new Game.World(W, H);
    world.terrain.set(decU8(snap.world.terrain));
    world.elevation.set(decF32(snap.world.elevation));
    world.moisture.set(decF32(snap.world.moisture));
    world.temperature.set(decF32(snap.world.temperature));
    world.fertility.set(decF32(snap.world.fertility));
    world.owner.set(decU16(snap.world.owner));
    world.resource.set(decU8(snap.world.resource));
    world.resourceList = snap.world.resourceList || [];
    cfg.seed = snap.seed; cfg.mapWidth = W; cfg.mapHeight = H;
    st.world = world;

    // 各システムへ世界を差し替え（grid 等を作り直す）。
    st.renderer.setWorld(world);
    if (st.input) st.input.setWorld(world);
    if (st.weather) st.weather.setWorld(world);
    if (st.vegetation) st.vegetation.setWorld(world);
    if (st.creatures) st.creatures.setWorld(world);
    if (st.fire) st.fire.setWorld(world);
    if (st.civ) st.civ.setWorld(world);
    if (st.disasters) st.disasters.setWorld(world);

    // 生物ストアを保存時の容量で再構築し、参照を張り替える。
    const es = snap.entities;
    const ent = new Game.Entities(es.capacity);
    ent.x.set(decF32(es.x)); ent.y.set(decF32(es.y)); ent.type.set(decU8(es.type));
    ent.energy.set(decF32(es.energy)); ent.age.set(decF32(es.age)); ent.alive.set(decU8(es.alive));
    ent.gene.set(decF32(es.gene)); ent.geneSpd.set(decF32(es.geneSpd)); ent.geneSense.set(decF32(es.geneSense));
    ent.geneFert.set(decF32(es.geneFert)); ent.thirst.set(decF32(es.thirst)); ent.heading.set(decF32(es.heading));
    ent._free.set(decI32(es.free)); ent._freeTop = es.freeTop; ent.count = es.count; ent.live = es.live;
    st.entities = ent;
    if (st.renderer.setEntities) st.renderer.setEntities(ent);
    if (st.creatures) { st.creatures.entities = ent; st.creatures.nextLink = new Int32Array(ent.capacity); }

    // 炎。
    if (st.fire) { st.fire.burn.set(decU8(snap.fire.burn)); st.fire.active = (snap.fire.active || []).slice(); }

    // 気候の時計と位相。
    if (snap.clock) { for (const k in snap.clock) st.clock[k] = snap.clock[k]; st.clock.season = Game.SEASONS[st.clock.seasonIndex || 0]; }
    if (snap.climate && st.climate) { st.climate._wphase = snap.climate._wphase; st.climate._dphase = snap.climate._dphase; st.climate._epoch = snap.climate._epoch; }

    // 文明: 王国・人物を復元し、参照（伴侶・親友・統治者）を pid から張り直す。
    const civ = st.civ;
    civ.kingdoms = snap.civ.kingdoms.slice();
    civ.people = snap.civ.people;
    civ._tickN = snap.civ.tickN || 0;
    civ._pidSeq = snap.civ.pidSeq || 0;
    if (!civ._next || civ._next.length < civ.people.length) civ._next = new Int32Array(civ.people.length + 256);
    const pmap = {};
    for (let i = 0; i < civ.people.length; i++) { const p = civ.people[i]; if (p.pid) pmap[p.pid] = p; }
    for (let i = 0; i < civ.people.length; i++) {
      const p = civ.people[i];
      p.partner = p._partnerPid ? (pmap[p._partnerPid] || null) : null; delete p._partnerPid;
      p.bonds = p._bondsPids ? p._bondsPids.map(function (id) { return pmap[id]; }).filter(Boolean) : null; delete p._bondsPids;
    }
    for (let id = 1; id < civ.kingdoms.length; id++) {
      const k = civ.kingdoms[id]; if (!k) continue;
      k.rulerRef = k.rulerPid ? (pmap[k.rulerPid] || null) : null;
    }

    // 描画とビューを更新。
    if (st.renderer.repaintTerritory) st.renderer.repaintTerritory();
    if (Game.minimap && Game.minimap._fit) Game.minimap._fit();
    if (st.camera) st.camera.fitTiles(cfg.initialFitTiles || 130);
    return true;
  }

  // ---- ファイル入出力（ブラウザ）----
  function triggerDownload(href, filename) {
    const a = document.createElement("a");
    a.href = href; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); }, 0);
  }

  function save() {
    const json = JSON.stringify(serialize());
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, "fantasy-map-" + stamp() + ".json");
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("💾 世界を保存しました");
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = function () {
      try { deserialize(JSON.parse(reader.result)); toast("📂 世界を読み込みました"); }
      catch (e) { toast("⚠ 読込に失敗しました: " + e.message); }
    };
    reader.readAsText(file);
  }

  function screenshot() {
    const canvas = document.getElementById("game");
    if (!canvas) return;
    try { triggerDownload(canvas.toDataURL("image/png"), "fantasy-map-" + stamp() + ".png"); toast("📸 スクリーンショットを保存しました"); }
    catch (e) { toast("⚠ 画像の保存に失敗しました"); }
  }

  function stamp() {
    const d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function toast(msg) { if (Game.toasts && Game.toasts.show) Game.toasts.show(msg); }

  Game.persistence = { serialize: serialize, deserialize: deserialize, save: save, loadFile: loadFile, screenshot: screenshot };
})(window.Game);
