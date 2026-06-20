// ピクセルアートのスプライト工房。小さな文字グリッドから 1px=1ドットの
// オフスクリーン canvas を生成し、renderer が drawImage で拡大描画する
// （imageSmoothing=false でドット感を保つ）。種別×向きでキャッシュする。
(function (Game) {
  "use strict";

  // 文字グリッド + パレットから canvas を作る。
  function build(grid, palette) {
    const h = grid.length;
    const w = grid[0].length;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const row = grid[y];
      for (let x = 0; x < w; x++) {
        const col = palette[row[x]];
        const o = (y * w + x) * 4;
        if (!col) { d[o + 3] = 0; continue; }
        d[o] = col[0];
        d[o + 1] = col[1];
        d[o + 2] = col[2];
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // 水平反転コピー（左向き用）。
  function flipH(src) {
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.translate(src.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(src, 0, 0);
    return c;
  }

  // ===== 草食動物（鹿/羊風・右向き）=====
  const HERB = [
    "..........",
    "......OOO.",
    ".OOOOOOBBO",
    "OBLLLBBBEO",
    "OBLLLBBBBO",
    ".OBBBBBBO.",
    ".O.O.O.O..",
    ".D.D.D.D..",
  ];
  const HERB_PAL = {
    O: [74, 58, 30],   // 輪郭
    B: [216, 192, 116], // 体（タン）
    L: [239, 224, 168], // 明るい部分
    E: [25, 16, 8],    // 目
    D: [60, 46, 24],   // 脚
  };

  // ===== 肉食動物（狼/狐風・右向き）=====
  const PRED = [
    "..........",
    ".......OOO",
    "O.OOOOOBBO",
    "OBBBBBBBEO",
    ".OBBBRBBBO",
    ".OBBBBBBO.",
    ".O.O.O.O..",
    ".D.D.D.D..",
  ];
  const PRED_PAL = {
    O: [74, 20, 16],   // 輪郭
    B: [196, 74, 63],  // 体（赤茶）
    R: [150, 48, 40],  // 影
    E: [255, 210, 74], // 目（黄）
    D: [60, 22, 18],   // 脚
  };

  const cache = {};

  Game.sprites = {
    // species: 0=草食,1=肉食。faceLeft=true で左向き。
    get: function (species, faceLeft) {
      const key = species + (faceLeft ? "L" : "R");
      if (cache[key]) return cache[key];
      let right = cache[species + "R"];
      if (!right) {
        right = species === Game.SPECIES.PREDATOR
          ? build(PRED, PRED_PAL)
          : build(HERB, HERB_PAL);
        cache[species + "R"] = right;
      }
      if (!faceLeft) return right;
      const left = flipH(right);
      cache[key] = left;
      return left;
    },
  };
})(window.Game);
