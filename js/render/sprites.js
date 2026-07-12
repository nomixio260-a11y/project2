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
    "......O.O.",
    "......OOO.",
    ".OOOOOOBBO",
    "OBLLLBBBEO",
    "OBLLLBBBBO",
    ".OBBBBBBO.",
    ".O.O.O.O..",
    ".D.D.D.D..",
  ];
  const HERB1 = [
    "......O.O.",
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
    ".......O.O",
    ".......OOO",
    "O.OOOOOBBO",
    "OBBBBBBBEO",
    ".OBBBRBBBO",
    ".OBBBBBBO.",
    ".O.O.O.O..",
    ".D.D.D.D..",
  ];
  const PRED1 = [
    ".......O.O",
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
  // 光は左上から。屋根・壁は明部(R/W)と陰部(r/s)に分け、軒(d)と土台(o)で立体感を出す。
  const HOUSE = [
    "..RRrr..",
    ".RRrrdd.",
    "RRrrrddd",
    "oWWWwsso",
    "oWbWwbso",
    "oWWWwsso",
    "oWDDwsso",
    "oWDDwsso",
    ".oooooo.",
  ];
  const HOUSE_PAL = {
    o: [54, 36, 26],     // 土台・梁
    R: [182, 92, 68], r: [150, 66, 50], d: [104, 44, 34], // 屋根（明・中・軒陰）
    W: [222, 200, 152], w: [196, 174, 130], s: [150, 130, 96], // 壁（明・中・陰）
    b: [120, 150, 172], // 窓
    D: [74, 51, 36],     // 戸口
  };
  // 石造の主城（銃眼・塔身・門）。国の中枢としてひときわ高くそびえる。
  const KEEP = [
    "o.o.o.o.",
    "oooooooo",
    ".LKKKKs.",
    ".LKbbKs.",
    ".LKKKKs.",
    ".LKbbKs.",
    ".LKKKKs.",
    ".LKbbKs.",
    ".LKDDKs.",
    ".LKKKKs.",
    ".oooooo.",
  ];
  const KEEP_PAL = {
    o: [60, 60, 52],
    L: [178, 178, 164], K: [150, 150, 138], s: [108, 108, 98], // 石壁（明・中・陰）
    b: [58, 86, 120],    // 窓
    D: [40, 30, 22],     // 門
  };

  // 石器時代の竪穴/茅葺き小屋（丸みのある茅屋根）。
  const HUT = [
    "........",
    "...dd...",
    "..dTTd..",
    ".dTLTLd.",
    "dTTLTTLd",
    "oWWDDWso",
    "oWWDDWso",
    ".oooooo.",
  ];
  const HUT_PAL = {
    o: [50, 36, 22], d: [92, 64, 36], T: [156, 123, 74], L: [188, 152, 98], // 茅（陰・中・明）
    W: [130, 98, 60], s: [96, 72, 44], D: [58, 38, 22],
  };
  // 古典・中世の石造邸宅（2階建て・青灰の瓦屋根・並ぶ窓）。
  const MANOR = [
    ".RRRRRd.",
    "RRRRRRdd",
    "oWbWWbso",
    "oWWWWWso",
    "oWbWWbso",
    "oWWWWWso",
    "oWbWWbso",
    "oWWDDWso",
    "oWWDDWso",
    ".oooooo.",
  ];
  const MANOR_PAL = {
    o: [54, 54, 48], R: [110, 126, 148], d: [70, 84, 104], // 瓦（明・陰）
    W: [198, 194, 178], s: [150, 146, 132], b: [58, 85, 112], D: [74, 51, 36],
  };
  // 神殿（切妻の破風・溝彫りの列柱・基壇）。白亜の聖域。
  const TEMPLE = [
    "...pp...",
    "..pPPd..",
    ".pPPPdd.",
    "pPPPPPdp",
    "oLLLLLLo",
    "CICICICI",
    "CICICICI",
    "CICICICI",
    "oLLLLLLo",
    ".oooooo.",
  ];
  const TEMPLE_PAL = {
    o: [120, 116, 100], p: [224, 220, 200], P: [238, 234, 216], d: [168, 164, 146], // 破風
    L: [212, 208, 190], C: [216, 212, 194], I: [150, 146, 132], // 楣・柱・柱間の陰
  };

  // 農場（赤い納屋＋干し草の妻壁＋畝の作物）。
  const FARM = [
    "..RRrr..",
    ".RRrrdd.",
    "RRrrrddd",
    "oWWWwsso",
    "oWhhwsso",
    "oWDDwsso",
    "gGgGgGgG",
    "GgGgGgGg",
    "kkkkkkkk",
  ];
  const FARM_PAL = {
    o: [60, 40, 28], R: [168, 74, 56], r: [150, 66, 50], d: [104, 44, 34],
    W: [210, 188, 144], w: [182, 160, 118], s: [138, 118, 84], h: [190, 158, 92], D: [74, 51, 36],
    g: [116, 154, 68], G: [150, 190, 90], k: [92, 72, 46], // 畝
  };
  // 鍛冶場（石壁の工房＋煙突＋赤く燃える炉）。
  const SMITHY = [
    "..o.....",
    ".oCo....",
    ".oCo....",
    "oWWWWWso",
    "oWFFWwso",
    "oWFFWwso",
    "oWDDWwso",
    "oWWWWwso",
    ".oooooo.",
  ];
  const SMITHY_PAL = {
    o: [48, 44, 40], C: [72, 68, 62], W: [132, 128, 120], w: [110, 106, 98], s: [88, 84, 78],
    F: [246, 152, 46], D: [44, 32, 22],
  };
  // 市場（紅白の縞天幕＋台の商品）。
  const MARKET = [
    ".oooooo.",
    "oYBYBYBo",
    "oYBYBYBo",
    "osssssso",
    ".o.ww.o.",
    ".oGGGGo.",
    ".oPPPPo.",
    ".oooooo.",
  ];
  const MARKET_PAL = {
    o: [80, 60, 40], Y: [238, 218, 130], B: [206, 94, 74], s: [150, 110, 80], // 天幕陰
    w: [186, 164, 122], G: [150, 120, 80], P: [122, 152, 92], // 支柱・台・青物
  };
  // 兵舎（軍旗のはためく石造の武具庫＋盾）。
  const BARRACKS = [
    "...F....",
    "...FF...",
    "..FFo...",
    ".oooooo.",
    "oLKKKKso",
    "oLKSSKso",
    "oLKKKKso",
    "oLKDDKso",
    "oLKKKKso",
    ".oooooo.",
  ];
  const BARRACKS_PAL = {
    o: [70, 66, 60], L: [162, 156, 140], K: [138, 133, 118], s: [104, 100, 88],
    S: [190, 122, 60], D: [40, 30, 22], F: [206, 72, 60], // 盾・門・旗
  };
  // 穀倉（円錐茅葺きのサイロ＋実った穀物）。
  const GRANARY = [
    "...dd...",
    "..dTTd..",
    ".dTLLTd.",
    ".TLLLLT.",
    ".oWWWWo.",
    ".oWGGWo.",
    ".oWGGWo.",
    ".oWWWWo.",
    ".oooooo.",
  ];
  const GRANARY_PAL = {
    o: [70, 52, 30], d: [120, 92, 50], T: [180, 150, 90], L: [208, 180, 112], // 茅屋根
    W: [202, 182, 142], G: [238, 208, 118], // 壁・穀物
  };

  // 鉱山（岩肌の坑口＋木の支保工＋鉱石を積むトロッコ）。
  const MINE = [
    "KKKKKKKK",
    "KkkkkkkK",
    "KkWTTWkK",
    "KkTBBTkK",
    "KkTBBTkK",
    "KkTBBTkK",
    "KoRCCRoK",
    "KooooooK",
    "KKKKKKKK",
  ];
  const MINE_PAL = {
    K: [52, 48, 44], k: [104, 98, 90], W: [86, 70, 48], T: [120, 96, 62], // 岩・支柱
    B: [24, 20, 18], o: [44, 40, 36], R: [70, 58, 44], C: [170, 134, 76], // 坑道・鉱石
  };

  // 大記念碑（黄金の大尖塔。国の誇りとして高々とそびえるランドマーク）。
  const WONDER = [
    "...Gg...",
    "...Gg...",
    "..GLgg..",
    "..GLgg..",
    "..GLgg..",
    ".GLLLgg.",
    ".GLLLgg.",
    "GLLLLLgg",
    "GLLLLLGg",
    "oGGGGGGo",
    ".oooooo.",
  ];
  const WONDER_PAL = {
    G: [232, 206, 116], L: [248, 232, 168], g: [176, 140, 66], o: [92, 76, 46], // 明・稜線・陰・台
  };

  // 学院（青の丸屋根の学び舎＋溝彫りの列柱）。知の府。
  const ACADEMY = [
    "...DD...",
    "..DBBD..",
    ".DBLBBD.",
    ".DBLBBD.",
    "oWWWWWWo",
    "CICICICI",
    "CICICICI",
    "CICICICI",
    "oWWWWWWo",
    ".oooooo.",
  ];
  const ACADEMY_PAL = {
    o: [70, 78, 96], W: [210, 214, 228], C: [178, 190, 214], I: [130, 140, 162], // 楣・柱・柱間陰
    B: [86, 150, 210], L: [150, 196, 236], D: [54, 96, 150], // 丸屋根（中・照り・陰）
  };
  // 港（桟橋＋帆を張って停泊する船＋さざ波）。沿岸の漁と海上交易。
  const HARBOR = [
    "...M....",
    "..SMs...",
    "..SSSs..",
    ".oHHHHo.",
    "oHHHHHHo",
    "BBBBBBBB",
    "wWwwWwWw",
    "wwwwwwww",
    "wWwwwWww",
  ];
  const HARBOR_PAL = {
    o: [70, 52, 34], H: [128, 94, 58], B: [92, 68, 44], // 船体・桟橋
    S: [238, 234, 220], s: [186, 182, 168], M: [80, 60, 40], // 帆（明・陰）・帆柱
    w: [58, 108, 150], W: [92, 150, 196], // 波（陰・照り）
  };
  // 酒場（切妻屋根＋張り出した看板＋灯のともる窓）。娯楽と憩い。
  const TAVERN = [
    "..RRrr..",
    ".RRrrdd.",
    "RRrrrddd",
    "oWFWWFso",
    "oWWWWWsS",
    "oWFWWDsS",
    "oWWWWDso",
    "oWWWWWso",
    ".oooooo.",
  ];
  const TAVERN_PAL = {
    o: [54, 38, 26], R: [172, 92, 54], r: [150, 80, 46], d: [100, 58, 34],
    W: [200, 172, 124], s: [150, 126, 88], F: [244, 208, 122], D: [92, 60, 36], S: [120, 90, 50], // 灯窓・戸・看板
  };

  // 水道（石造アーチの上を水路が渡る。清潔な水を都市へ運ぶ）。
  const AQUEDUCT = [
    "wwwwwwww",
    "LLLLLLLL",
    "LSSLLSSL",
    "SAASAASA",
    "SAASAASA",
    "sAAsAAsA",
    "SAASAASA",
    "ssssssss",
  ];
  const AQUEDUCT_PAL = {
    S: [180, 172, 158], L: [204, 198, 184], s: [132, 126, 114], A: [70, 64, 56], w: [92, 158, 208],
  };
  // 城壁（銃眼つきの石垣と門。都市を攻囲から守る）。
  const WALLS = [
    "L.L.L.L.",
    "LSLSLSLS",
    "LSSLLSSL",
    "SSGGGGSS",
    "SSGDDGSS",
    "sSGDDGSs",
    "sSGDDGSs",
    "ssssssss",
  ];
  const WALLS_PAL = {
    L: [180, 174, 160], S: [152, 147, 134], s: [116, 112, 102], G: [110, 86, 56], D: [40, 36, 30],
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
  Game.sprites.academy = function () { return bget("academy", ACADEMY, ACADEMY_PAL); };
  Game.sprites.harbor = function () { return bget("harbor", HARBOR, HARBOR_PAL); };
  Game.sprites.tavern = function () { return bget("tavern", TAVERN, TAVERN_PAL); };
  Game.sprites.aqueduct = function () { return bget("aqueduct", AQUEDUCT, AQUEDUCT_PAL); };
  Game.sprites.walls = function () { return bget("walls", WALLS, WALLS_PAL); };

  // 建物タイプID → スプライト（civ の Game.BUILDING と対応）。
  // 0=小屋,1=家,2=邸宅,3=砦,4=神殿,5=農場,6=鍛冶場,7=市場,8=兵舎,9=穀倉,
  // 10=鉱山,11=大記念碑,12=学院,13=港,14=酒場。
  // 荒廃した建物のスプライト（黒ずみ版）。素の絵に source-atop で影を焼き込み、
  //   スプライトの形の内側だけが暗くなる（矩形の黒ずみが建物からはみ出さない）。
  //   bucket: 1..3（傷みの深さ。キャッシュして毎フレームの合成を避ける）。
  const wornCache = {};
  Game.sprites.buildingWorn = function (t, bucket) {
    const key = t + "_" + bucket;
    let c = wornCache[key];
    if (c) return c;
    const base = Game.sprites.building(t);
    c = document.createElement("canvas");
    c.width = base.width; c.height = base.height;
    const g = c.getContext("2d");
    g.drawImage(base, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = "rgba(20,16,12," + (0.18 * bucket).toFixed(2) + ")";
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "source-over";
    wornCache[key] = c;
    return c;
  };

  // 廃都の建物（灰に沈んだ版）。灰の翳りもスプライトの形の内側だけに乗せる。
  const ghostCache = {};
  Game.sprites.buildingGhost = function (t, bucket) {
    const key = t + "_" + bucket;
    let c = ghostCache[key];
    if (c) return c;
    const base = Game.sprites.building(t);
    c = document.createElement("canvas");
    c.width = base.width; c.height = base.height;
    const g = c.getContext("2d");
    g.drawImage(base, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = "rgba(70,72,70," + (0.2 + 0.14 * bucket).toFixed(2) + ")";
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "source-over";
    ghostCache[key] = c;
    return c;
  };

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
      case 12: return Game.sprites.academy();
      case 13: return Game.sprites.harbor();
      case 14: return Game.sprites.tavern();
      case 15: return Game.sprites.aqueduct();
      case 16: return Game.sprites.walls();
      default: return Game.sprites.house(); // 1
    }
  };
})(window.Game);
