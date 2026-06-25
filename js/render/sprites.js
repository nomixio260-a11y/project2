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
  // 歩行アニメ用に脚の2フレーム（脚を立てる/踏み出す）を用意する。
  // フレーム0＝直立、フレーム1＝脚を斜めに踏み出した姿勢。
  const HERB0 = [
    "..........",
    "......OOO.",
    ".OOOOOOBBO",
    "OBLLLBBBEO",
    "OBLLLBBBBO",
    ".OBBBBBBO.",
    ".O.O.O.O..",
    ".D.D.D.D..",
  ];
  const HERB1 = [
    "..........",
    "......OOO.",
    ".OOOOOOBBO",
    "OBLLLBBBEO",
    "OBLLLBBBBO",
    ".OBBBBBBO.",
    "O.O.O.O...",
    "..D.D.D.D.",
  ];
  const HERB_PAL = {
    O: [74, 58, 30],   // 輪郭
    B: [216, 192, 116], // 体（タン）
    L: [239, 224, 168], // 明るい部分
    E: [25, 16, 8],    // 目
    D: [60, 46, 24],   // 脚
  };

  // ===== 肉食動物（狼/狐風・右向き）=====
  const PRED0 = [
    "..........",
    ".......OOO",
    "O.OOOOOBBO",
    "OBBBBBBBEO",
    ".OBBBRBBBO",
    ".OBBBBBBO.",
    ".O.O.O.O..",
    ".D.D.D.D..",
  ];
  const PRED1 = [
    "..........",
    ".......OOO",
    "O.OOOOOBBO",
    "OBBBBBBBEO",
    ".OBBBRBBBO",
    ".OBBBBBBO.",
    "O.O.O.O...",
    "..D.D.D.D.",
  ];
  const PRED_PAL = {
    O: [74, 20, 16],   // 輪郭
    B: [196, 74, 63],  // 体（赤茶）
    R: [150, 48, 40],  // 影
    E: [255, 210, 74], // 目（黄）
    D: [60, 22, 18],   // 脚
  };

  const FRAMES = {
    0: [HERB0, HERB1, HERB_PAL], // 草食
    1: [PRED0, PRED1, PRED_PAL], // 肉食
  };

  const cache = {};

  Game.sprites = {
    // species: 0=草食,1=肉食。faceLeft=true で左向き。frame=0/1 で歩行コマ。
    get: function (species, faceLeft, frame) {
      const f = frame ? 1 : 0;
      const key = species + "_" + f + (faceLeft ? "L" : "R");
      if (cache[key]) return cache[key];
      const rkey = species + "_" + f + "R";
      let right = cache[rkey];
      if (!right) {
        const def = FRAMES[species] || FRAMES[0];
        right = build(def[f], def[2]);
        cache[rkey] = right;
      }
      if (!faceLeft) return right;
      const left = flipH(right);
      cache[key] = left;
      return left;
    },
  };

  // ===== 建物 =====
  const HOUSE = [
    "...OO...",
    "..ORRO..",
    ".ORRRRO.",
    "ORRRRRRO",
    ".OWWWWO.",
    ".OWDDWO.",
    ".OWDDWO.",
    ".OWWWWO.",
  ];
  const HOUSE_PAL = {
    O: [60, 40, 28],     // 輪郭
    R: [150, 66, 50],    // 屋根（赤茶）
    W: [206, 184, 140],  // 壁
    D: [74, 51, 36],     // 戸口
  };
  const KEEP = [
    "O.O.O.O.",
    "OOOOOOOO",
    ".KKKKKK.",
    ".KKBBKK.",
    ".KKBBKK.",
    ".KKKKKK.",
    ".KKBBKK.",
    ".KKDDKK.",
    ".KKKKKK.",
  ];
  const KEEP_PAL = {
    O: [70, 70, 62],
    K: [150, 150, 138],  // 石壁
    B: [58, 86, 120],    // 窓
    D: [40, 30, 22],     // 門
  };

  // 石器時代の竪穴/茅葺き小屋。
  const HUT = [
    "........",
    "...OO...",
    "..OTTO..",
    ".OTTTTO.",
    "OTTTTTTO",
    "OWWDDWWO",
    "OWWDDWWO",
    ".OOOOOO.",
  ];
  const HUT_PAL = {
    O: [50, 36, 22], T: [156, 123, 74], W: [122, 92, 58], D: [58, 38, 22],
  };
  // 古典・中世の石造邸宅（2階建て）。
  const MANOR = [
    "..OOOO..",
    ".ORRRRO.",
    "ORRRRRRO",
    "OWBWWBWO",
    "OWWWWWWO",
    "OWBWWBWO",
    "OWWDDWWO",
    "OOOOOOOO",
  ];
  const MANOR_PAL = {
    O: [54, 54, 48], R: [91, 107, 128], W: [184, 180, 164], B: [58, 85, 112], D: [74, 51, 36],
  };
  // 神殿（列柱）。
  const TEMPLE = [
    "...OO...",
    "..OPPO..",
    ".OPPPPO.",
    "OPPPPPPO",
    "OC.CC.CO",
    "OC.CC.CO",
    "OCCCCCCO",
    "OOOOOOOO",
  ];
  const TEMPLE_PAL = {
    O: [96, 92, 78], P: [224, 220, 200], C: [206, 202, 184],
  };

  // 農場（赤い納屋＋作物）。
  const FARM = [
    "..OOOO..",
    ".ORRRRO.",
    "ORRRRRRO",
    "OWWWWWWO",
    "OWGGGGWO",
    "OWGDDGWO",
    "OWGDDGWO",
    "OOOOOOOO",
  ];
  const FARM_PAL = {
    O: [60, 40, 28], R: [150, 66, 50], W: [206, 184, 140], G: [120, 160, 70], D: [74, 51, 36],
  };
  // 鍛冶場（石造の工房＋炉の火＋煙突）。
  const SMITHY = [
    "...O....",
    "..OO....",
    ".OWWWWO.",
    "OWWWWWWO",
    "OWWFFWWO",
    "OWWFFWWO",
    "OWDDWWWO",
    "OOOOOOOO",
  ];
  const SMITHY_PAL = {
    O: [48, 44, 40], W: [120, 116, 110], F: [240, 150, 40], D: [44, 32, 22],
  };
  // 市場（縞模様の天幕＋商品）。
  const MARKET = [
    "........",
    "OOOOOOOO",
    "OYBYBYBO",
    "OYBYBYBO",
    ".O.WW.O.",
    ".O.WW.O.",
    ".OGGGGO.",
    ".OOOOOO.",
  ];
  const MARKET_PAL = {
    O: [80, 60, 40], Y: [230, 210, 120], B: [200, 90, 70], W: [184, 162, 120], G: [150, 120, 80],
  };
  // 兵舎（旗の立つ石造の砦小屋）。
  const BARRACKS = [
    "...F....",
    "...F....",
    ".OOOOOO.",
    "OKKKKKKO",
    "OKBBKKKO",
    "OKKKKKKO",
    "OKKDDKKO",
    "OOOOOOOO",
  ];
  const BARRACKS_PAL = {
    O: [70, 66, 60], K: [140, 135, 120], B: [58, 70, 90], D: [40, 30, 22], F: [200, 70, 60],
  };
  // 穀倉（円錐茅葺きのサイロ＋穀物）。
  const GRANARY = [
    "...OO...",
    "..OYYO..",
    ".OYYYYO.",
    ".OWWWWO.",
    ".OWGGWO.",
    ".OWGGWO.",
    ".OWWWWO.",
    ".OOOOOO.",
  ];
  const GRANARY_PAL = {
    O: [60, 44, 28], Y: [180, 150, 90], W: [200, 180, 140], G: [230, 200, 110],
  };

  // 鉱山（岩肌の坑口＋支柱＋トロッコ）。
  const MINE = [
    "OOOOOOOO",
    "OKKKKKKO",
    "OKWTTWKO",
    "OKTBBTKO",
    "OKTBBTKO",
    "OKTBBTKO",
    "O.RCCR.O",
    "OOOOOOOO",
  ];
  const MINE_PAL = {
    O: [44, 40, 36], K: [104, 98, 90], W: [78, 64, 44], T: [92, 74, 50], B: [26, 22, 20], R: [60, 50, 40], C: [150, 120, 70],
  };

  // 大記念碑（金色の大尖塔。国の誇りのランドマーク）。
  const WONDER = [
    "...OO...",
    "...GG...",
    "...GG...",
    "...GG...",
    "..GGGG..",
    "..GWWG..",
    ".GGGGGG.",
    ".GWGGWG.",
    "GGGGGGGG",
    "OOOOOOOO",
  ];
  const WONDER_PAL = {
    G: [228, 202, 110], W: [122, 92, 40], O: [86, 72, 44],
  };

  const _b = {};
  function bget(key, grid, pal) { return _b[key] || (_b[key] = build(grid, pal)); }
  Game.sprites.house = function () { return bget("house", HOUSE, HOUSE_PAL); };
  Game.sprites.keep = function () { return bget("keep", KEEP, KEEP_PAL); };
  Game.sprites.hut = function () { return bget("hut", HUT, HUT_PAL); };
  Game.sprites.manor = function () { return bget("manor", MANOR, MANOR_PAL); };
  Game.sprites.temple = function () { return bget("temple", TEMPLE, TEMPLE_PAL); };
  Game.sprites.farm = function () { return bget("farm", FARM, FARM_PAL); };
  Game.sprites.smithy = function () { return bget("smithy", SMITHY, SMITHY_PAL); };
  Game.sprites.market = function () { return bget("market", MARKET, MARKET_PAL); };
  Game.sprites.barracks = function () { return bget("barracks", BARRACKS, BARRACKS_PAL); };
  Game.sprites.granary = function () { return bget("granary", GRANARY, GRANARY_PAL); };
  Game.sprites.mine = function () { return bget("mine", MINE, MINE_PAL); };
  Game.sprites.wonder = function () { return bget("wonder", WONDER, WONDER_PAL); };

  // 建物タイプID → スプライト（civ の Game.BUILDING と対応）。
  // 0=小屋,1=家,2=邸宅,3=砦,4=神殿,5=農場,6=鍛冶場,7=市場,8=兵舎,9=穀倉。
  Game.sprites.building = function (t) {
    switch (t) {
      case 0: return Game.sprites.hut();
      case 2: return Game.sprites.manor();
      case 3: return Game.sprites.keep();
      case 4: return Game.sprites.temple();
      case 5: return Game.sprites.farm();
      case 6: return Game.sprites.smithy();
      case 7: return Game.sprites.market();
      case 8: return Game.sprites.barracks();
      case 9: return Game.sprites.granary();
      case 10: return Game.sprites.mine();
      case 11: return Game.sprites.wonder();
      default: return Game.sprites.house(); // 1
    }
  };
})(window.Game);
