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

    this.count = 0; // 使用済みスロットの最大到達点
    this.live = 0; // 現在生存数

    // 再利用用 free-list（kill されたスロットを積む）。
    this._free = new Int32Array(capacity);
    this._freeTop = 0;
  }

  // 新規スポーン。空きが無ければ -1。
  Entities.prototype.spawn = function (type, x, y, energy) {
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
