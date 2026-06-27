// 生物エンティティストア。data-oriented な並列 TypedArray + free-list。
// Canvas 非依存（ヘッドレスでシミュレーション・テスト可能）。
(function (Game) {
  "use strict";

  // 種別。
  Game.SPECIES = {
    HERBIVORE: 0, // 草食（草・森を食べる）
    PREDATOR: 1, // 肉食（草食を捕食）
  };

  function Entities(capacity) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity); // タイル座標（小数で滑らかに移動）
    this.y = new Float32Array(capacity);
    this.type = new Uint8Array(capacity);
    this.energy = new Float32Array(capacity);
    this.age = new Float32Array(capacity); // 経過ティック
    this.alive = new Uint8Array(capacity);
    // ===== 遺伝子（いずれも 0.7..1.3, 1.0=標準）。継承＋変異＋自然選択で進化する =====
    this.gene = new Float32Array(capacity);      // 体格: 大=速い/強いが燃費悪い・大食い
    this.geneSpd = new Float32Array(capacity);   // 俊敏: 移動速度（逃走・追跡に効く）
    this.geneSense = new Float32Array(capacity); // 感覚: 危険察知・獲物発見の半径
    this.geneFert = new Float32Array(capacity);  // 多産: 繁殖しやすさ
    this.thirst = new Float32Array(capacity); // 0..1 渇き
    this.heading = new Float32Array(capacity); // 進行方向(ラジアン)。描画の向き用

    this.count = 0; // 使用済みスロットの最大到達点
    this.live = 0; // 現在生存数

    // 再利用用 free-list（kill されたスロットを積む）。
    this._free = new Int32Array(capacity);
    this._freeTop = 0;
  }

  // 新規スポーン。空きが無ければ -1。各遺伝子は省略時 1.0（標準）。
  Entities.prototype.spawn = function (type, x, y, energy, gene, gSpd, gSense, gFert) {
    let i;
    if (this._freeTop > 0) {
      i = this._free[--this._freeTop];
    } else if (this.count < this.capacity) {
      i = this.count++;
    } else {
      return -1; // 上限到達
    }
    this.x[i] = x;
    this.y[i] = y;
    this.type[i] = type;
    this.energy[i] = energy === undefined ? 0.6 : energy;
    this.age[i] = 0;
    this.alive[i] = 1;
    this.gene[i] = gene === undefined ? 1 : gene;
    this.geneSpd[i] = gSpd === undefined ? 1 : gSpd;
    this.geneSense[i] = gSense === undefined ? 1 : gSense;
    this.geneFert[i] = gFert === undefined ? 1 : gFert;
    this.thirst[i] = 0;
    this.live++;
    return i;
  };

  // 死亡（スロットを free-list へ返す）。
  Entities.prototype.kill = function (i) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.live--;
    this._free[this._freeTop++] = i;
  };

  // 生存個体に対して cb(i) を呼ぶ。
  Entities.prototype.forEachAlive = function (cb) {
    for (let i = 0; i < this.count; i++) {
      if (this.alive[i]) cb(i);
    }
  };

  // 全消去（再生成時）。
  Entities.prototype.clear = function () {
    this.count = 0;
    this.live = 0;
    this._freeTop = 0;
    this.alive.fill(0);
  };

  Game.Entities = Entities;
})(window.Game);
