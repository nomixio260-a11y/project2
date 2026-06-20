// ブラシ。半径内の円形領域を走査し、距離フォールオフ付きでコールバックする。
(function (Game) {
  "use strict";

  function Brush(size) {
    this.size = size || 3; // 半径（タイル数）
    this.shape = "circle";
  }

  // 中心(cx,cy)の円内タイルを cb(x,y,falloff) で走査。
  // falloff: 中心=1, 縁=0 付近（raise/lower を自然にするため）。
  Brush.prototype.forEachTile = function (world, cx, cy, cb) {
    const r = this.size;
    const r2 = r * r;
    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(world.width - 1, cx + r);
    const y0 = Math.max(0, cy - r);
    const y1 = Math.min(world.height - 1, cy + r);
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const falloff = 1 - Math.sqrt(d2) / (r + 0.0001);
        cb(x, y, falloff);
      }
    }
  };

  Game.Brush = Brush;
})(window.Game);
