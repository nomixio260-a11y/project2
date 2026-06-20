// グリッド世界モデル。フラットな TypedArray でタイル属性を保持する。
// Canvas には依存しない（将来ヘッドレスでシミュレーション可能）。
(function (Game) {
  "use strict";

  function World(width, height) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.elevation = new Float32Array(n); // 0..1
    this.moisture = new Float32Array(n); // 0..1
    this.temperature = new Float32Array(n); // 0..1（緯度・標高ベース、バイオーム分類用）
    this.terrain = new Uint8Array(n); // TERRAIN enum
    this.owner = new Uint16Array(n); // 文明の領有（0=無所属, それ以外=王国ID）
  }

  World.prototype.idx = function (x, y) {
    return y * this.width + x;
  };

  World.prototype.inBounds = function (x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  };

  World.prototype.getTerrain = function (x, y) {
    return this.terrain[y * this.width + x];
  };

  World.prototype.setTerrain = function (x, y, t) {
    this.terrain[y * this.width + x] = t;
  };

  World.prototype.getElevation = function (x, y) {
    return this.elevation[y * this.width + x];
  };

  World.prototype.setElevation = function (x, y, e) {
    this.elevation[y * this.width + x] = e < 0 ? 0 : e > 1 ? 1 : e;
  };

  World.prototype.getMoisture = function (x, y) {
    return this.moisture[y * this.width + x];
  };

  World.prototype.getOwner = function (x, y) {
    return this.owner[y * this.width + x];
  };

  World.prototype.setOwner = function (x, y, id) {
    this.owner[y * this.width + x] = id;
  };

  World.prototype.getTemperature = function (x, y) {
    return this.temperature[y * this.width + x];
  };

  World.prototype.setTemperature = function (x, y, t) {
    this.temperature[y * this.width + x] = t < 0 ? 0 : t > 1 ? 1 : t;
  };

  // 標高を delta だけ変化させ、新標高を返す（0..1 にクランプ）。
  World.prototype.raise = function (x, y, delta) {
    const i = y * this.width + x;
    let e = this.elevation[i] + delta;
    e = e < 0 ? 0 : e > 1 ? 1 : e;
    this.elevation[i] = e;
    return e;
  };

  Game.World = World;
})(window.Game);
