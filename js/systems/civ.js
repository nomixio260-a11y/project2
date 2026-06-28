// 文明シミュレーション（人間主導 / エージェントAI + 社会システム）。
//
// 各人間は「AI を積んだ自律エージェント」:
//  - 欲求: 空腹(food)・社交(social)・加齢(age)を持ち、優先度で行動を決める。
//  - 職業(role): 開拓者/農民/建築家/兵士。役割ごとに目的地と振る舞いが異なる。
//  - 社会関係: 氏族(clan=血統)と王国(in-group)で結びつき、同胞の近くに集う。
//    ペア（成人2人）で子をなし家族が増える。他王国は敵(out-group)で兵士が戦う。
// 領土・人口・都市・食料は、これら人間の行動から創発する（抽象的な自動拡張は無い）。
//
// 効率化:
//  - 近傍探索は一様グリッド（毎ティック1回構築）で O(1) 近傍に。
//  - 重い思考(_think)は thinkInterval ティックに1回だけ（人ごとに位相をずらす）。
//    移動・採食・領有といった軽い処理のみ毎ティック。
//  - 死亡は dead フラグ→末尾コンパクションでまとめ処理（途中 swap を避ける）。
(function (Game) {
  "use strict";

  const tile = Game.tile;

  // 職業（役割）。0-3 は従来互換、4-6 は専門職（工房・市場・神殿で働く）。
  const ROLE = { EXPLORER: 0, FARMER: 1, BUILDER: 2, SOLDIER: 3, SMITH: 4, MERCHANT: 5, PRIEST: 6 };
  const ROLE_COUNT = 7;
  // 建物タイプ（描画 sprites.building と対応）。各種別に固有の機能と見た目を持つ。
  // 0=小屋,1=家,2=邸宅（住居） 3=砦 4=神殿 5=農場 6=鍛冶場 7=市場 8=兵舎 9=穀倉
  // 10=鉱山 11=大記念碑 12=学院（技術） 13=港（漁・海上交易） 14=酒場（娯楽・士気）。
  const BUILDING = {
    HUT: 0, HOUSE: 1, MANOR: 2, KEEP: 3, TEMPLE: 4, FARM: 5, SMITHY: 6, MARKET: 7,
    BARRACKS: 8, GRANARY: 9, MINE: 10, WONDER: 11, ACADEMY: 12, HARBOR: 13, TAVERN: 14,
  };
  const MAX_BUILDINGS = 26; // 1都市の建物上限
  // 生産施設（住居・砦以外の機能建築）。役割の職場・国の機能になる。
  const FACILITY_KEYS = ["temple", "farm", "smithy", "market", "barracks", "granary", "mine", "academy", "harbor", "tavern", "wonder"];
  // 機能建築の既定カウント（全 0）。
  function newFacilities() {
    return { temple: 0, farm: 0, smithy: 0, market: 0, barracks: 0, granary: 0, mine: 0, academy: 0, harbor: 0, tavern: 0, wonder: 0 };
  }

  // 時代に応じた住居の種別（石器=小屋 / 青銅・鉄=家 / 古典以降=邸宅）。
  function dwellingTier(tech) {
    const era = (tech / TECH_PER_ERA) | 0;
    if (era <= 0) return BUILDING.HUT;
    if (era <= 2) return BUILDING.HOUSE;
    return BUILDING.MANOR;
  }

  // 時代に応じた装備の段階（0=無し,1=石器,2=青銅,3=鉄,4=鋼…）。
  function gearTier(tech) {
    return Math.min(5, 1 + ((tech / TECH_PER_ERA) | 0));
  }
  // 装備の段階の名前（インスペクタ・年代記用）。5=名匠の業物, 6=伝説級。
  const GEAR_NAMES = ["素手", "石器", "青銅", "鉄器", "鋼", "名匠", "伝説"];
  function gearName(t) { return GEAR_NAMES[t] || GEAR_NAMES[GEAR_NAMES.length - 1]; }
  // 国が実際に作れる装備の段階（現実の冶金の連鎖を模す）:
  //   石器(1)=常に / 青銅(2)=鉱石＋青銅器技術 / 鉄器(3)=鉱石＋燃料(炭=森林)＋鉄器技術 /
  //   鋼(4)=鉄器に加え豊富な炉熱(燃料)と熟練(工芸力)。いずれも時代(era)を上限とする。
  //   金属が無ければ石器どまり。資源・燃料・技術・熟練がそろって初めて上位の装備を打てる。
  function craftTier(k) {
    const era = gearTier(k.tech);
    const res = k.res, fac = k.facilities;
    const ore = (res && res.ore > 0) || (fac && fac.mine > 0);
    const fuel = k.fuel || 0; // 製錬の燃料（領内の森林＝炭の供給）
    let max = 1; // 石器・木器は材料を要さず常に作れる
    if (ore && hasTech(k, "bronze")) max = 2;                                  // 青銅: 鉱石＋青銅器
    if (ore && fuel >= CP.fuelIron && hasTech(k, "iron")) max = 3;             // 鉄器: 鉱石＋燃料＋鉄器
    if (max >= 3 && fuel >= CP.fuelSteel && (k.craft || 0) >= CP.steelCraft) max = 4; // 鋼: 高炉熱＋熟練
    return Math.min(max, era);
  }

  const CP = {
    popStart: 5,
    tilesPerHuman: 6,    // 人口容量の分母（確保した土地 / これ）
    baseCap: 10,         // 最低人口容量（建国直後でも成長して開拓者を出せる）
    perKingdomCap: 130,
    speed: 0.22,
    metab: 0.0016,       // 1ティックの食料消費
    eatGain: 0.05,       // 可食地での食料回復
    harvest: 0.05,       // 採食時に減る fertility（あれば）
    adultAge: 200,
    elderAge: 2600,
    maxAge: 3600,
    reproFood: 0.58,     // この食料以上で繁殖可
    reproCost: 0.34,
    reproCooldown: 240,
    reproRadius: 6,
    thinkInterval: 22,   // 重い意思決定の間隔(ティック)。大きいほど低負荷
    joinRadius: 12,      // 放浪者が既存国を見つけて加入を目指す範囲
    tether: 26,          // 開拓者・兵士の行動範囲
    tetherSettled: 13,   // 農民・建築家は自分の町の近くに定住
    seekRange: 3,
    conflictChance: 0.06,
    newTownDist: 18,     // この距離を超える自国領で新集落を興す（支配を延伸）
    foundRate: 0.02,
    maxSettlements: 10,
    controlRadius: 28,   // 都市が支配を及ぼす半径（これを超える辺境は手放す）
    controlPerLevel: 3,  // 都市の発展度1あたりの支配半径の増分
    maintainBand: 32,    // 領土メンテのローリング走査の行数/ティック
    socialRise: 0.003,
    socialRadius: 5,
    socialNeed: 5,       // 周囲の同胞がこれ未満だと孤独
    // 言語（個人の「言葉」は2次元の言語空間 lx,ly 上の位置。近いほど通じ合う）。
    langScale: 0.42,     // 相互理解度が0になる言語距離（これ以上で意思疎通が困難）
    langFloor: 0.4,      // 相互理解度の下限（身振り等で完全には途絶えない）
    langAccom: 0.02,     // 会話による言葉の歩み寄り（収束＝同化・方言形成）
    langMut: 0.012,      // 世代継承時の言語変異（方言の分岐を生む）
    langJitter: 0.03,    // 建国者の言語の個体差
    langDiploPull: 0.6,  // 言葉が通じる国どうしは親しみ、通じぬ国とは隔たる（外交）
    // 分岐・独自進化: 諸要素は収束(同化)するだけでなく、絶えず揺らぎ、時に大きく
    //   変異して独自の系統へ枝分かれする（孤立・革新が方言・新文化・民族を生む）。
    langDrift: 0.002,    // 言葉の絶え間ない微小な揺らぎ（収束と釣り合い方言の幅を生む）
    langInnov: 0.004,    // 言葉の革新（独自進化）が起きる確率／think
    langInnovAmt: 0.12,  // 革新が起きたときの言葉の跳び幅
    langSplit: 0.5,      // 独立・植民の際に言葉が大きく分岐する確率
    langSplitAmt: 0.18,  // 分岐したときの言葉の隔たり
    cultDrift: 0.004,    // 文化の微小な揺らぎ
    cultInnov: 0.003,    // 文化の革新が起きる確率／think
    cultInnovAmt: 0.18,  // 文化の革新の跳び幅
    raceGenesis: 0.015,  // 出生時に土地の気候に適応した民族へ変わる確率（民族の独自進化）
    sightBase: 5.2,      // 視野の基準半径（知性・年齢・昼夜で変化する）
    // 高度な認知: 危険地の記憶（嫌悪学習）と人生の志（長期目標）。
    dangerTtl: 900,      // 危険な目に遭った場所を覚えている期間(ティック)
    dangerR: 6,          // 記憶した危険地を避ける半径
    aspirePrestige: 1.3, // 立身・蓄財の志を持つ者の名声の伸び
    aspireFamily: 1.4,   // 家族の志を持つ者の繁殖意欲
    cultivate: 0.03,     // 農民が高める fertility
    attack: 0.05,        // 兵士が敵に与える食料ダメージ
    cellSize: 6,
    nomadFoundBand: 4,   // 建国に必要な近隣の放浪者数
    nomadFoundChance: 0.04,
    nomadFoundRadius: 6,
    nomadClusterRadius: 8,
    // 食料経済（外交評価＝diploInterval ごとに収支を計算）
    foodConsume: 0.7,     // 1人あたりの消費
    foodFarmer: 1.5,      // 農民1人の生産（食料は農民・農場に強く依存）
    foodFarmBldg: 3,      // 農場1棟の生産
    foodFish: 2,          // 漁場1つの生産
    foodGather: 0.008,    // 領土からの採集（×tileCount。控えめ＝大国も油断できない）
    foodStoreBase: 36,    // 基本の備蓄上限（小さめ＝戦争・凶作が早く響く）
    foodStoreGranary: 48, // 穀倉1棟あたりの備蓄上限増
    famineDeathFood: 3,   // 食料不足この量ごとに1人が餓死
    // 火災の被害（延焼が集落に達したとき。建物・農地・住民へ波及する）
    fireHarm: 0.5,        // 燃えるタイルにいる人が1ティックに失う体力(食料)
    fireDeath: 0.06,      // 燃えるタイルにいる人が焼死する確率／ティック
    fireUnrest: 0.25,     // 焼かれた住民1人あたりの不満上昇（都市の動揺）
    fireBuildBurn: 0.5,   // 焼け跡・延焼中の建物が1評価で失われる確率
    foodHarbor: 4,        // 港1棟の漁獲（沿岸都市の食料）
    academyTech: 1.8,     // 学院1棟の技術寄与
    tavernCalm: 0.9,      // 酒場1棟の不満低減（娯楽・憩い）
    harborTrade: 0.5,     // 港1棟の交易力寄与（海上交易）
    diversityTech: 0.18,  // 民族の多様性による技術加速（多文化の交流＝開明）
    diversityFric: 0.02,  // 民族の多様性による軋轢（治安への小さな摩擦）
    // 宗教（信仰）: 神殿・記念碑・神官・政体(神権制)・敬虔な君主が信仰を篤くする。
    //   篤い信仰は民を結束させ（不満減）、布教力を高め、異教との戦に熱を加える。
    faithCalm: 6,         // 信仰1.0あたりの不満低減（社会の結束）
    faithDiploPull: 0.5,  // 同じ信仰の国は親しみ合う（外交関係の漸進）
    faithDiploFric: 0.35, // 異なる信仰の国とは隔たる（外交関係の摩擦）
    faithWarFervor: 0.6,  // 異教との開戦を後押しする信仰の熱（聖戦）
    schismChance: 0.5,    // 反乱・独立の際に宗派が分裂して異端が生まれる確率
    // 外交
    diploInterval: 90,  // 外交を評価する間隔(ティック)
    warThreshold: -50,   // 関係がこれ以下で開戦しうる
    allyThreshold: 60,   // これ以上で同盟しうる
    warChance: 0.35,
    peaceChance: 0.16,
    allyChance: 0.18,
    borderWindow: 400,   // この tick 数以内に接触があれば「隣国」とみなす
    warPressure: 0.55,   // 土地不足の隣国どうしは領土紛争で開戦しやすい
    maxAllies: 3,        // 1国が結べる同盟の上限（同盟の乱立を防ぐ）
    reignSpan: 1500,     // 君主の標準的な治世（これを超えると代替わりしうる）
    // 黄金時代・暗黒時代は固定の発生確率や持続期間を持たない。実測の活力(fortune)が
    //   持続して閾値を越えたときに「認識」されるだけで、興亡は既存の因果系が生み出す。
    decisiveRatio: 2.3,  // 軍事力比がこれ以上なら決定的（賠償・併合を強いる）
    tributeFrac: 0.45,   // 敗戦国が支払う富の割合
    annexRadius: 18,     // 併合時に割譲される都市周辺の半径
    // 講和・従属・休戦（戦争の結末を多様に）
    vassalChance: 0.55,  // 決定的勝利で、都市を奪う代わりに相手を属国(朝貢国)にする確率
    vassalTribute: 0.06, // 属国が毎評価で宗主へ納める富の割合（朝貢）
    vassalRevoltMil: 0.7,// 宗主の軍がこの倍率を下回ると属国が独立を試みる
    truceTicks: 1200,    // 講和後の休戦期間（この間は再戦しない）
    // 戦術（地形・防備）
    steerEvery: 3,       // 操舵(経路再計算)の間隔。間は前回の速度で前進（移動は毎ティック滑らか）
    homeDefense: 0.5,    // 自国領で戦う守備兵が受ける被害の軽減
    fortDefense: 0.5,    // 砦(KEEP)のある都市タイルの攻略しにくさ（防備）
    // 交易と平和（経済的相互依存は戦争を抑える）
    tradePeace: 0.6,     // 主要交易相手とは開戦しにくい（相互依存）
    // 交易（取引）: 文明どうしが余剰と不足を交換し、双方が富む（比較優位）。
    //   文明により交易力が違う＝政体(共和制)・気質(商才)・技術(車輪/航海)・資源・市場・商人。
    tradeBase: 2.4,       // 交易量の基準係数
    tradeAllyBonus: 1.8,  // 同盟国との通商条約は交易を大きく増やす
    tradeSeaPenalty: 0.55, // 海路交易（航海術）は陸路よりやや細い
    tradeWheelBonus: 1.5, // 車輪は陸路交易を増やす
    tradeMarketW: 0.35,   // 市場1棟あたりの交易力寄与
    tradeMerchantW: 0.05, // 商人1人あたりの交易力寄与
    tradeRoadBonus: 0.4,  // 街道網の交易力寄与
    tradeFoodPrice: 0.7,  // 食料1単位の取引価格（富）。飢饉国へ食料が流れる
    tradeFoodMax: 12,     // 1回の評価で動かせる食料の上限
    tradeToolPrice: 1.1,  // 武具1単位の取引価格（富）。軍需品の交易
    tradeToolMax: 6,      // 1回の評価で動かせる武具の上限
    tradeArbScale: 0.18,  // 価格差（裁定）から生まれる交易利益の係数
    // 貨幣（鋳貨）: ある程度の文明（鋳貨技術＋金鉱石）になると物々交換から貨幣経済へ。
    //   貨幣は交易を潤滑にし（gains from trade を増やす）、富の蓄積を助ける。
    goldWealth: 1.6,      // 金鉱石1つあたりの富の産出（宝石より高い）
    mintRate: 0.5,        // 鋳貨技術を持つ国が金鉱石1つから1評価で鋳造する貨幣
    coinCap: 40,          // 貨幣の保有上限（金鉱石数に比例。死蔵を防ぐ）
    coinTradeBonus: 1.5,  // 双方が貨幣を使うと交易利益が増す（取引費用の低下）
    coinTradeHalf: 1.2,   // 片方のみ貨幣の場合の交易ボーナス
    coinWealth: 0.004,    // 貨幣保有が富の蓄積を後押しする係数
    coinAdoptChance: 0.07, // 貨幣を使う相手に接した国が、時代に合わずとも貨幣を取り入れる確率
    coinFromTrade: 0.6,   // 交易から流入する外国の貨幣・金（金鉱が無くても商業で貨幣を使える）
    coinTradeCap: 30,     // 交易由来の貨幣保有上限（活発に交易するほど大きい）
    coinTradeCapW: 1.2,   // 交易量から保有上限を定める係数
    // 生産・装備（専門職が施設で働いて生み出す）
    workRadius: 3,       // 施設からこの距離以内なら「就労中」
    toolRate: 0.02,      // 鍛冶が1ティックに作る道具・武具
    masterwork: 0.3,     // 工芸力1.0あたりの業物（一段上の傑作）を打つ確率
    craftToolW: 0.4,     // 鍛冶場1棟あたりの道具産出（工芸力で増減）
    craftLuxW: 0.6,      // 工芸力による奢侈品（金・宝石）の付加価値
    // 生物群系の資源（地形ごとの恵み）
    horseMil: 0.06,      // 馬1つあたりの軍事力上乗せ（騎兵。上限あり）
    spiceWealth: 2.2,    // 香辛料1つの富（高値の奢侈。工芸で付加価値）
    timberWealth: 0.8,   // 良材1つの富（建材・交易）
    saltStore: 6,        // 塩1つあたりの食料備蓄上限の増加（保存）
    // 製錬の燃料（炭）: 領内の森林タイル数で表す。鉄・鋼ほど高い炉熱＝多くの燃料を要する。
    fuelIron: 6,         // 鉄器の製錬に要する燃料（森林）の最低量
    fuelSteel: 18,       // 鋼の製錬に要する燃料（さらに高い炉熱）
    steelCraft: 0.55,    // 鋼を打つのに要する工芸力（熟練の冶金）
    charcoalChance: 0.06,// 製鉄が森林を炭に費やし、森が後退する確率（史実の森林伐採）
    marketRate: 0.06,    // 商人が1ティックに生む富
    templeCalm: 0.02,    // 神官が1ティックに鎮める不満
    equipChance: 0.08,   // 就労時に在庫から装備を受け取る確率
    // 航海・植民（時代1以降、沿岸の開拓者が海を越えて新天地に植民する）
    embarkChance: 0.16,  // 近くに未開の陸が無い沿岸の開拓者が船出する確率
    sailSpeed: 0.5,      // 航海速度（陸の移動より速い）
    maxSailRange: 40,    // 船出して到達を試みる最大距離
    minSailGap: 6,       // 目的地まで最低この距離（海を隔てた別の陸）
    sailMetab: 0.004,    // 航海中の食料消費（海難のリスク）
    // 疫病（過密・低技術の都市で発生し、隣国へ伝播する）
    plagueChance: 0.05,    // 過密国で外交評価ごとに発生しうる確率
    plagueDuration: 7,     // 外交評価（diploInterval）何回ぶん続くか
    plagueMortality: 0.0006, // 流行中の1ティックあたり病没率
    plagueSpread: 0.25,    // 隣国へ広がる確率
  };

  const RULER_NAMES = ["Alaric", "Brana", "Cedric", "Dara", "Eirik", "Freya", "Galen", "Hilda", "Ivar", "Juno", "Kael", "Lyra", "Magnus", "Nadia", "Osric", "Petra", "Rurik", "Sigrid", "Tarek", "Ulla", "Viktor", "Wrenn"];

  // ===== 人種（民族）=====
  // 起源の地（気候）ごとに分かれた、見た目・わずかな環境適応・色を持つ集団。
  // 親から受け継がれ（混血で交わり）、地域ごとに多数派が生まれ、国の民族構成を成す。
  // 形質の偏りはごく小さく（±0.05）、能力の平均~1.0と経済バランスを崩さない。
  //   skins/hairs: 肌・髪の色（個体差つき）。bias: 環境適応の形質と量。
  //   col: 地図の人種ビューでの代表色。clime: 起源の気候 0=寒 1=温 2=熱。
  //   build: 体格（描画の大きさ倍率）。given/sur: 民族特有の名前の語幹（音節合成に使う）。
  const RACES = [
    { id: 0, name: "北方人", skins: ["#f3d3ad", "#efc79a", "#f7dcc0"], hairs: ["#caa84a", "#6b4f2a", "#8d6a3a"], bias: "vigor", amt: 0.05, col: [180, 200, 230], clime: 0, build: 1.1,
      given: ["Bjor", "Sven", "Eir", "Fro", "Gunn", "Hak", "Ing", "Knut", "Leif", "Odd", "Rag", "Sig", "Thor", "Ulf", "Vik", "Yrs"],
      sur: ["Frost", "Storm", "Ice", "Bear", "Wolf", "North", "Snow", "Fjord", "Thund", "Wind"] },
    { id: 1, name: "平原人", skins: ["#e8b887", "#d9a066", "#e0ad77"], hairs: ["#4a3422", "#2a1c10", "#6b4f2a"], bias: "dili", amt: 0.04, col: [150, 190, 120], clime: 1, build: 1.0,
      given: ["Ald", "Ber", "Cael", "Dun", "Ed", "Gar", "Hod", "Mil", "Os", "Rod", "Sam", "Tam", "Wal", "Bram", "Cob", "Gild"],
      sur: ["Field", "Wheat", "Oak", "Mead", "Plough", "Barley", "Green", "Mill", "Corn", "Acre"] },
    { id: 2, name: "森人", skins: ["#cda06a", "#bb9258", "#c9a878"], hairs: ["#2a1c10", "#15110b", "#3a2a18"], bias: "wit", amt: 0.05, col: [90, 160, 110], clime: 1, build: 0.93,
      given: ["Ael", "Cael", "Elw", "Fae", "Gal", "Ith", "Lael", "Myr", "Nael", "Sylv", "Thal", "Vael", "Ylw", "Ely", "Fin", "Lor"],
      sur: ["Leaf", "Moss", "Fern", "Glade", "Thorn", "Birch", "Willow", "Briar", "Elm", "Pine"] },
    { id: 3, name: "砂漠人", skins: ["#c68642", "#b5763a", "#a9764b"], hairs: ["#15110b", "#2a1c10"], bias: "vigor", amt: 0.04, col: [220, 190, 110], clime: 2, build: 0.97,
      given: ["Zah", "Ras", "Lay", "Nas", "Omar", "Far", "Hak", "Jam", "Kal", "Mun", "Raf", "Sal", "Tar", "Yas", "Zad", "Hass"],
      sur: ["Sand", "Sun", "Dune", "Ember", "Ash", "Mirage", "Dust", "Oasis", "Amber", "Sear"] },
    { id: 4, name: "島嶼人", skins: ["#a9764b", "#8d5524", "#9a6638"], hairs: ["#15110b", "#1c140c"], bias: "brave", amt: 0.04, col: [110, 190, 200], clime: 2, build: 1.02,
      given: ["Kai", "Man", "Tan", "Moa", "Lani", "Hua", "Rang", "Tane", "Vao", "Ari", "Mau", "Noa", "Sina", "Tui", "Aki", "Hok"],
      sur: ["Wave", "Reef", "Tide", "Coral", "Shell", "Surf", "Pearl", "Salt", "Drift", "Shore"] },
  ];
  function raceForClime(temp, moist, rand) {
    // 起源の地の気候から人種を定める（寒→北方、熱→砂漠/島嶼、温→平原/森）。
    if (temp < 0.36) return 0;                          // 寒冷 → 北方人
    if (temp > 0.66) return (moist > 0.5 ? 4 : 3);      // 高温 → 多湿:島嶼 / 乾燥:砂漠
    return (moist > 0.55 ? 2 : 1);                      // 温帯 → 多湿:森人 / それ以外:平原人
  }
  const GOV_TYPES = ["君主制", "共和制", "部族連合", "神権制", "氏族制", "帝国", "都市国家", "封建制"];
  // 政体ごとの振る舞い補正（指導者の性格 TRAITS と乗算して用いる）。
  // war=好戦性 ally=同盟志向 trade=交易 tech=技術 unrest=不満の溜まりやすさ
  // faith=布教力 expand=入植・拡張意欲
  const GOV_MODS = [
    { war: 1.2, ally: 1.0, trade: 1.0, tech: 1.0, unrest: 0.85, faith: 1.0, expand: 1.25 }, // 君主制: 中央集権・拡張的
    { war: 0.7, ally: 1.25, trade: 1.4, tech: 1.3, unrest: 1.0, faith: 0.9, expand: 0.9 },  // 共和制: 交易・技術重視
    { war: 1.5, ally: 0.9, trade: 0.8, tech: 0.8, unrest: 1.2, faith: 1.0, expand: 1.1 },   // 部族連合: 好戦・不安定
    { war: 1.0, ally: 1.0, trade: 0.9, tech: 0.85, unrest: 0.8, faith: 1.8, expand: 1.0 },  // 神権制: 信仰・安定
    { war: 1.15, ally: 1.4, trade: 1.0, tech: 0.9, unrest: 1.0, faith: 1.0, expand: 1.05 }, // 氏族制: 血縁同盟
    { war: 1.35, ally: 0.8, trade: 1.0, tech: 1.05, unrest: 0.8, faith: 1.0, expand: 1.4 },  // 帝国: 強権・拡張
    { war: 0.75, ally: 1.3, trade: 1.5, tech: 1.35, unrest: 0.95, faith: 0.95, expand: 0.7 }, // 都市国家: 商業・学術
    { war: 1.3, ally: 1.15, trade: 0.9, tech: 0.9, unrest: 1.1, faith: 1.05, expand: 1.15 },  // 封建制: 武門・諸侯
  ];
  const RELIGIONS = ["太陽信仰", "月の教団", "大地母神", "風の精霊", "祖霊崇拝", "星辰教"];
  const SECT_SUFFIX = ["改革派", "正統派", "異端", "刷新派", "原理派", "神秘派"];
  // 宗派分裂: 既存の信仰から派生した宗派の名を作る（基幹の信仰名＋派の名）。
  //   既に宗派なら基幹名（「・」より前）を取り、際限ない接尾辞の連結を防ぐ。
  function schismName(base, rand) {
    const root = base.indexOf("・") >= 0 ? base.slice(0, base.indexOf("・")) : base;
    return root + "・" + SECT_SUFFIX[(rand() * SECT_SUFFIX.length) | 0];
  }
  const ERAS = ["石器時代", "青銅器時代", "鉄器時代", "古典時代", "中世", "啓蒙時代"];
  const TECH_PER_ERA = 60;

  // 指導者の性格（国家の振る舞いを変調する）。
  const TRAITS = [
    { name: "好戦的", war: 1.9, ally: 0.5, trade: 0.8, tech: 1.0, unrest: 1.1, faith: 1.0 },
    { name: "温厚", war: 0.4, ally: 1.8, trade: 1.1, tech: 1.0, unrest: 0.7, faith: 1.0 },
    { name: "商才", war: 0.9, ally: 1.3, trade: 1.9, tech: 1.1, unrest: 0.9, faith: 1.0 },
    { name: "敬虔", war: 0.9, ally: 1.1, trade: 1.0, tech: 0.9, unrest: 0.8, faith: 2.0 },
    { name: "賢明", war: 0.8, ally: 1.2, trade: 1.1, tech: 1.6, unrest: 0.7, faith: 1.0 },
    { name: "残虐", war: 1.6, ally: 0.6, trade: 0.9, tech: 1.0, unrest: 1.35, faith: 1.0 },
    { name: "寛大", war: 0.7, ally: 1.5, trade: 1.2, tech: 1.0, unrest: 0.6, faith: 1.0 },
    { name: "狡猾", war: 1.2, ally: 1.1, trade: 1.4, tech: 1.15, unrest: 0.95, faith: 1.0 },
    { name: "開明", war: 0.85, ally: 1.2, trade: 1.2, tech: 1.4, unrest: 0.8, faith: 0.85 },
  ];

  // 国是（国家の持続的な気質）: 指導者が代わっても受け継がれる国の性格。
  // 政体・指導者と乗算して国ごとの個性を強める。値は穏やか(0.8〜1.3)に抑え均衡を保つ。
  const NATION_ETHOS = [
    { name: "武断国家", war: 1.25, expand: 1.15, tech: 0.95, trade: 0.95 },
    { name: "通商国家", trade: 1.3, war: 0.85, ally: 1.15 },
    { name: "開拓国家", expand: 1.3, war: 1.0, trade: 1.05 },
    { name: "学究国家", tech: 1.25, war: 0.85, trade: 1.05 },
    { name: "信仰国家", faith: 1.3, unrest: 0.85, war: 1.0 },
    { name: "隠逸国家", expand: 0.75, war: 0.8, ally: 0.9, trade: 0.92, unrest: 0.9 },
    { name: "自由国家", trade: 1.15, tech: 1.1, ally: 1.15, unrest: 0.85 },
  ];
  function ethosName(e) { return e ? e.name : "—"; }

  // 個別の技術発見。tech 値が閾値 at を超えると獲得し、具体的な恩恵を得る。
  const TECHS = [
    { id: "agri", name: "農耕", at: 20 },     // 食料・人口扶養力
    { id: "writing", name: "文字", at: 48 },  // 技術の進歩を加速
    { id: "wheel", name: "車輪", at: 80 },    // 交易・富
    { id: "coin", name: "鋳貨", at: 100 },    // 貨幣経済（金鉱石を鋳造し交易を潤す）
    { id: "bronze", name: "青銅器", at: 120 }, // 軍事
    { id: "sail", name: "航海術", at: 150 },  // 海を越える植民
    { id: "iron", name: "鉄器", at: 185 },    // 軍事
    { id: "law", name: "法典", at: 215 },     // 社会の安定（不満減）
    { id: "gunpowder", name: "火薬", at: 290 }, // 軍事（大）
    { id: "printing", name: "印刷", at: 340 },  // 技術の進歩を大きく加速
  ];
  function hasTech(k, id) { return !!(k.techBits && k.techBits[id]); }

  function eraOf(tech) {
    let i = (tech / TECH_PER_ERA) | 0;
    if (i >= ERAS.length) i = ERAS.length - 1;
    return ERAS[i];
  }

  // ===== 人間の個性・能力・練度・機嫌（社会を形成するための内面）=====
  // 各人は生まれつきの性格3軸を持ち、年齢で能力が変化し、経験で練度が伸び、
  // 暮らし向きで機嫌が上下する。これらを合成した「実効能力」が生産・戦闘に効く。
  // 設計上、集団平均の実効能力が ~1.0 になるよう各係数を中央化し、丹精込めて
  // 調整した経済・人口バランスを壊さないようにしている。
  //   dili  勤勉さ … 生産（耕作・鍛冶・交易・布教）に効く
  //   brave 勇敢さ … 戦闘・脅威への立ち向かい/逃走判断に効く
  //   wit   賢さ   … 学習（練度の伸び）・職の適応に効く
  const TRAIT_MIN = 0.65, TRAIT_MAX = 1.35;
  function clampTrait(v) { return v < TRAIT_MIN ? TRAIT_MIN : v > TRAIT_MAX ? TRAIT_MAX : v; }
  // 無所属/初期世代の性格（平均1.0・幅0.75〜1.25）。
  function randTrait(rand) { return 0.75 + rand() * 0.5; }
  // 親の素質を受け継ぎつつ、ばらつき（突然変異）を加える。
  function inheritTrait(rand, p) { return clampTrait((p == null ? 1 : p) + (rand() - 0.5) * 0.24); }
  // 加齢による能力曲線。子供は未熟、成人で最盛、老いとともに衰える。平均 ~1.0。
  function ageFactor(age) {
    if (age < CP.adultAge) return 0.55 + 0.45 * (age / CP.adultAge); // 子供: 0.55→1.0
    if (age <= CP.elderAge) {
      // 成人期はわずかに山なり（中年で最盛 ~1.03、若年・初老で ~1.0）。
      const t = (age - CP.adultAge) / (CP.elderAge - CP.adultAge); // 0..1
      return 1.0 + 0.06 * Math.sin(Math.PI * t);
    }
    const t = Math.min(1, (age - CP.elderAge) / (CP.maxAge - CP.elderAge)); // 0..1
    return 1.0 - 0.45 * t; // 老人: 1.0→0.55
  }
  // 練度(0..1)→係数（0.78〜1.22、平均練度~0.5で~1.0）。
  function skillFactor(s) { return 0.78 + 0.44 * (s || 0); }
  // 機嫌(0..1)→係数。社会的なつながりで人々の機嫌は平時 ~0.65 に落ち着くため、
  // その均衡で ~1.0 になるよう中央化（経済バランスを壊さない）。
  function moodFactor(m) { return 0.71 + 0.45 * (m == null ? 0.6 : m); }
  // 実効能力。性格×加齢×練度×機嫌。traitKey 省略時は勤勉さ(dili)を用いる。
  function ability(h, traitKey) {
    const t = traitKey ? (h[traitKey] || 1) : (h.dili || 1);
    return t * ageFactor(h.age) * skillFactor(h.skill) * moodFactor(h.mood);
  }
  // シナプスの可塑性: 現在値を目標へ近づける。身につく(up)のは速く、抜ける(down)のは
  // 遅い＝一度刻まれた用心・習い性は長く残る（経験が気質を恒久的に形づくる）。
  // 学習後の値は繁殖時に子へ受け継がれるため、危険な地の集団は世代を経て用心深くなる。
  function learn(v, target, up, down) {
    const cur = v == null ? 1 : v;
    const rate = target > cur ? up : down;
    const n = cur + (target - cur) * rate;
    return n < 0.65 ? 0.65 : n > 1.35 ? 1.35 : n;
  }
  // 親があれば中間値を、無ければランダムに継承する1形質。
  function heritTrait(rand, a, b) {
    if (a != null && b != null) return inheritTrait(rand, (a + b) / 2);
    if (a != null) return inheritTrait(rand, a);
    return randTrait(rand);
  }
  // 志（人生の長期目標）: 最も際立つ素質から定まる生き方。行動の持続的な偏りになる。
  //   0=立身(均衡・出世) 1=武功(勇) 2=探求(知) 3=蓄財(勤) 4=家族(社交)。
  const ASPIRE_NAMES = ["立身", "武功", "探求", "蓄財", "家族"];
  function pickAspire(h) {
    let best = 0, bv = 1.08;
    if ((h.brave || 1) > bv) { bv = h.brave; best = 1; }
    if ((h.wit || 1) > bv) { bv = h.wit; best = 2; }
    if ((h.dili || 1) > bv) { bv = h.dili; best = 3; }
    if ((h.synSoc || 1) > bv) { bv = h.synSoc; best = 4; }
    return best;
  }
  // 生まれたばかり/置かれたばかりの人に内面を授ける。親(pa,pb)があれば遺伝する。
  // 内面は3層: ①生得形質(性格・体質) ②シナプス配線(判断の偏り・遺伝) ③感情(その場の状態)。
  function endow(h, rand, pa, pb) {
    // ① 生得形質。
    h.dili = heritTrait(rand, pa && pa.dili, pb && pb.dili);
    h.brave = heritTrait(rand, pa && pa.brave, pb && pb.brave);
    h.wit = heritTrait(rand, pa && pa.wit, pb && pb.wit);
    h.vigor = heritTrait(rand, pa && pa.vigor, pb && pb.vigor);
    // ② シナプス配線: 競合する欲求の重みづけ（脳の個性）。遺伝し、選択を受ける。
    //    安全志向 / 食欲 / 社交欲 をどれだけ優先するかが人により異なる。
    h.synSafe = heritTrait(rand, pa && pa.synSafe, pb && pb.synSafe);
    h.synFood = heritTrait(rand, pa && pa.synFood, pb && pb.synFood);
    h.synSoc = heritTrait(rand, pa && pa.synSoc, pb && pb.synSoc);
    // 志: 最も際立つ素質からその人の生き方が定まる（遺伝した形質に基づく）。
    h.aspire = pickAspire(h);
    // ③ 感情（0..1, 時間で減衰。出来事で高ぶり、行動を左右する）。
    h.fear = 0; h.anger = 0; h.joy = 0;
    h.sight = 5; // 視野（_think で毎回再計算される初期値）
    h.skill = 0.06 + rand() * 0.08; // 練度は低くから始まり、経験で伸びる
    h.mood = 0.6;                    // 機嫌（感情の集約。普通から始まる）
    return h;
  }
  // 仕事を続けて練度を上げる（賢い者ほど速く習熟する）。役割変更で skill は別途下がる。
  function practice(h) {
    if (h.skill < 1) { h.skill += (1 - h.skill) * 0.0007 * (h.wit || 1); if (h.skill > 1) h.skill = 1; }
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // ===== 社会・人間関係（会話で結びつき、影響し合い、社会を形づくる）=====
  // 人名: 音節を組み合わせて固有名を作る（年代記・インスペクタで個人を指す）。
  const PERSON_A = ["Al", "Bre", "Cas", "Dor", "El", "Fen", "Gar", "Hel", "Ir", "Jor", "Ka", "Lo", "Mar", "Ned", "Or", "Pol", "Rin", "Sel", "Tor", "Ul", "Ven", "Wyn", "Yas", "Zel", "Ash", "Bryn", "Cor", "Dag"];
  const PERSON_B = ["a", "e", "i", "o", "ae", "ia", "or", "an", "en", "wyn", "ric", "mund", "gar", "dis", "wen", "far", "lin", "eth", "ulf", "win"];
  function personName(rand) { return PERSON_A[(rand() * PERSON_A.length) | 0] + PERSON_B[(rand() * PERSON_B.length) | 0]; }
  // 家名（姓）。創始者に与えられ、以後は父方の血統を通じて受け継がれる。
  const SUR_A = ["Stone", "Iron", "Oak", "Wolf", "Raven", "Hart", "Ash", "Black", "White", "Strong", "Swift", "Bright", "Frost", "Storm", "Gold", "Red", "Grey", "High", "Fair", "Stark"];
  const SUR_B = ["ward", "born", "wood", "field", "ford", "hill", "vale", "moor", "brook", "crest", "bane", "heart", "mark", "guard", "well", "ridge"];
  function surname(rand) { return SUR_A[(rand() * SUR_A.length) | 0] + SUR_B[(rand() * SUR_B.length) | 0]; }
  // 人種ごとの固有名・家名。各民族の語幹(given/sur)に共通の接尾辞を合成し、
  //   「北方人は Bjornwyn / Frostward」「島嶼人は Kaia / Wavecrest」のように
  //   民族で名前の響きが分かれる。語幹が無い人種は従来の汎用生成にフォールバック。
  function personNameFor(rid, rand) {
    const R = RACES[rid];
    if (!R || !R.given) return personName(rand);
    return R.given[(rand() * R.given.length) | 0] + PERSON_B[(rand() * PERSON_B.length) | 0];
  }
  function surnameFor(rid, rand) {
    const R = RACES[rid];
    if (!R || !R.sur) return surname(rand);
    return R.sur[(rand() * R.sur.length) | 0] + SUR_B[(rand() * SUR_B.length) | 0];
  }

  // ===== 言語（言葉の通じ合い・方言の分岐・同化）=====
  // 各人は2次元の「言語空間」(lx,ly)上の一点として言葉を持つ。建国時に国の言語が定まり、
  // 子は親の言葉を受け継ぎつつ僅かに変異し（世代を経て方言が分岐）、会話相手へ歩み寄る
  // （収束＝同化・共通語の形成）。征服・交易で国家間の言葉も借用し合い近づく。
  // 相互理解度(mutual intelligibility)が会話の濃さ（学習・気分/文化の伝播・友誼）を左右する。
  function mutualIntel(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    const d = Math.sqrt(dx * dx + dy * dy);
    let mi = 1 - d / CP.langScale;
    if (mi < CP.langFloor) mi = CP.langFloor; else if (mi > 1) mi = 1;
    return mi;
  }
  // 言語空間の位置を色に（言語ビュー: 近い言葉＝近い色）。2軸を色相・明度に対応。
  function langColor(lx, ly) {
    lx = clamp01(lx); ly = clamp01(ly);
    const hue = lx * 360, l = 90 + ly * 60, c = 120;
    const kk = hue / 60, x = c * (1 - Math.abs((kk % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (kk < 1) { r = c; g = x; } else if (kk < 2) { r = x; g = c; } else if (kk < 3) { g = c; b = x; }
    else if (kk < 4) { g = x; b = c; } else if (kk < 5) { r = x; b = c; } else { r = c; b = x; }
    return [(r + l) | 0, (g + l) | 0, (b + l) | 0];
  }
  // 言語の名前（語族）: 言語空間の位置から決定的に音節を組み、言葉に名を与える（UI用）。
  const LANG_ON = ["Va", "Th", "Ka", "Sho", "Mi", "Lu", "Ne", "Or", "Ya", "Zi", "Be", "Ga", "Ru", "Fae", "Hol", "Ty"];
  const LANG_NU = ["la", "rin", "sk", "do", "vi", "ka", "ven", "th", "no", "ria", "mar", "lo", "sha", "gan", "wyn", "ul"];
  const LANG_SU = ["ish", "an", "ic", "ese", "ari", "en", "oth", "ic", "ai", "or"];
  function langName(lx, ly) {
    const a = Math.min(LANG_ON.length - 1, (clamp01(lx) * LANG_ON.length) | 0);
    const b = Math.min(LANG_NU.length - 1, (clamp01(ly) * LANG_NU.length) | 0);
    const c = Math.min(LANG_SU.length - 1, (((clamp01(lx) + clamp01(ly)) * 0.5) * LANG_SU.length) | 0);
    return LANG_ON[a] + LANG_NU[b] + LANG_SU[c] + "語";
  }
  // 近親か（親子・兄弟姉妹）。近親婚を避け、外婚（exogamy）を促すために用いる。
  function closeKin(a, b) {
    if (!a.pid || !b.pid) return false;
    if (a.momId === b.pid || a.dadId === b.pid) return true; // b は a の親
    if (b.momId === a.pid || b.dadId === a.pid) return true; // a は b の親
    if (a.momId && a.momId === b.momId) return true;         // 同じ母＝兄弟姉妹
    if (a.dadId && a.dadId === b.dadId) return true;         // 同じ父＝兄弟姉妹
    return false;
  }

  // 名声(prestige)→社会的影響力。名士の言葉ほど人を動かす（機嫌・文化・技を伝える力）。
  function influence(h) {
    const p = h.prestige || 0;
    return 1 + (p > 12 ? 12 : p) * 0.12; // 1.0〜2.44
  }
  // その人にふさわしい称号を、最も秀でた点から定める（名声が高まった時に名乗る）。
  function titleOf(h) {
    if (h.role === ROLE.SOLDIER) return "英雄";
    if (h.role === ROLE.PRIEST) return "聖人";
    if (h.role === ROLE.MERCHANT) return "豪商";
    if (h.role === ROLE.SMITH) return "名工";
    if (h.role === ROLE.FARMER) return "篤農";
    if ((h.wit || 1) >= 1.18) return "賢者";
    if ((h.age || 0) >= CP.elderAge) return "古老";
    return "名士";
  }
  const FAME_THRESHOLD = 6; // この名声を超えると「名のある人物」として歴史に刻まれる
  // 親友関係の上限（1人が深く結びつく相手の数）。
  const MAX_BONDS = 4;

  function CivSystem(world, renderer) {
    this.world = world;
    this.renderer = renderer;
    this.rand = Game.utils.mulberry32((Game.config.seed ^ 0x5bd1e995) >>> 0);
    this.kingdoms = [null];
    this.people = [];   // 人間エージェント
    this._pidSeq = 0;   // 個人ID採番（個体識別・人間関係に用いる）
    this._births = [];  // 当ティックに生まれた子（次ティックから処理）
    this._tickN = 0;
    this._tcursor = 0; // 領土メンテ走査の行カーソル
    this.events = [];  // 年代記（世界の主要な出来事のログ）
    this.marks = [];   // 戦場の痕跡（戦死地点。時間で薄れて消える）
    this.statsHist = []; // 世界統計の履歴（人口・国数・領土の推移。概観パネル用）
    // 近傍探索グリッド。
    this._cap = Game.config.sim.maxPeople;
    this._next = new Int32Array(this._cap);
    this._head = null;
    this._gw = 0;
    this._gh = 0;
  }

  // 年代記に出来事を記録する（新しいものを末尾に、上限つき）。
  CivSystem.prototype._logEvent = function (text) {
    const clk = Game.state.clock;
    this._evSeq = (this._evSeq || 0) + 1;
    this.events.push({ year: clk ? clk.year : 0, text: text, seq: this._evSeq });
    if (this.events.length > 80) this.events.shift();
  };

  // 戦場の痕跡を残す（戦死地点。描画でしばらく赤黒く残り薄れていく）。
  CivSystem.prototype._addMark = function (x, y) {
    const m = this.marks;
    m.push({ x: x, y: y, ttl: 360, life: 360 });
    if (m.length > 240) m.shift();
  };

  // UI 用: 直近の出来事（新しい順）。
  CivSystem.prototype.getEvents = function (n) {
    const out = [];
    const ev = this.events;
    const m = Math.min(n || 12, ev.length);
    for (let i = 0; i < m; i++) out.push(ev[ev.length - 1 - i]);
    return out;
  };

  CivSystem.prototype.setWorld = function (world) {
    this.world = world;
    this.people.length = 0;
    this._births.length = 0;
  };

  CivSystem.prototype.clear = function () {
    this.kingdoms = [null];
    this.people.length = 0;
    this._births.length = 0;
    this.events.length = 0;
    this.marks.length = 0;
    if (this.world) this.world.owner.fill(0);
  };

  CivSystem.prototype.colorOf = function (id) {
    const k = this.kingdoms[id];
    return k ? k.color : null;
  };

  // ===== 地図ビュー（区分の可視化）=====
  // 政体・宗教・時代ごとの配色。区分が同じ国は同じ色で塗られ、勢力図が一目で分かる。
  const GOV_COLORS = [
    [196, 88, 72],   // 君主制（赤）
    [78, 150, 210],  // 共和制（青）
    [200, 150, 60],  // 部族連合（橙）
    [150, 110, 210], // 神権制（紫）
    [90, 180, 120],  // 氏族制（緑）
    [150, 60, 60],   // 帝国（深紅）
    [80, 200, 200],  // 都市国家（青緑）
    [120, 100, 70],  // 封建制（褐）
  ];
  const REL_COLORS = [
    [230, 190, 70], [150, 170, 220], [110, 180, 110],
    [120, 210, 200], [200, 130, 90], [180, 140, 220],
  ];
  const ERA_COLORS = [
    [120, 110, 96], [150, 120, 80], [120, 140, 160],
    [200, 180, 110], [150, 170, 200], [220, 210, 160],
  ];
  // 文字列（家名）から決定的に色を作る（王朝ビュー: 同じ王朝＝同じ色）。
  function hashColor(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    const hue = h % 360, c = 150, l = 110;
    // 簡易 HSL→RGB（彩度・明度は固定で見やすく）。
    const k = hue / 60, x = c * (1 - Math.abs((k % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (k < 1) { r = c; g = x; } else if (k < 2) { r = x; g = c; } else if (k < 3) { g = c; b = x; }
    else if (k < 4) { g = x; b = c; } else if (k < 5) { r = x; b = c; } else { r = c; b = x; }
    return [(r + l) | 0, (g + l) | 0, (b + l) | 0];
  }
  // 文化値(0..1)を冷→暖のグラデーションに（文化ビュー: 近い文化＝近い色）。
  function cultureColor(v) {
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    return [(80 + v * 160) | 0, (120 + (0.5 - Math.abs(v - 0.5)) * 120) | 0, (220 - v * 150) | 0];
  }

  // 現在の地図ビューに応じた国 id の表示色。renderer が領土の塗りに用いる。
  CivSystem.prototype.viewColorOf = function (id) {
    const k = this.kingdoms[id];
    if (!k) return null;
    const mode = (Game.state && Game.state.mapView) || "nation";
    if (mode === "gov") return GOV_COLORS[GOV_TYPES.indexOf(k.gov)] || k.color;
    if (mode === "religion") { const ri = RELIGIONS.indexOf(k.religion); return ri >= 0 ? REL_COLORS[ri] : hashColor(k.religion || ""); }
    if (mode === "era") { let i = (k.tech / TECH_PER_ERA) | 0; if (i >= ERA_COLORS.length) i = ERA_COLORS.length - 1; if (i < 0) i = 0; return ERA_COLORS[i]; }
    if (mode === "dynasty") return k.dynasty ? hashColor(k.dynasty) : k.color;
    if (mode === "culture") return cultureColor(k.cultureAvg == null ? 0.5 : k.cultureAvg);
    if (mode === "race") { const R = RACES[k.race == null ? 1 : k.race]; return R ? R.col : k.color; }
    if (mode === "language") return langColor(k.langX == null ? 0.5 : k.langX, k.langY == null ? 0.5 : k.langY);
    return k.color; // nation（既定）
  };

  // 現在のビューの凡例（UI用）: [{label, color}]。
  CivSystem.prototype.viewLegend = function (mode) {
    mode = mode || (Game.state && Game.state.mapView) || "nation";
    const out = [];
    if (mode === "gov") for (let i = 0; i < GOV_TYPES.length; i++) out.push({ label: GOV_TYPES[i], color: GOV_COLORS[i] });
    else if (mode === "religion") for (let i = 0; i < RELIGIONS.length; i++) out.push({ label: RELIGIONS[i], color: REL_COLORS[i] });
    else if (mode === "era") for (let i = 0; i < ERAS.length; i++) out.push({ label: ERAS[i], color: ERA_COLORS[i] });
    else if (mode === "culture") { out.push({ label: "文化 A", color: cultureColor(0.1) }); out.push({ label: "中間", color: cultureColor(0.5) }); out.push({ label: "文化 B", color: cultureColor(0.9) }); }
    else if (mode === "race") for (let i = 0; i < RACES.length; i++) out.push({ label: RACES[i].name, color: RACES[i].col });
    else if (mode === "language") {
      out.push({ label: langName(0.15, 0.3), color: langColor(0.15, 0.3) });
      out.push({ label: langName(0.5, 0.5), color: langColor(0.5, 0.5) });
      out.push({ label: langName(0.85, 0.7), color: langColor(0.85, 0.7) });
      out.push({ label: "近い色＝近い言葉", color: [150, 150, 150] });
    }
    return out;
  };

  // 人種名（UI用）。
  CivSystem.prototype.raceName = function (id) { const R = RACES[id]; return R ? R.name : "—"; };
  // 言語名（UI用）: 国・人それぞれの言葉に名を与える。
  CivSystem.prototype.langNameOf = function (k) { return k ? langName(k.langX == null ? 0.5 : k.langX, k.langY == null ? 0.5 : k.langY) : "—"; };
  CivSystem.prototype.personLangName = function (p) { return p && p.lx != null ? langName(p.lx, p.ly) : "—"; };
  // 2国の言葉の通じ合い（0..1, UI用）。
  CivSystem.prototype.langMI = function (ka, kb) {
    if (!ka || !kb || ka.langX == null || kb.langX == null) return 1;
    return mutualIntel(ka.langX, ka.langY, kb.langX, kb.langY);
  };
  // 国の民族構成（UI用）: [{name, pct}] 降順。
  CivSystem.prototype.raceMixOf = function (k) {
    if (!k || !k.raceMix || !k.raceTot) return [];
    const out = [];
    for (let i = 0; i < k.raceMix.length; i++) if (k.raceMix[i] > 0) out.push({ name: RACES[i].name, pct: Math.round(100 * k.raceMix[i] / k.raceTot) });
    out.sort(function (a, b) { return b.pct - a.pct; });
    return out;
  };

  const NAME_A = ["Ar", "Bel", "Cor", "Dra", "El", "Fen", "Gor", "Hal", "Ish", "Kor", "Lor", "Mor", "Nor", "Or", "Per", "Quel", "Rho", "Syl", "Tor", "Ul", "Var", "Wyn", "Xan", "Yor", "Zar"];
  const NAME_B = ["a", "e", "i", "o", "u", "ae", "ia", "or", "en", "an"];
  const NAME_C = ["dor", "gard", "heim", "land", "mar", "nia", "ria", "thal", "vale", "wick", "stead", "moor", "fell", "reach"];
  function makeName(rand) {
    return NAME_A[(rand() * NAME_A.length) | 0] +
      NAME_B[(rand() * NAME_B.length) | 0] +
      NAME_C[(rand() * NAME_C.length) | 0];
  }

  function makeColor(rand) {
    const h = rand() * 360;
    const s = 0.65, l = 0.55;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = l - c / 2;
    return [((r + m) * 255) | 0, ((g + m) * 255) | 0, ((b + m) * 255) | 0];
  }

  // 陸地かつ無所属の (x,y) に新王国レコードを作り、首都タイルを領有する。
  // 成否は王国 k を返す / null。住人の用意は呼び出し側。
  CivSystem.prototype._newKingdom = function (x, y) {
    const world = this.world;
    if (!world.inBounds(x, y)) return null;
    const i = y * world.width + x;
    if (world.owner[i] !== 0) return null;
    if (!tile.isLand(world.terrain[i])) return null;
    if (this.kingdoms.length - 1 >= Game.config.sim.maxKingdoms) return null;

    const id = this.kingdoms.length;
    const govIdx = (this.rand() * GOV_TYPES.length) | 0;
    const k = {
      id: id,
      name: makeName(this.rand),
      ruler: RULER_NAMES[(this.rand() * RULER_NAMES.length) | 0], // 表示名（実在の統治者から更新される）
      rulerRef: null, // 統治者である実在の人物（_succeed が選ぶ）
      rulerPid: 0,
      dynasty: null,  // 王朝＝統治者の家名（世襲で継がれ、王朝交代で変わる）
      reign: 0,      // 現君主の在位（ティック）。継承で 0 に戻る
      gov: GOV_TYPES[govIdx],
      govMod: GOV_MODS[govIdx], // 政体の振る舞い補正
      color: makeColor(this.rand),
      cities: [{ x: x, y: y, capital: true, level: 1, buildings: [{ x: x, y: y, t: BUILDING.KEEP }] }],
      tileCount: 1,
      humanCount: 0,
      roleCount: [0, 0, 0, 0, 0, 0, 0],
      facilities: newFacilities(), // 機能建築の総数
      tools: 0,      // 道具・武具の備蓄（鍛冶が生産・住民が装備）
      clanSeq: 0,
      relations: {}, // 既知の他国 id → 関係値(-100..100)
      borders: {},   // 隣接した他国 id → 最後に接触した tick（隣国判定）
      wars: {},      // 交戦中の id → 開戦 tick
      allies: {},    // 同盟中の id → true
      truce: {},     // 休戦中の id → 解除 tick（この間は再戦しない）
      vassals: {},   // 属国の id → true（朝貢を受け、戦に従える）
      suzerain: 0,   // 宗主国の id（0=独立）
      langX: this.rand(), langY: this.rand(), // 国の言語（言語空間の位置。住民の言葉の重心で更新）
      coin: 0,       // 鋳造された貨幣の量（鋳貨技術＋金鉱石で増える。交易・富を潤す）
      tech: 0,       // 技術力（時代の指標）
      techBits: {},  // 獲得済みの個別技術（id→true）
      discovered: [], // 発見順の技術名（表示用）
      religion: RELIGIONS[(this.rand() * RELIGIONS.length) | 0],
      faith: 0.3,    // 信仰の篤さ(0..1)。神殿・神官・政体・敬虔さで高まり、結束/布教/聖戦に効く
      craft: 0.2,    // 工芸力(0..1)。鍛冶場・職人・金属・技術で育ち、装備の質と道具の産出に効く
      trait: TRAITS[(this.rand() * TRAITS.length) | 0], // 指導者の性格
      ethos: NATION_ETHOS[(this.rand() * NATION_ETHOS.length) | 0], // 国是（持続的な国の気質）
      wealth: 0,     // 富（交易・領土から蓄積）
      food: 30,      // 食料備蓄（生産-消費。0で飢饉）
      famine: false, // 飢饉中か（繁殖停止・餓死）
      unrest: 0,     // 不満（戦争・過密・貧困で上昇 → 反乱）
      plague: 0,     // 疫病の残り評価回数（>0 で流行中）
      res: { ore: 0, fish: 0, gems: 0, gold: 0, horses: 0, spice: 0, salt: 0, timber: 0 }, // 領有資源（_tallyResources が更新）
      tradeVol: 0,    // 直近の交易量（活況の指標。毎評価で減衰し交易で増える）
      tradeIncome: 0, // 直近評価での交易による富の増分（表示用）
      foodTrade: 0,   // 直近の食料の純流入（+輸入 / -輸出）。飢饉の緩和を示す
      partners: null, // 主要な交易相手 id→直近交易量（描画・UI用）
      alive: true,
    };
    this.kingdoms.push(k);
    world.owner[i] = id;
    if (this.renderer) this.renderer.markTerritoryDirty(x, y);
    return k;
  };

  // 直接建国（テスト/内部用）。入植者集団も同時に置く。王国IDを返す（失敗時 -1）。
  CivSystem.prototype.foundAt = function (x, y) {
    const k = this._newKingdom(x, y);
    if (!k) return -1;
    const clan = ++k.clanSeq;
    for (let n = 0; n < CP.popStart; n++) {
      const h = this._spawnHuman(k, x + 0.5, y + 0.5, clan, this._assignRole(k), 0.9);
      if (h) this.people.push(h);
    }
    return k.id;
  };

  // 放浪者（無所属の人間, kid=0）を置く。彼らが集まり、やがて国を興す。
  CivSystem.prototype.spawnNomad = function (x, y) {
    const world = this.world;
    if (!world.inBounds(x, y)) return false;
    if (!tile.isLand(world.getTerrain(x, y))) return false;
    if (this.people.length + this._births.length >= Game.config.sim.maxPeople) return false;
    const h = {
      x: x + 0.5, y: y + 0.5, hx: 0, hy: 0,
      kid: 0, clan: 0,
      age: 0, food: 0.9,
      role: ROLE.EXPLORER, state: 0,
      gx: x, gy: y, work: null, gear: 0,
      repro: CP.reproCooldown, social: 0, alive: true,
    };
    this._endow(h);
    this.people.push(h);
    return true;
  };

  // 王国の現状に応じて職業を割り当てる。食料を支える農民を確保しつつ、
  // 対応施設（鍛冶場・市場・神殿）があれば専門職を、戦時は兵士を多く育てる。
  CivSystem.prototype._assignRole = function (k) {
    const total = k.humanCount + 1;
    if (k.roleCount[ROLE.FARMER] / total < 0.34) return ROLE.FARMER;
    const f = k.facilities || {};
    const atWar = this._count(k.wars) > 0;
    const r = this.rand();
    // 専門職: 職場となる施設があり、まだ足りていなければ就かせる。
    if (f.smithy > 0 && k.roleCount[ROLE.SMITH] < f.smithy * 3 && r < 0.14) return ROLE.SMITH;
    if (f.market > 0 && k.roleCount[ROLE.MERCHANT] < f.market * 3 && r < 0.26) return ROLE.MERCHANT;
    if (f.temple > 0 && k.roleCount[ROLE.PRIEST] < f.temple * 2 && r < 0.34) return ROLE.PRIEST;
    if (atWar) {
      // 動員: 新たに育つ世代の多くが兵士になる。
      if (r < 0.6) return ROLE.SOLDIER;
      if (r < 0.8) return ROLE.EXPLORER;
      return ROLE.BUILDER;
    }
    if (r < 0.55) return ROLE.EXPLORER;
    if (r < 0.72) return ROLE.SOLDIER;
    return ROLE.BUILDER;
  };

  // 全都市の建物から機能建築の数を集計する（建設・占領・反乱で変動するため）。
  CivSystem.prototype._recountFacilities = function (k) {
    const f = k.facilities || (k.facilities = newFacilities());
    f.temple = f.farm = f.smithy = f.market = f.barracks = f.granary = 0;
    f.mine = f.academy = f.harbor = f.tavern = f.wonder = 0;
    for (let c = 0; c < k.cities.length; c++) {
      const bs = k.cities[c].buildings;
      if (!bs) continue;
      for (let i = 0; i < bs.length; i++) {
        switch (bs[i].t) {
          case BUILDING.TEMPLE: f.temple++; break;
          case BUILDING.FARM: f.farm++; break;
          case BUILDING.SMITHY: f.smithy++; break;
          case BUILDING.MARKET: f.market++; break;
          case BUILDING.BARRACKS: f.barracks++; break;
          case BUILDING.GRANARY: f.granary++; break;
          case BUILDING.MINE: f.mine++; break;
          case BUILDING.ACADEMY: f.academy++; break;
          case BUILDING.HARBOR: f.harbor++; break;
          case BUILDING.TAVERN: f.tavern++; break;
          case BUILDING.WONDER: f.wonder++; break;
        }
      }
    }
  };

  // (x,y) から最も近い type の機能建築の座標を返す（職場探し）。
  CivSystem.prototype._nearestFacility = function (k, x, y, type) {
    let best = null, bd = 1e18;
    for (let c = 0; c < k.cities.length; c++) {
      const bs = k.cities[c].buildings;
      if (!bs) continue;
      for (let i = 0; i < bs.length; i++) {
        if (bs[i].t !== type) continue;
        const dx = bs[i].x - x, dy = bs[i].y - y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = bs[i]; }
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  };

  // 指導者の性格(TRAITS)と政体(GOV_MODS)を合成した実効補正値。
  CivSystem.prototype._eff = function (k, f) {
    const t = k.trait ? (k.trait[f] || 1) : 1;
    const g = k.govMod ? (k.govMod[f] || 1) : 1;
    const e = k.ethos ? (k.ethos[f] || 1) : 1; // 国是（持続的な国の気質）
    return t * g * e;
  };

  // ka が b を「隣国」とみなすか（直近 borderWindow tick 以内に接触）。
  CivSystem.prototype._isNeighbor = function (ka, b) {
    if (!ka.borders) return false;
    const t = ka.borders[b];
    return t !== undefined && (this._tickN - t) <= CP.borderWindow;
  };

  // 人に内面と社会的アイデンティティを授ける（個性＋固有名・名声・人間関係・文化）。
  // 親(pa,pb)があれば性格・文化を遺伝する。
  CivSystem.prototype._endow = function (h, pa, pb) {
    if (h.dili === undefined) endow(h, this.rand, pa, pb); // 性格・練度・機嫌
    if (h.pid === undefined) {
      h.pid = ++this._pidSeq;
      // 人種（民族）: 親があればどちらかの人種を受け継ぐ（混血）。創始者は起源の地の
      //   気候で定まる（寒冷→北方人 等）。名前の響きにも影響するので最初に定める。
      let rid;
      if (pa && this.rand() >= CP.raceGenesis) {
        const ra = pa.race != null ? pa.race : 1;
        const rb = (pb && pb.race != null) ? pb.race : ra;
        rid = this.rand() < 0.5 ? ra : rb; // 混血: どちらかの親の人種
      } else {
        // 創始者、または稀な民族の独自進化（民族発生）: 移り住んだ土地の気候に適応した
        //   民族へと枝分かれする。世代を経て孤立した集団が新たな民族性を獲得していく。
        const w = this.world, i = (h.y | 0) * w.width + (h.x | 0);
        const t = w.temperature ? w.temperature[i] : 0.5;
        const m = w.moisture ? w.moisture[i] : 0.5;
        rid = raceForClime(t, m, this.rand);
      }
      h.race = rid;
      const R = RACES[rid] || RACES[1];
      // 固有名は人種の語幹から（民族で名前の響きが分かれる）。
      h.name = personNameFor(rid, this.rand);
      // 血統・家系: 両親のIDと世代、父方から継ぐ家名を記録する（血縁・家族の追跡）。
      h.momId = pa ? (pa.pid || 0) : 0;
      h.dadId = pb ? (pb.pid || 0) : 0;
      h.gen = pa ? (Math.max(pa.gen || 1, pb ? (pb.gen || 1) : (pa.gen || 1)) + 1) : 1;
      // 家名: 父方→母方の血統から継ぐ。創始者は自分の人種の語幹から作る。
      h.sur = (pb && pb.sur) ? pb.sur : (pa && pa.sur) ? pa.sur : surnameFor(rid, this.rand);
      // 名声: 名門の子は幾分かの威信を生まれながらに継ぐ（貴種の血筋）。創始者は0から。
      h.prestige = pa ? Math.min(4, ((pa.prestige || 0) + (pb ? (pb.prestige || 0) : 0)) * 0.12) : 0;
      h.partner = null;     // 伴侶（繁殖で結ばれ、死別で深く悲しむ）
      h.bonds = null;       // 親友（会話を重ねて結ばれる。最大 MAX_BONDS）
      // 文化的気質（会話で伝播し、地域・国ごとの文化を創発させる）。
      h.culture = pa
        ? clamp01(((pa.culture == null ? 0.5 : pa.culture) + (pb ? (pb.culture == null ? 0.5 : pb.culture) : (pa.culture == null ? 0.5 : pa.culture))) / 2 + (this.rand() - 0.5) * 0.08)
        : this.rand();
      // 見た目（人種の色域から個体差つきで）。renderer がそのまま使う。
      h.skinCol = R.skins[(this.rand() * R.skins.length) | 0];
      h.hairCol = R.hairs[(this.rand() * R.hairs.length) | 0];
      // 体格（人種の build を個体差つきで。renderer の描画サイズに反映）。
      h.build = (R.build || 1) * (0.96 + this.rand() * 0.08);
      // 環境適応: 創始者にのみ人種の得意形質をごく僅かに付与する。子孫は遺伝で受け継ぎ、
      //   混血で薄まる（世代ごとの再加算による暴走を避ける）。
      if (!pa && R.bias && h[R.bias] != null) h[R.bias] = clampTrait(h[R.bias] + R.amt);
      // 言語: 子は両親の言葉を受け継ぎ僅かに変異する（世代で方言が分岐）。建国者は
      //   この後 _spawnHuman が国の言語から定める（lx===undefined を目印にする）。
      if (pa) {
        const ax = pa.lx == null ? 0.5 : pa.lx, ay = pa.ly == null ? 0.5 : pa.ly;
        const bx = pb && pb.lx != null ? pb.lx : ax, by = pb && pb.ly != null ? pb.ly : ay;
        const m = CP.langMut;
        h.lx = clamp01((ax + bx) * 0.5 + (this.rand() - 0.5) * m);
        h.ly = clamp01((ay + by) * 0.5 + (this.rand() - 0.5) * m);
      }
    }
    return h;
  };

  CivSystem.prototype._spawnHuman = function (k, x, y, clan, role, food, pa, pb) {
    if (this.people.length + this._births.length >= Game.config.sim.maxPeople) return null;
    if (k.humanCount >= CP.perKingdomCap) return null;
    const home = this._nearestCity(k, x, y);
    const h = {
      x: x, y: y, hx: 0, hy: 0,
      kid: k.id, clan: clan,
      age: 0, food: food,
      role: role, state: 0,
      gx: x, gy: y,        // 現在の目標タイル
      home: home,          // 所属する町（定住の拠点）
      farm: null,          // 農民の耕作地
      work: null,          // 専門職の職場（施設座標）
      gear: 0,             // 装備・道具の段階（0=素手）
      repro: CP.reproCooldown,
      social: 0,
      alive: true,
    };
    this._endow(h, pa, pb); // 個性・固有名・名声・人間関係・文化（親があれば遺伝）
    // 言語: 親が無い建国者・新住民は国の言葉を（個体差つきで）話す。
    if (h.lx == null) {
      const j = CP.langJitter;
      h.lx = clamp01((k.langX == null ? 0.5 : k.langX) + (this.rand() - 0.5) * j);
      h.ly = clamp01((k.langY == null ? 0.5 : k.langY) + (this.rand() - 0.5) * j);
    }
    k.humanCount++;
    k.roleCount[role]++;
    return h;
  };

  // 国の人口容量（確保した土地に比例。建国直後でも成長できる下限つき）。
  CivSystem.prototype._capacity = function (k) {
    // 漁場と農耕は食料を増やし、扶養できる人口を押し上げる。
    const fishBonus = k.res ? k.res.fish * 4 : 0;
    const agriBonus = hasTech(k, "agri") ? 8 : 0;
    return Math.min(CP.perKingdomCap, Math.max(CP.baseCap, ((k.tileCount / CP.tilesPerHuman) | 0) + fishBonus + agriBonus));
  };

  // 国の農地の平均的な肥沃度（0..1）。各都市の周辺を数点サンプリングして平均する。
  // 干ばつ・火災・噴火で植生(fertility)が落ちると、この値を介して食料生産が減る。
  CivSystem.prototype._landFertility = function (k) {
    const world = this.world;
    if (!world.fertility || !k.cities || !k.cities.length) return 0.6;
    const W = world.width, H = world.height, f = world.fertility;
    const off = [0, 0, -2, 0, 2, 0, 0, -2, 0, 2]; // 中心＋上下左右
    let sum = 0, n = 0;
    for (let c = 0; c < k.cities.length; c++) {
      const cx = k.cities[c].x, cy = k.cities[c].y;
      for (let o = 0; o < off.length; o += 2) {
        const x = cx + off[o], y = cy + off[o + 1];
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        sum += f[y * W + x]; n++;
      }
    }
    return n ? sum / n : 0.6;
  };

  // 領有する資源タイルを集計し各国の res（鉱石/漁場/宝石）に反映する。
  // 資源は少数なので resourceList を一巡するだけで全国まとめて数えられる。
  // 製錬の燃料（炭）を集計する: 各国の領内の森林・密林タイル数を数える（評価ごと）。
  // 森は炭の供給源であり、鉄・鋼の製錬を支える。製鉄が盛んだと森は炭に費やされ後退する。
  CivSystem.prototype._tallyFuel = function () {
    const ks = this.kingdoms, world = this.world, terr = world.terrain, owner = world.owner;
    const T = Game.TERRAIN, n = world.width * world.height;
    for (let id = 1; id < ks.length; id++) { const k = ks[id]; if (k && k.alive) { k._fuelN = 0; k._fuelTile = -1; } }
    for (let i = 0; i < n; i++) {
      const o = owner[i]; if (o === 0) continue;
      const t = terr[i];
      if (t === T.FOREST || t === T.JUNGLE) { const k = ks[o]; if (k && k.alive) { k._fuelN++; k._fuelTile = i; } }
    }
    for (let id = 1; id < ks.length; id++) { const k = ks[id]; if (k && k.alive) k.fuel = k._fuelN; }
  };

  CivSystem.prototype._tallyResources = function () {
    const ks = this.kingdoms, world = this.world;
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id];
      if (!k || !k.alive) continue;
      if (!k.res) k.res = { ore: 0, fish: 0, gems: 0, gold: 0, horses: 0, spice: 0, salt: 0, timber: 0 };
      else { k.res.ore = 0; k.res.fish = 0; k.res.gems = 0; k.res.gold = 0; k.res.horses = 0; k.res.spice = 0; k.res.salt = 0; k.res.timber = 0; }
    }
    const list = world.resourceList;
    if (!list || !list.length) return;
    const W = world.width, H = world.height, owner = world.owner;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const x = r.x, y = r.y;
      let o = owner[y * W + x];
      // 漁場は水上にあり領有されない → 隣接する自国の陸タイルの所有者に帰属させる。
      if (r.t === 2 && o === 0) {
        if (x > 0 && owner[y * W + x - 1]) o = owner[y * W + x - 1];
        else if (x < W - 1 && owner[y * W + x + 1]) o = owner[y * W + x + 1];
        else if (y > 0 && owner[(y - 1) * W + x]) o = owner[(y - 1) * W + x];
        else if (y < H - 1 && owner[(y + 1) * W + x]) o = owner[(y + 1) * W + x];
      }
      if (o === 0) continue;
      const k = ks[o];
      if (!k || !k.alive || !k.res) continue;
      if (r.t === 1) k.res.ore++;
      else if (r.t === 2) k.res.fish++;
      else if (r.t === 4) k.res.gold++;
      else if (r.t === 5) k.res.horses++;
      else if (r.t === 6) k.res.spice++;
      else if (r.t === 7) k.res.salt++;
      else if (r.t === 8) k.res.timber++;
      else k.res.gems++;
    }
  };

  // (x,y) に最も近い k の都市座標 {x,y} を返す。
  CivSystem.prototype._nearestCity = function (k, x, y) {
    let bx = k.cities[0].x, by = k.cities[0].y, bd = 1e9;
    for (let c = 0; c < k.cities.length; c++) {
      const dx = k.cities[c].x - x, dy = k.cities[c].y - y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bx = k.cities[c].x; by = k.cities[c].y; }
    }
    return { x: bx, y: by };
  };

  CivSystem.prototype.stats = function () {
    let kingdoms = 0, population = 0, cities = 0;
    for (let id = 1; id < this.kingdoms.length; id++) {
      const k = this.kingdoms[id];
      if (!k || !k.alive) continue;
      kingdoms++;
      population += k.humanCount;
      cities += k.cities.length;
    }
    // 放浪者（無所属）の数。
    let nomads = 0;
    const people = this.people;
    for (let p = 0; p < people.length; p++) {
      if (people[p].alive && people[p].kid === 0) nomads++;
    }
    return {
      kingdoms: kingdoms, population: population, cities: cities,
      nomads: nomads, total: population + nomads,
    };
  };

  // ===== 近傍グリッド =====
  CivSystem.prototype._buildGrid = function () {
    const W = this.world.width, H = this.world.height;
    const cs = CP.cellSize;
    const gw = Math.ceil(W / cs), gh = Math.ceil(H / cs);
    if (!this._head || this._gw !== gw || this._gh !== gh) {
      this._head = new Int32Array(gw * gh);
      this._gw = gw; this._gh = gh;
    }
    this._head.fill(-1);
    const people = this.people;
    const next = this._next;
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      const cx = (p.x / cs) | 0, cy = (p.y / cs) | 0;
      const c = cy * gw + cx;
      next[i] = this._head[c];
      this._head[c] = i;
    }
  };

  // 半径内で predicate(other) を満たす同胞/敵を数える / 最寄りを返す。
  CivSystem.prototype._scan = function (px, py, radius, want) {
    const cs = CP.cellSize, gw = this._gw, gh = this._gh;
    const r = Math.ceil(radius / cs);
    const cx = (px / cs) | 0, cy = (py / cs) | 0;
    const r2 = radius * radius;
    const people = this.people, next = this._next, head = this._head;
    let count = 0, count2 = 0, best = null, bestD = r2;
    for (let gy = cy - r; gy <= cy + r; gy++) {
      if (gy < 0 || gy >= gh) continue;
      for (let gx = cx - r; gx <= cx + r; gx++) {
        if (gx < 0 || gx >= gw) continue;
        let i = head[gy * gw + gx];
        while (i !== -1) {
          const o = people[i];
          if (o && o.alive) {
            const dx = o.x - px, dy = o.y - py;
            const d = dx * dx + dy * dy;
            if (d <= r2) {
              const m = want(o, d);
              if (m === 1) count++;
              else if (m === 2) { count2++; if (d < bestD) { bestD = d; best = o; } }
            }
          }
          i = next[i];
        }
      }
    }
    return { count: count, count2: count2, best: best };
  };

  CivSystem.prototype.tick = function (world) {
    this._tickN++;
    const tN = this._tickN;
    const people = this.people;
    const kingdoms = this.kingdoms;
    const rand = this.rand;
    // 昼夜の判定（夜は人々が帰宅して休む）。描画の昼夜と同じ周期を tick 数から算出し、
    // 気候時計が進まないヘッドレス環境でも正しく循環する。
    const tpd = (Game.config.sim && Game.config.sim.ticksPerDay) || 0;
    const dnOn = !Game.config.settings || Game.config.settings.dayNight !== false;
    if (tpd > 0 && dnOn) {
      const tod = (tN % tpd) / tpd;
      this._night = Math.sin((tod - 0.25) * Math.PI * 2) < -0.12;
    } else {
      this._night = false;
    }
    // 火災が世界に存在するか（人々の火災回避を発動させるかの判定）。
    this._fireNear = !!(Game.state.fire && Game.state.fire.active && Game.state.fire.active.length > 0);

    this._buildGrid();

    for (let i = 0; i < people.length; i++) {
      const h = people[i];
      if (!h.alive) continue;
      if (h.pid === undefined) this._endow(h); // 旧セーブ等の互換: 内面・素性を補う

      // 放浪者（無所属）: 集まり、やがて国を興す。
      if (h.kid === 0) { this._tickNomad(h, world, tN, i); continue; }

      // 航海中の入植者: 海を渡って新天地を目指す（専用の更新）。
      if (h.sailing) { this._tickSail(h, world); continue; }

      const k = kingdoms[h.kid];
      if (!k || !k.alive) {
        // 国が滅んだ → 難民（流民）として生き延び、別の国へ加入/再建を目指す。
        h.kid = 0; h.role = ROLE.EXPLORER;
        h.home = null; h.farm = null; h.clan = 0;
        continue;
      }

      // ---- 軽量・毎ティック ----
      h.age++;
      h.food -= CP.metab;
      h.social += CP.socialRise;
      if (h.repro > 0) h.repro--;
      // 民心・文化・民族の集計（社会→国家の因果＋地図の文化/人種ビュー用）。
      k._moodS = (k._moodS || 0) + h.mood; k._moodN = (k._moodN || 0) + 1;
      k._cultS = (k._cultS || 0) + (h.culture == null ? 0.5 : h.culture);
      k._lxS = (k._lxS || 0) + (h.lx == null ? 0.5 : h.lx); k._lyS = (k._lyS || 0) + (h.ly == null ? 0.5 : h.ly);
      if (h.race != null) (k._raceCnt || (k._raceCnt = [0, 0, 0, 0, 0]))[h.race]++;
      // 最も名高い人物を追う（国を代表する英傑・賢人）。
      if ((h.prestige || 0) > (k._topP || 0)) { k._topP = h.prestige; k._topRef = h; }

      const tx = h.x | 0, ty = h.y | 0;
      const ti = ty * world.width + tx;
      const terr = world.terrain[ti];
      // 採食。
      if (tile.isEdible(terr)) {
        let gain = CP.eatGain;
        if (world.fertility) {
          const f = world.fertility[ti];
          gain *= 0.5 + 0.5 * (f > 1 ? 1 : f);
          world.fertility[ti] = f > CP.harvest ? f - CP.harvest : 0;
        }
        h.food += gain;
        if (h.food > 1) h.food = 1;
      }
      // 火災に巻かれる: 燃えるタイルにいる者は焼かれ、体力(食料)を失い恐慌する。
      const onFire = this._fireNear && this._onFire(world, ti);
      if (onFire) {
        h.food -= CP.fireHarm;
        h.fear = h.fear != null ? Math.min(1, h.fear + 0.5) : 0.5;
        k._fireLoss = (k._fireLoss || 0) + 1;
      }
      // 足下タイルを確保（自国領に地続きの未開地のみ＝領土を連続させる）。
      const o0 = world.owner[ti];
      if (o0 === 0) {
        if (tile.isLand(terr) && this._adjacentOwner(world, tx, ty, h.kid)) {
          world.owner[ti] = h.kid; k.tileCount++;
          if (this.renderer) this.renderer.markTerritoryDirty(tx, ty);
        }
      } else if (o0 !== h.kid) {
        this._contact(h.kid, o0);
      }

      // ---- 重い意思決定は thinkInterval ごと（位相分散）----
      if (((tN + i) % CP.thinkInterval) === 0) {
        this._think(h, k, world);
      }

      // 移動 + 軽量な役割効果。
      this._move(h, null, world);
      this._roleTick(h, k, world, ti);

      // 死亡（餓死・老衰・疫病）。生命力(vigor)が高いほど長寿で病に強い（遺伝）。
      const vg = h.vigor || 1;
      if (h.food <= 0 || h.age > CP.maxAge * vg) {
        h.alive = false;
      } else if (onFire && this.rand() < CP.fireDeath) {
        h.alive = false; // 焼死
      } else if (k.plague > 0 && this.rand() < CP.plagueMortality / vg) {
        h.alive = false; // 疫病で病没（生命力で抵抗）
      }
    }

    // 死者を除去 + 役割カウント/人口を更新。
    let w = 0;
    for (let r = 0; r < people.length; r++) {
      const p = people[r];
      if (p.alive) { people[w++] = p; }
      else {
        const k = kingdoms[p.kid];
        if (k) { k.humanCount--; k.roleCount[p.role]--; }
        // 名のある人物の死は歴史に刻む。
        if (p._famed) this._logEvent("† " + p.name + (k ? "（" + k.name + "）" : "") + " が世を去った");
      }
    }
    people.length = w;

    // 民心 → 国家の不満（社会→国家の因果）。満ち足りた民は国を安んじ、
    // 不満を抱えた民は不穏を募らせる。基準=0.55（やや満ち足りた状態で中立）。
    for (let id = 1; id < kingdoms.length; id++) {
      const k = kingdoms[id];
      if (!k || !k.alive) continue;
      if (k._moodN) {
        const avg = k._moodS / k._moodN;
        k.moodAvg = avg;
        k.cultureAvg = k._cultS / k._moodN; // 国の平均的な文化（地図の文化ビュー用）
        k.langX = k._lxS / k._moodN; k.langY = k._lyS / k._moodN; // 国の言葉の重心（方言の収束を反映）
        k.unrest = (k.unrest || 0) + (0.55 - avg) * 0.05;
        if (k.unrest < 0) k.unrest = 0; else if (k.unrest > 100) k.unrest = 100;
      }
      // 火災の被害は都市を動揺させる（焼かれた住民に応じて不満が上がる）。
      if (k._fireLoss) k.unrest = Math.min(100, (k.unrest || 0) + k._fireLoss * CP.fireUnrest);
      // 民族構成: 最多の人種を国の代表民族とし、構成比を記録（人種ビュー・UI用）。
      //   多様性 diversity = 1 - 最多民族の比率（単一民族0 〜 多民族~0.8）。
      //   多文化国家は技術が加速する一方、わずかな軋轢（治安への摩擦）も生む。
      if (k._raceCnt) {
        let dom = 0, dn = -1, tot = 0;
        for (let r = 0; r < k._raceCnt.length; r++) { tot += k._raceCnt[r]; if (k._raceCnt[r] > dn) { dn = k._raceCnt[r]; dom = r; } }
        k.race = dom; k.raceMix = k._raceCnt.slice(); k.raceTot = tot;
        k.diversity = tot > 0 ? (1 - dn / tot) : 0;
        if (k.diversity > 0) {
          k.unrest = (k.unrest || 0) + k.diversity * CP.diversityFric;
          if (k.unrest > 100) k.unrest = 100;
        }
      }
      // 国を代表する英傑（名声が一定以上のときのみ掲げる）。
      if (k._topRef && k._topRef.alive && (k._topP || 0) >= FAME_THRESHOLD) {
        k.figure = { name: k._topRef.name, title: titleOf(k._topRef) };
      } else if (k.figure && (!k._topRef || !k._topRef.alive)) {
        k.figure = null;
      }
      k._moodS = 0; k._moodN = 0; k._cultS = 0; k._lxS = 0; k._lyS = 0; k._fireLoss = 0; k._raceCnt = null; k._topP = 0; k._topRef = null;
    }

    // 出生を追加。
    if (this._births.length) {
      for (let b = 0; b < this._births.length; b++) people.push(this._births[b]);
      this._births.length = 0;
    }

    // 領土メンテナンス（支配限界の収縮・亡霊領土の消去・飛び地の穴埋め）。
    this._maintainTerritory(world);

    // 街道網を集落から定期的に敷設し直す（移動を速める交通インフラ）。
    if ((tN % 150) === 0) this._rebuildRoads(world);

    // 世界統計の履歴をサンプリング（概観パネルの推移グラフ用）。
    if ((tN % 60) === 0) {
      const s = this.stats();
      this.statsHist.push({ pop: s.population, nomads: s.nomads, nations: s.kingdoms, year: Game.state.clock ? Game.state.clock.year : 0 });
      if (this.statsHist.length > 240) this.statsHist.shift();
    }

    // 戦場の痕跡を時間で薄れさせ、消えたものを除く。
    if (this.marks.length) {
      let w2 = 0;
      const marks = this.marks;
      for (let m = 0; m < marks.length; m++) {
        if (--marks[m].ttl > 0) marks[w2++] = marks[m];
      }
      marks.length = w2;
    }

    // 外交（間引いて評価）。
    if ((tN % CP.diploInterval) === 0) this._diplomacy();
  };

  // 都市 c 群のいずれかの支配圏内に (x,y) があるか。
  CivSystem.prototype._withinControl = function (k, x, y) {
    const cities = k.cities;
    for (let c = 0; c < cities.length; c++) {
      const r = CP.controlRadius + (cities[c].level || 1) * CP.controlPerLevel;
      const dx = cities[c].x - x, dy = cities[c].y - y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  };

  // 未開の陸地 (x,y) が単一国に囲まれていればその国IDを返す（飛び地の穴埋め用）。
  CivSystem.prototype._enclaveOwner = function (world, x, y) {
    const W = world.width, H = world.height, owner = world.owner, terr = world.terrain;
    let p = -1, landN = 0;
    const nb = [x - 1, y, x + 1, y, x, y - 1, x, y + 1];
    for (let n = 0; n < 8; n += 2) {
      const nx = nb[n], ny = nb[n + 1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return 0;
      const ni = ny * W + nx;
      if (!tile.isLand(terr[ni])) continue;
      landN++;
      const o = owner[ni];
      if (o === 0) return 0;
      if (p < 0) p = o; else if (o !== p) return 0;
    }
    return landN >= 3 && p > 0 ? p : 0;
  };

  // 領土メンテ: ローリング走査で支配圏外の辺境を手放し、亡霊領土を消し、飛び地を埋める。
  CivSystem.prototype._maintainTerritory = function (world) {
    const W = world.width, H = world.height, owner = world.owner;
    const ks = this.kingdoms;
    const rndr = this.renderer;
    const y0 = this._tcursor;
    const y1 = Math.min(H, y0 + CP.maintainBand);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const o = owner[i];
        if (o > 0) {
          const k = ks[o];
          if (!k || !k.alive) { // 滅亡国の亡霊領土を消す
            owner[i] = 0; if (rndr) rndr.markTerritoryDirty(x, y);
          } else if (!this._withinControl(k, x, y)) { // 支配限界を超えた辺境を手放す
            owner[i] = 0; k.tileCount--; if (rndr) rndr.markTerritoryDirty(x, y);
          }
        } else if (tile.isLand(world.terrain[i])) {
          const fill = this._enclaveOwner(world, x, y); // 単一国に囲まれた飛び地を吸収
          if (fill > 0) { owner[i] = fill; ks[fill].tileCount++; if (rndr) rndr.markTerritoryDirty(x, y); }
        }
      }
    }
    this._tcursor = y1 >= H ? 0 : y1;
  };

  // 集落網（首都⇄都市、同盟首都間）を直線でラスタライズして街道を敷く。
  // 街道タイルは移動を速めるインフラとして機能する。定期的に再構築する。
  CivSystem.prototype._rebuildRoads = function (world) {
    if (!world.road) return;
    const W = world.width, H = world.height, road = world.road;
    road.fill(0);
    const list = [];
    const ks = this.kingdoms;
    function line(x0, y0, x1, y1) {
      let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
      let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx - dy, x = x0, y = y0, guard = 0;
      const lim = W + H + 4;
      while (guard++ < lim) {
        if (x >= 0 && y >= 0 && x < W && y < H) {
          const i = y * W + x;
          if (tile.isLand(world.terrain[i]) && road[i] === 0 && list.length < 24000) { road[i] = 1; list.push(i); }
        }
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x += sx; }
        if (e2 < dx) { err += dx; y += sy; }
      }
    }
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id];
      if (!k || !k.alive || !k.cities || !k.cities.length) continue;
      const cap = k.cities[0];
      for (let c = 1; c < k.cities.length; c++) line(cap.x, cap.y, k.cities[c].x, k.cities[c].y);
      if (k.allies) {
        for (const b in k.allies) {
          const bi = +b; if (bi <= id) continue;
          const kb = ks[bi];
          if (kb && kb.alive && kb.cities && kb.cities.length) line(cap.x, cap.y, kb.cities[0].x, kb.cities[0].y);
        }
      }
    }
    world.roadList = list;
  };

  // ===== 外交（国システム）=====
  CivSystem.prototype._contact = function (a, b) {
    if (a === b || a === 0 || b === 0) return;
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    if (!ka || !kb || !ka.alive || !kb.alive) return;
    // 国境接触の鮮度を記録（隣国判定・領土紛争の根拠）。
    if (!ka.borders) ka.borders = {};
    if (!kb.borders) kb.borders = {};
    const t = this._tickN;
    ka.borders[b] = t; kb.borders[a] = t;
    if (ka.relations[b] === undefined) {
      // 初対面の印象（多少のばらつき）。
      const r = (this.rand() * 50 - 25) | 0;
      ka.relations[b] = r; kb.relations[a] = r;
    }
  };

  CivSystem.prototype._atWar = function (a, b) {
    const ka = this.kingdoms[a];
    return !!(ka && ka.wars[b]);
  };

  CivSystem.prototype._setRel = function (a, b, v) {
    v = v < -100 ? -100 : v > 100 ? 100 : v;
    this.kingdoms[a].relations[b] = v;
    this.kingdoms[b].relations[a] = v;
  };

  // 国の軍事力。兵士数を基礎に、技術・兵舎・武装度（道具/武具の備蓄）で底上げ。
  CivSystem.prototype._military = function (k) {
    const soldiers = k.roleCount[ROLE.SOLDIER] + 1;
    const barracks = k.facilities ? k.facilities.barracks : 0;
    const armed = 1 + Math.min(1, (k.tools || 0) / soldiers) * 0.6; // 武装した兵ほど強い
    // 軍事技術（青銅器→鉄器→火薬）で戦力が段階的に増す。
    const techMul = 1 + (hasTech(k, "bronze") ? 0.15 : 0) + (hasTech(k, "iron") ? 0.2 : 0) + (hasTech(k, "gunpowder") ? 0.5 : 0);
    // 騎兵: 馬を持つ国は機動力で軍事力が増す（上限つき）。
    const cav = 1 + Math.min(0.5, (k.res ? (k.res.horses || 0) : 0) * CP.horseMil);
    return soldiers * (1 + k.tech * 0.0025) * (1 + barracks * 0.18) * armed * techMul * cav;
  };

  // a と b を交戦状態にする（開戦時刻を記録、同盟は解消、関係悪化）。
  CivSystem.prototype._engage = function (a, b) {
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    if (!ka || !kb || !ka.alive || !kb.alive) return;
    if (ka.wars[b]) return;
    const t = this._tickN || 1;
    if (ka.relations[b] === undefined) { ka.relations[b] = 0; kb.relations[a] = 0; }
    ka.wars[b] = t; kb.wars[a] = t;
    delete ka.allies[b]; delete kb.allies[a];
    this._setRel(a, b, -80);
  };

  CivSystem.prototype._declareWar = function (a, b) {
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    if (ka && kb) this._logEvent("⚔ " + ka.name + " が " + kb.name + " に宣戦布告");
    this._engage(a, b);
    // 同盟への呼びかけ（ブロック戦争）: 双方の同盟国も参戦する。
    for (const c in ka.allies) { const ci = +c; if (ci !== b) this._engage(ci, b); }
    for (const c in kb.allies) { const ci = +c; if (ci !== a) this._engage(ci, a); }
    // 従属関係も参戦: 属国は宗主の戦に従い、宗主は属国を守る（属国どうしの同士討ちは避ける）。
    const self = this;
    function rally(side, foe, foeKing) {
      const sk = self.kingdoms[side]; if (!sk) return;
      if (sk.suzerain && sk.suzerain !== foe) self._engage(sk.suzerain, foe);
      for (const v in sk.vassals) { const vi = +v; if (vi !== foe && !(foeKing && foeKing.vassals && foeKing.vassals[vi])) self._engage(vi, foe); }
    }
    rally(a, b, kb); rally(b, a, ka);
  };

  CivSystem.prototype._makePeace = function (a, b) {
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    delete ka.wars[b]; delete kb.wars[a];
    // 休戦: しばらくは再戦しない（戦争の頻発を防ぎ、講和に意味を持たせる）。
    const until = (this._tickN || 0) + CP.truceTicks;
    if (ka.truce) ka.truce[b] = until; if (kb.truce) kb.truce[a] = until;
    this._setRel(a, b, -8);
  };

  // 決定的勝利の講和: 敗者は賠償金を払い、複数都市を持つなら係争都市を割譲する。
  CivSystem.prototype._imposePeace = function (s, w) {
    const ks = this.kingdoms[s], kw = this.kingdoms[w];
    if (!ks || !kw || !ks.alive || !kw.alive) return;
    // 賠償金（敗者の富の一部を勝者へ）。
    const trib = kw.wealth * CP.tributeFrac;
    if (trib > 0) { kw.wealth -= trib; ks.wealth += trib; }
    // 結末の選択: 独立した複数都市国家は、都市を奪う代わりに「属国(朝貢国)」にされることがある
    //   （ゆるやかな支配＝勝者は朝貢と従軍を得、敗者は存続する）。さもなくば係争都市を併合。
    let subjugated = false;
    if (kw.cities.length >= 2 && !kw.suzerain && this.rand() < CP.vassalChance) {
      this._subjugate(s, w); subjugated = true;
    } else if (kw.cities.length >= 2 && this._isNeighbor(ks, w)) {
      this._annexNearestCity(ks, kw);
    }
    if (!subjugated) {
      this._makePeace(s, w);
      this._setRel(s, w, -25); // 遺恨は残る
      kw.unrest = Math.min(100, kw.unrest + 20); // 敗戦で国内動揺
    }
    ks.unrest = Math.max(0, ks.unrest - 10);   // 戦勝で求心力
  };

  // 従属（属国化）: 敗者は存続しつつ宗主に従う。朝貢を納め、宗主の戦に従軍する。
  CivSystem.prototype._subjugate = function (sId, lId) {
    const ks = this.kingdoms[sId], kl = this.kingdoms[lId];
    if (!ks || !kl || !ks.alive || !kl.alive) return;
    if (kl.suzerain && this.kingdoms[kl.suzerain]) delete this.kingdoms[kl.suzerain].vassals[lId];
    kl.suzerain = sId; ks.vassals[lId] = true;
    delete ks.wars[lId]; delete kl.wars[sId];
    if (ks.truce) delete ks.truce[lId]; if (kl.truce) delete kl.truce[sId];
    this._setRel(sId, lId, 45);
    this._logEvent("⚑ " + kl.name + " が " + ks.name + " の属国となった");
  };

  // 勝者の首都に最も近い敗者都市を、その周辺領土・住民ごと併合する。
  CivSystem.prototype._annexNearestCity = function (winner, loser) {
    if (loser.cities.length <= 1) return; // 最後の都市は戦場でしか落ちない
    const wc = winner.cities[0];
    let idx = -1, bd = 1e18;
    for (let c = 0; c < loser.cities.length; c++) {
      const dx = loser.cities[c].x - wc.x, dy = loser.cities[c].y - wc.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; idx = c; }
    }
    if (idx < 0) return;
    const city = loser.cities[idx];
    const wasCapital = idx === 0;
    loser.cities.splice(idx, 1);
    city.capital = false;
    winner.cities.push(city);
    if (wasCapital && loser.cities.length) loser.cities[0].capital = true;

    // 周辺領土の割譲。
    const world = this.world, W = world.width, H = world.height, owner = world.owner;
    const R = CP.annexRadius, R2 = R * R;
    for (let y = Math.max(0, city.y - R); y <= Math.min(H - 1, city.y + R); y++) {
      for (let x = Math.max(0, city.x - R); x <= Math.min(W - 1, city.x + R); x++) {
        const i = y * W + x;
        if (owner[i] !== loser.id) continue;
        const dx = x - city.x, dy = y - city.y;
        if (dx * dx + dy * dy > R2) continue;
        owner[i] = winner.id; loser.tileCount--; winner.tileCount++;
        if (this.renderer) this.renderer.markTerritoryDirty(x, y);
      }
    }
    // 住民の移管（その都市を本拠とする者）。
    const people = this.people, clan = ++winner.clanSeq;
    for (let p = 0; p < people.length; p++) {
      const o = people[p];
      if (!o.alive || o.kid !== loser.id) continue;
      const hx = o.home ? o.home.x : o.x, hy = o.home ? o.home.y : o.y;
      const dx = hx - city.x, dy = hy - city.y;
      if (dx * dx + dy * dy > R2) continue;
      loser.humanCount--; loser.roleCount[o.role]--;
      o.kid = winner.id; o.clan = clan; o.home = { x: city.x, y: city.y }; o.farm = null;
      winner.humanCount++; winner.roleCount[o.role]++;
    }
    this._logEvent("🏰 " + winner.name + " が " + loser.name + " の都市を併合した");
    this._fuse(winner, loser); // 被征服文明の技術・信仰を取り込む（融合）
    if (loser.cities.length === 0 || loser.tileCount <= 0) {
      loser.alive = false;
      this._logEvent("☠ " + loser.name + " が滅亡した");
    }
  };

  CivSystem.prototype._formAlliance = function (a, b) {
    const ka = this.kingdoms[a], kb = this.kingdoms[b];
    ka.allies[b] = true; kb.allies[a] = true;
    delete ka.wars[b]; delete kb.wars[a];
    this._setRel(a, b, 70);
  };

  // ===== 文明の文化交流・同化・融合 =====
  // 文明どうしは接触（隣国・交易・同盟・征服）を通じて影響し合い、自国の時代や流儀に
  // 合わない技術・宗教・政体さえ「何らかの理由で」取り込む。
  //  - 受容度(openness): 商業的・同盟・相手が強大で成功しているほど外来を受け入れる。
  //  - 技術伝播: 後進国は接触する先進国の技を模倣し、時代に先んじても直接借用する。
  //  - 宗教/政体の迎合: 栄える隣国・盟主に倣い、合わなくても改宗・政体移行が起きる。
  //  - 征服の融合: 併合・征服した相手の技術や信仰を逆に取り込む（被征服文化の浸透）。

  // 相手(other)の文化をどれだけ受け入れるか。商業的・同盟・相手の繁栄で高まる。
  CivSystem.prototype._openness = function (k, other, allied) {
    let o = 0.5 * this._eff(k, "trade");           // 商業的な文明ほど開放的
    if (allied) o *= 1.6;                           // 同盟は交流が密
    // 相手が大きく富み進んでいる＝文化的な引力（憧れ・権威への迎合）。
    const mine = k.humanCount + k.wealth * 0.04 + k.tech + 1;
    const theirs = other.humanCount + other.wealth * 0.04 + other.tech;
    o *= Math.min(2.4, 0.5 + theirs / mine * 0.7);
    return o;
  };

  // recv が donor の持つ未獲得技術を、接触ゆえに直接取り込む（時代に先んじても）。
  // 「時代的に合わなくても」借用できるのが要点（模倣・亡命者・交易による伝播）。
  CivSystem.prototype._adoptTech = function (recv, donor, openness) {
    if (!donor.techBits) return;
    for (let ti = 0; ti < TECHS.length; ti++) {
      const T = TECHS[ti];
      if (T.id === "coin") continue;                 // 貨幣は商業を通じて別途伝播する（_culturalExchange）
      if (!donor.techBits[T.id] || recv.techBits[T.id]) continue;
      const ahead = recv.tech < T.at;                // 自国の時代より早い借用か
      const chance = (ahead ? 0.05 : 0.13) * Math.min(2.5, openness);
      if (this.rand() < chance) {
        recv.techBits[T.id] = true;
        recv.discovered.push(T.name);
        if (recv.tech < T.at) recv.tech = T.at * 0.85; // 借用で底上げ（完全な自力到達ではない）
        this._logEvent("📜 " + recv.name + " が " + donor.name + " から「" + T.name + "」を" +
          (ahead ? "時代に先んじて" : "") + "取り入れた");
        return; // 1評価につき1件まで
      }
    }
  };

  // 接触する2文明の文化交流（技術・宗教・政体の伝播と迎合）。
  CivSystem.prototype._culturalExchange = function (a, b, ka, kb) {
    const allied = !!ka.allies[b];
    const trading = !!(ka.partners && ka.partners[b]);
    if (!this._isNeighbor(ka, b) && !allied && !trading) return; // 接触が無ければ交流しない
    const oab = this._openness(ka, kb, allied); // ka が kb を受け入れる度合い
    const oba = this._openness(kb, ka, allied);

    // 技術伝播: 後進国は先進国へ緩やかに追いつき、時に時代を超えて技を借用する。
    const adv = ka.tech >= kb.tech ? ka : kb;
    const bwd = ka.tech >= kb.tech ? kb : ka;
    if (adv.tech > bwd.tech + 4) {
      const oBwd = bwd === ka ? oab : oba;
      bwd.tech += (adv.tech - bwd.tech) * 0.03 * Math.min(2, oBwd); // 模倣による追い上げ
      this._adoptTech(bwd, adv, oBwd);
    }

    // 宗教の迎合・伝播: 権威ある／栄える相手の信仰へ、合わなくても改宗しうる。
    if (ka.religion !== kb.religion) {
      if (this.rand() < 0.035 * oab * this._eff(kb, "faith") * (0.4 + (kb.faith||0))) {
        ka.religion = kb.religion;
        this._logEvent("☽ " + ka.name + " が " + kb.name + " に倣い " + kb.religion + " に改宗した");
      } else if (this.rand() < 0.035 * oba * this._eff(ka, "faith") * (0.4 + (ka.faith||0))) {
        kb.religion = ka.religion;
        this._logEvent("☽ " + kb.name + " が " + ka.name + " に倣い " + ka.religion + " に改宗した");
      }
    }

    // 貨幣の伝播（迎合）: 貨幣を使う相手に接した国は、自国の文明・時代がまだ伴わなくても、
    //   交易の便から貨幣（鋳貨）を取り入れることがある。貨幣は商業を通じて時代を超えて広まる
    //   ――抽象的な技術より伝わりやすい。交易関係にあるほど採り入れやすい。
    const coinKa = hasTech(ka, "coin"), coinKb = hasTech(kb, "coin");
    if (coinKa !== coinKb) {
      const recv = coinKa ? kb : ka;
      const donor = coinKa ? ka : kb;
      const o = recv === ka ? oab : oba;
      const bond = (recv.partners && recv.partners[donor.id]) ? 1.8 : 1; // 交易相手からはより伝わる
      if (this.rand() < CP.coinAdoptChance * Math.min(2.5, o) * bond) {
        recv.techBits.coin = true;
        if (recv.discovered && recv.discovered.indexOf("鋳貨") < 0) recv.discovered.push("鋳貨");
        this._logEvent("🪙 " + recv.name + " が " + donor.name + " に倣い貨幣（鋳貨）を使い始めた");
      }
    }

    // 政体の迎合: 不振の国が、際立って栄える別政体の相手に倣って政体を変える（合わずとも）。
    this._emulateGov(ka, kb, oab);
    this._emulateGov(kb, ka, oba);
  };

  // 不振の国 k が、明らかに繁栄する別政体の相手 other に倣って政体を移行する。
  CivSystem.prototype._emulateGov = function (k, other, openness) {
    if (k.gov === other.gov) return;
    const better = (other.wealth + other.tech * 4) > (k.wealth + k.tech * 4) * 1.6;
    if (!better) return;
    if (k.unrest < 45 && k.humanCount >= other.humanCount * 0.8) return; // 安定・互角なら現状維持
    if (this.rand() < 0.04 * Math.min(2, openness)) {
      const gi = GOV_TYPES.indexOf(other.gov);
      if (gi >= 0) {
        k.gov = other.gov; k.govMod = GOV_MODS[gi];
        k.unrest = Math.min(100, k.unrest + 6); // 改革の動揺
        this._logEvent("⚖ " + k.name + " が " + other.name + " に倣い " + other.gov + " へ移行した");
      }
    }
  };

  // 征服・併合での融合: 勝者が被征服文明の技術・信仰を取り込む（被征服文化の浸透）。
  CivSystem.prototype._fuse = function (winner, loser) {
    // 技術の捕獲: 敗者が持ち勝者に無い技を、亡命する学者・職人がもたらす。
    if (loser.techBits) {
      for (let ti = 0; ti < TECHS.length; ti++) {
        const T = TECHS[ti];
        if (loser.techBits[T.id] && !winner.techBits[T.id] && this.rand() < 0.5) {
          winner.techBits[T.id] = true;
          winner.discovered.push(T.name);
          if (winner.tech < T.at) winner.tech = T.at * 0.9;
          this._logEvent("📜 " + winner.name + " が " + loser.name + " の「" + T.name + "」を受け継いだ");
        }
      }
    }
    // 信仰の浸透: 大きな被征服民は、むしろ征服者の信仰を塗り替えることがある（取り込まれる）。
    if (winner.religion !== loser.religion &&
        loser.humanCount > winner.humanCount * 0.6 && this.rand() < 0.3) {
      winner.religion = loser.religion;
      this._logEvent("☽ " + winner.name + " は征服した " + loser.name + " の " + loser.religion + " に染まった");
    }
  };

  // ===== 交易（取引）と市場 =====
  // 文明どうしが余剰と不足を交換し、双方が富む経済の根幹。交易の力は文明により異なる:
  //   政体（共和制は商業的）・気質（商才）・市場・商人・技術（車輪=陸路 / 航海術=海路）・治安。
  // 市場の理: 各文明では財の供給と需要から「市場価格」が決まる（希少なら高く、
  //   豊富なら安い）。価格の高い国（希少）へ、安い国（豊富）から財が流れ、その
  //   価格差が交易の利益を生む（裁定＝comparative advantage の経済的な実体）。
  // 実物の移動: 穀物は飢えた国へ、武具は手薄な国へ流れ、奢侈品は富裕層を潤して
  //   人心を和らげる。交易は飢饉・軍備・治安に波及する（経済→人口・軍事・社会）。

  // 交易財。各文明の供給/需要から市場価格が定まり、価格差が交易を駆動する。
  const GOODS = [
    { id: "grain", name: "穀物", base: 1.0, w: 1.2 },   // 食料。需要=人口
    { id: "metal", name: "金属", base: 1.4, w: 1.0 },   // 鉱石。需要=鍛冶・人口
    { id: "sea", name: "海産", base: 0.9, w: 0.9 },     // 漁獲。需要=人口
    { id: "luxury", name: "奢侈品", base: 2.2, w: 0.9 }, // 宝石。需要=富・人口
    { id: "tools", name: "道具", base: 1.6, w: 1.1 },   // 道具・武具。需要=人口・鍛冶
    { id: "horse", name: "軍馬", base: 1.8, w: 1.0 }, // 馬。需要=軍備・人口（騎兵）
    { id: "spice", name: "香辛料", base: 2.6, w: 0.95 }, // 香辛料。需要=富・人口（高値の奢侈）
  ];

  // 文明の市場価格を求める（財ごとの供給と需要の比＝希少度。0.1〜8 にクランプ）。
  // 供給が少なく需要が多い財ほど高価になり、交易で輸入されやすくなる。
  CivSystem.prototype._marketPrices = function (k) {
    const res = k.res || { ore: 0, fish: 0, gems: 0, gold: 0, horses: 0, spice: 0, salt: 0, timber: 0 };
    const fac = k.facilities || {};
    const pop = Math.max(1, k.humanCount);
    const supply = {
      grain: 0.2 + (k.food || 0) * 0.15 + (k.roleCount[ROLE.FARMER] || 0) * 0.5 + (fac.farm || 0) * 1.2 + (res.salt || 0) * 0.6, // 塩は食料の保存＝供給を底上げ
      metal: 0.3 + res.ore,
      sea: 0.3 + res.fish,
      luxury: 0.2 + res.gems + (res.gold || 0) * 0.7, // 宝石・金（奢侈品）
      tools: 0.3 + (k.tools || 0) + (res.timber || 0) * 0.4, // 良材は道具・建材の供給
      horse: 0.2 + (res.horses || 0),
      spice: 0.15 + (res.spice || 0),
    };
    const demand = {
      grain: pop * 0.5,
      metal: pop * 0.12 + (fac.smithy || 0) * 1.5,
      sea: pop * 0.18,
      luxury: pop * 0.08 + (k.wealth || 0) * 0.002,
      tools: pop * 0.2 + (fac.barracks || 0),
      horse: pop * 0.06 + (fac.barracks || 0) * 1.5 + this._count(k.wars) * 2, // 軍備・戦時に騎兵需要
      spice: pop * 0.05 + (k.wealth || 0) * 0.0015, // 富裕層の奢侈需要
    };
    const p = {};
    for (let i = 0; i < GOODS.length; i++) {
      const g = GOODS[i].id;
      let v = GOODS[i].base * (demand[g] + 1) / (supply[g] + 1);
      if (v < 0.1) v = 0.1; else if (v > 8) v = 8;
      p[g] = v;
    }
    return p;
  };

  // 文明の交易力（市場・商人・車輪・政体・気質・治安で決まる）。
  CivSystem.prototype._tradeCapacity = function (k) {
    const fac = k.facilities || {};
    const order = 1 - (k.unrest || 0) / 200;
    let cap = (1 + (fac.market || 0) * CP.tradeMarketW + (fac.harbor || 0) * CP.harborTrade + (k.roleCount[ROLE.MERCHANT] || 0) * CP.tradeMerchantW) *
      this._eff(k, "trade") * order;
    if (hasTech(k, "wheel")) cap *= CP.tradeWheelBonus;
    return cap;
  };

  // 交易路の有無と通行のしやすさ。陸続きの隣国・同盟・（航海術があれば）海路で結ばれる。
  CivSystem.prototype._tradeRoute = function (a, b, ka, kb) {
    const ally = !!ka.allies[b];
    const neighbor = this._isNeighbor(ka, b);
    let f = 0, sea = false;
    if (neighbor) f = 1;                                  // 陸続きの隣国
    else if (ally) f = 0.85;                              // 同盟は遠国でも通商路を保つ
    else if (hasTech(ka, "sail") && hasTech(kb, "sail")) { f = CP.tradeSeaPenalty; sea = true; } // 海路交易
    if (f === 0) return null;
    if (ally) f *= CP.tradeAllyBonus;                     // 通商同盟は交易を太くする
    return { f: f, sea: sea, ally: ally };
  };

  function addPartner(k, id, vol) {
    if (!k.partners) k.partners = {};
    k.partners[id] = (k.partners[id] || 0) + vol;
  }

  // 2国間の交易を1回ぶん実行する。交易が成立すれば true。
  CivSystem.prototype._trade = function (a, b, ka, kb) {
    const route = this._tradeRoute(a, b, ka, kb);
    if (!route) return false;
    const capA = this._tradeCapacity(ka), capB = this._tradeCapacity(kb);
    const cap = Math.min(capA, capB) * route.f;
    const mass = Math.min(ka.humanCount, kb.humanCount); // 交易は小さい方の経済規模に律速
    const pa = ka.prices || (ka.prices = this._marketPrices(ka));
    const pb = kb.prices || (kb.prices = this._marketPrices(kb));

    // 裁定の利益: 財ごとの市場価格差を合算（価格が割れているほど交易の余地が大きい）。
    // 価格差は「片方に余り、片方に不足」がある状態＝比較優位の経済的な実体。
    let gapSum = 0;
    for (let i = 0; i < GOODS.length; i++) {
      const g = GOODS[i].id;
      const gap = Math.abs(pa[g] - pb[g]);
      if (gap > 0.15) gapSum += Math.min(2.2, gap) * GOODS[i].w;
    }
    // 貨幣経済: 双方（または片方）が貨幣を使うと、取引費用が下がり交易の利益が増す。
    const coinA = hasTech(ka, "coin"), coinB = hasTech(kb, "coin");
    const coinMul = (coinA && coinB) ? CP.coinTradeBonus : (coinA || coinB) ? CP.coinTradeHalf : 1;
    const gain = CP.tradeBase * cap * gapSum * (0.3 + mass * 0.02) * CP.tradeArbScale * coinMul;
    if (gain > 0) {
      ka.wealth += gain; kb.wealth += gain;       // 交易は双方を富ませる（gains from trade）
      ka.tradeIncome += gain; kb.tradeIncome += gain;
      ka.tradeVol += gain; kb.tradeVol += gain;
      addPartner(ka, b, gain); addPartner(kb, a, gain);
    }

    // 実物の交易（価格の安い＝豊富な国から、高い＝希少な国へ流れる）。
    // 穀物: 飢えた国へ。武具: 軍備の手薄な国へ。買い手は富で支払う。
    this._tradeFood(a, b, ka, kb, route);
    this._tradeFood(b, a, kb, ka, route);
    this._tradeTools(a, b, ka, kb, route);
    this._tradeTools(b, a, kb, ka, route);

    // 奢侈品: 宝石に富む国から乏しい（価格の高い）国へ。富裕層が潤い人心が和らぐ。
    const luxGap = Math.abs(pa.luxury - pb.luxury);
    if (luxGap > 0.3) {
      const imp = pa.luxury > pb.luxury ? ka : kb; // 価格の高い＝奢侈品が希少な側が輸入
      const exp = pa.luxury > pb.luxury ? kb : ka;
      if (exp.res && exp.res.gems > 0) {
        imp.unrest = Math.max(0, (imp.unrest || 0) - Math.min(1.5, luxGap * 0.3 * route.f));
      }
    }
    return true;
  };

  // seller→buyer の方向に武具を売る（買い手の軍備が手薄で、売り手に余裕があるとき）。
  // 軍需品の交易: 富める国が武器を輸入して軍を整える（経済→軍事の新たな経路）。
  CivSystem.prototype._tradeTools = function (sa, ba, seller, buyer, route) {
    const sPop = Math.max(1, seller.humanCount), bPop = Math.max(1, buyer.humanCount);
    const sRatio = (seller.tools || 0) / sPop, bRatio = (buyer.tools || 0) / bPop;
    if (sRatio - bRatio < 0.15) return;          // 売り手の方が十分に余裕があるときだけ
    let amount = Math.min(seller.tools - sPop * 0.4, (bPop - (buyer.tools || 0)) * 0.5, CP.tradeToolMax * route.f);
    if (amount <= 0.1) return;
    const price = CP.tradeToolPrice;
    let cost = amount * price;
    if (buyer.wealth < cost) { amount = buyer.wealth / price; cost = buyer.wealth; }
    if (amount <= 0.1) return;
    seller.tools -= amount; buyer.tools += amount;
    seller.wealth += cost; buyer.wealth -= cost;
    seller.tradeVol += cost; buyer.tradeVol += cost;
    addPartner(seller, ba, cost); addPartner(buyer, sa, cost);
  };

  // seller→buyer の方向に食料を売る（buyer が不足し seller に余剰があるときのみ）。
  CivSystem.prototype._tradeFood = function (sa, ba, seller, buyer, route) {
    const sFac = seller.facilities || {};
    const sMax = CP.foodStoreBase + (sFac.granary || 0) * CP.foodStoreGranary + ((seller.res && seller.res.salt) || 0) * CP.saltStore;
    const surplus = seller.food - sMax * 0.35;       // 備蓄に余裕がある分だけ売る
    if (surplus <= 1) return;
    // 買い手の不足度（飢饉なら最大、平時でも乏しければ少し買う）。
    const need = buyer.famine ? CP.tradeFoodMax : Math.max(0, CP.foodStoreBase * 0.4 - buyer.food);
    if (need <= 0.5) return;
    let amount = Math.min(surplus, need, CP.tradeFoodMax * route.f);
    if (amount <= 0.2) return;
    // 代金（富）。買い手の富で支払える範囲に抑える。
    const price = CP.tradeFoodPrice;
    let cost = amount * price;
    if (buyer.wealth < cost) { amount = buyer.wealth / price; cost = buyer.wealth; }
    if (amount <= 0.2) return;
    seller.food -= amount; buyer.food += amount;
    seller.wealth += cost; buyer.wealth -= cost;
    seller.foodTrade -= amount; buyer.foodTrade += amount;
    seller.tradeVol += cost; buyer.tradeVol += cost;
    addPartner(seller, ba, cost); addPartner(buyer, sa, cost);
    // 飢饉国が食料を輸入できれば飢えが和らぐ（飢饉フラグはこの後の評価で見直される）。
  };

  // ===== 政治: 統治者・王朝・継承 =====
  // 統治者は実在の人物。政体ごとに選ばれ方が異なる:
  //   君主制・氏族制・部族連合 … 世襲（故主の子→王家→断絶なら新王朝＝継承危機）
  //   共和制 … 選挙（最も威信ある市民。任期ごとに交代しうる＝王朝が定着しにくい）
  //   神権制 … 高位の聖職者（最も徳望ある神官）
  // 統治者の資質（威信＝正統性、知性、徳）が国の安定と発展に影響する。
  CivSystem.prototype._succeed = function (k, coup) {
    const late = k.rulerRef;
    const people = this.people;
    const hereditary = k.gov === "君主制" || k.gov === "氏族制" || k.gov === "部族連合";
    let heir = null, heirS = -1, house = null, houseS = -1, best = null, bestS = -1, priest = null, priestS = -1;
    for (let i = 0; i < people.length; i++) {
      const o = people[i];
      if (!o.alive || o.kid !== k.id || o.age < CP.adultAge) continue;
      // 統治者の器: 威信・知性・徳・齢・健康を総合。
      const s = (o.prestige || 0) * 1.5 + (o.wit || 1) + (o.dili || 1) + (o.age * 0.0004) + (o.food || 0);
      if (s > bestS) { bestS = s; best = o; }
      if (k.dynasty && o.sur === k.dynasty && s > houseS) { houseS = s; house = o; }
      if (late && late.pid && (o.momId === late.pid || o.dadId === late.pid) && s > heirS) { heirS = s; heir = o; }
      if (o.role === ROLE.PRIEST && s > priestS) { priestS = s; priest = o; }
    }
    let chosen, crisis = false;
    if (coup) chosen = best;                          // 簒奪: 最有力者が実力で奪う
    else if (k.gov === "共和制") chosen = best;        // 選挙
    else if (k.gov === "神権制") chosen = priest || best;
    else { chosen = heir || house || best; if (!heir && !house) crisis = true; } // 世襲（断絶=危機）
    if (!chosen) return false;

    const newHouse = chosen.sur || k.dynasty || "—";
    const houseChanged = k.dynasty && newHouse !== k.dynasty;
    const hadRuler = !!(late);
    k.rulerRef = chosen; k.rulerPid = chosen.pid;
    k.ruler = (chosen.name || "?") + (chosen.sur ? " " + chosen.sur : "");
    k.dynasty = newHouse;
    k.reign = 0;
    // 継承の動揺: 平穏な世襲は小、選挙はやや、王朝交代・断絶・簒奪は大。
    let shock = !hadRuler ? 0 : coup ? 16 : crisis ? 18 : houseChanged ? 11 : (k.gov === "共和制" ? 4 : 3);
    k.unrest = Math.min(100, (k.unrest || 0) + shock);
    if (hadRuler) {
      if (coup) this._logEvent("⚔ " + k.name + ": " + k.ruler + " が政権を簒奪した（" + newHouse + "家）");
      else if (crisis) this._logEvent("👑 " + k.name + ": 王統が断絶し " + k.ruler + " が新王朝（" + newHouse + "家）を開いた");
      else if (k.gov === "共和制") this._logEvent("🗳 " + k.name + ": " + k.ruler + " が指導者に選ばれた");
      else this._logEvent("👑 " + k.name + ": " + k.ruler + " が " + newHouse + "家を継いで即位した");
    }
    return true;
  };

  // イベント駆動の外交・経済・社会評価。
  // 属国関係の解消（宗主滅亡・独立運動）。revolt 時は独立戦争になる。
  CivSystem.prototype._breakVassalage = function (suzId, vasId, revolt) {
    const su = this.kingdoms[suzId], kv = this.kingdoms[vasId];
    if (!kv) return;
    if (su) delete su.vassals[vasId];
    kv.suzerain = 0;
    if (revolt && su && su.alive && kv.alive) {
      this._engage(suzId, vasId);
      this._setRel(suzId, vasId, -60);
      this._logEvent("✊ " + kv.name + " が宗主 " + su.name + " から独立を掲げて蜂起した");
    }
  };

  // 属国の維持: 朝貢を徴収し、宗主が衰えるか不満が高じれば独立を試みる。死んだ関係を掃除。
  CivSystem.prototype._maintainVassals = function () {
    const ks = this.kingdoms;
    for (let id = 1; id < ks.length; id++) {
      const k = ks[id];
      if (!k || !k.alive) continue;
      // 死んだ/離反した属国を宗主のリストから掃除。
      if (k.vassals) for (const v in k.vassals) { const kv = ks[+v]; if (!kv || !kv.alive || kv.suzerain !== id) delete k.vassals[v]; }
      // 属国側: 朝貢と独立判定。
      if (k.suzerain) {
        const su = ks[k.suzerain];
        if (!su || !su.alive) { k.suzerain = 0; continue; } // 宗主滅亡 → 独立
        const trib = k.wealth * CP.vassalTribute;
        if (trib > 0) { k.wealth -= trib; su.wealth += trib; }
        if (!k.wars[k.suzerain]) {
          const weak = this._military(su) < this._military(k) * CP.vassalRevoltMil;
          if ((weak || k.unrest > 80) && this.rand() < 0.08) this._breakVassalage(k.suzerain, id, true);
        }
      }
    }
  };

  CivSystem.prototype._diplomacy = function () {
    const ks = this.kingdoms;

    // 領有資源を集計（鉱石・漁場・宝石）。
    this._tallyResources();
    // 製錬の燃料（森林＝炭）は変化が緩やかなので、全マップ走査は数回に1回に間引く。
    this._fuelEval = (this._fuelEval || 0) + 1;
    if (this._fuelEval % 3 === 1) this._tallyFuel();

    // --- 国家ごと: 経済(富・技術) と 社会(不満) ---
    for (let a = 1; a < ks.length; a++) {
      const ka = ks[a];
      if (!ka || !ka.alive) continue;
      // 無人・無領土の国は消滅。
      if (ka.humanCount <= 0 || ka.tileCount <= 0) {
        ka.alive = false;
        this._logEvent("☠ " + ka.name + " が滅亡した");
        continue;
      }
      // 機能建築の数を集計（市場・鍛冶場・神殿などの効果に使う）。
      this._recountFacilities(ka);
      // 火災が領内に及んでいれば建物が焼失する（被害→施設減→不満）。集計の前後で
      //   整合するよう、被害適用後に施設数を取り直す。
      if (this._fireNear) { this._fireDamageBuildings(ka, this.world); this._recountFacilities(ka); }
      const fac = ka.facilities;
      const res = ka.res || { ore: 0, fish: 0, gems: 0, gold: 0, horses: 0, spice: 0, salt: 0, timber: 0 };
      // 交易の集計を新たな評価期間に向けて減衰・初期化（このあとペア処理で再集計）。
      ka.tradeVol *= 0.5; if (ka.tradeVol < 0.01) ka.tradeVol = 0;
      ka.tradeIncome = 0; ka.foodTrade = 0; ka.partners = null;
      ka.prices = this._marketPrices(ka); // 当評価期の市場価格（交易の駆動・UI表示）
      // 治安（不満）が生産を左右する: 高い不満は混乱を生み、富・技術・食料・武具の
      //   産出を落とす（=失政の国は衰える負の連鎖）。order: 0.5(不満100)〜1.0(不満0)。
      const order = 1 - ka.unrest / 200;
      // 統治者の資質: 勤勉な君主は富を、賢明な君主は技術を伸ばす（名君と暗君の差。
      //   平均的な統治者(資質~1.0)では中立）。
      const king = ka.rulerRef;
      const kingDili = king && king.alive ? (0.7 + 0.3 * (king.dili || 1)) : 1;
      const kingWit = king && king.alive ? (0.7 + 0.3 * (king.wit || 1)) : 1;
      // 黄金時代・暗黒時代は系が強制するものではなく、いくつもの因果（富・治安・人口・平和・
      //   統治者の資質）が重なって生じる「状態」である。ここではそれらの実測値から緩やかな
      //   活力(fortune)を導き、持続した高揚・沈滞をヒステリシス付きで「認識」して年代記に
      //   刻むのみ――産出には一切の人為補正をかけない。盛衰は既存の因果系がそのまま生み出す。
      const cap = this._capacity(ka);
      const able = king && king.alive ? ((king.wit || 1) + (king.dili || 1)) * 0.5 : 0.9;
      const fWar = this._count(ka.wars);
      const wealthN = clamp01(ka.wealth / Math.max(1, ka.tileCount) / 0.9);
      const orderN = clamp01((order - 0.5) * 2);
      const popN = clamp01(ka.humanCount / Math.max(1, cap));
      const peaceN = fWar === 0 ? 1 : clamp01(1 - fWar * 0.4);
      const leaderN = clamp01((able - 0.7) / 0.6);
      const crisisN = (ka.famine ? 0.22 : 0) + (ka.plague > 0 ? 0.18 : 0);
      const fRaw = clamp01(wealthN * 0.26 + orderN * 0.24 + popN * 0.16 + peaceN * 0.18 + leaderN * 0.16 - crisisN);
      // 緩やかな指数平滑（瞬間値ではなく持続した状態を映す＝自然なヒステリシス）。
      ka.fortune = ka.fortune === undefined ? fRaw : ka.fortune + (fRaw - ka.fortune) * 0.12;
      if (ka.fortune > 0.72) { if (!ka.goldenAge) this._logEvent("✨ " + ka.name + " が黄金時代を迎えた"); ka.goldenAge = 1; ka.darkAge = 0; }
      else if (ka.fortune < 0.6 && ka.goldenAge) { ka.goldenAge = 0; this._logEvent("　" + ka.name + " の黄金時代が過ぎ去った"); }
      if (ka.fortune < 0.28) { if (!ka.darkAge) this._logEvent("🌑 " + ka.name + " が暗黒時代に陥った"); ka.darkAge = 1; ka.goldenAge = 0; }
      else if (ka.fortune > 0.4 && ka.darkAge) { ka.darkAge = 0; this._logEvent("　" + ka.name + " が暗黒時代を脱した"); }
      // 工芸力: 鍛冶場・鍛冶職人・金属・進んだ冶金（青銅/鉄）で育つ「ものづくりの力」。
      const smiths = ka.roleCount[ROLE.SMITH] || 0;
      const metalAvail = (res.ore > 0) || (fac.mine > 0);
      const metalF = metalAvail ? 1 : 0.35;
      let craftTgt = clamp01((fac.smithy * 0.22 + smiths * 0.025) / Math.max(1, ka.cities.length) +
        (hasTech(ka, "bronze") ? 0.1 : 0) + (hasTech(ka, "iron") ? 0.12 : 0)) * metalF;
      ka.craft = (ka.craft || 0) + (craftTgt - (ka.craft || 0)) * 0.1; // ゆっくり推移
      // 富: 領土・都市・市場・宝石・金鉱石・記念碑（観光）・車輪（交易）・貨幣から収入
      //   （商才・政体・治安・名君で増減）。
      ka.wealth += (ka.tileCount * 0.02 + ka.cities.length * 0.6 + fac.market * 2.5 + (res.gems * 2.0 + res.gold * CP.goldWealth + (res.spice || 0) * CP.spiceWealth) * (1 + (ka.craft || 0) * CP.craftLuxW) + (res.timber || 0) * CP.timberWealth + fac.wonder * 3 + (hasTech(ka, "wheel") ? 3 : 0) + (ka.coin || 0) * CP.coinWealth) * this._eff(ka, "trade") * order * kingDili;
      if (ka.wealth < 0) ka.wealth = 0;
      // 貨幣経済: ある程度の文明（鋳貨技術）になり金鉱石を持つ国は、それを鋳造して
      //   貨幣を発行する。物々交換から貨幣経済へ移行し、交易と富の蓄積が潤滑になる。
      if (hasTech(ka, "coin")) {
        if (!ka._coined) { ka._coined = true; this._logEvent("💰 " + ka.name + " が貨幣（鋳貨）を導入した"); }
        // 自国の金鉱石から鋳造する分に加え、交易を通じて外国の貨幣・金が流入する。
        //   これにより金鉱を持たぬ国でも、商業が盛んなら貨幣を使える（文明・時代を問わず）。
        const tradeCap = Math.min(CP.coinTradeCap, (ka.tradeVol || 0) * CP.coinTradeCapW);
        const cap = (res.gold || 0) * CP.coinCap + tradeCap;
        const inflow = (res.gold || 0) * CP.mintRate + Math.min(tradeCap, (ka.tradeVol || 0) * CP.coinFromTrade);
        ka.coin = (ka.coin || 0) + inflow;
        if (ka.coin > cap) ka.coin = ka.coin * 0.9 + cap * 0.1; // 保有上限へ緩やかに収束
      } else if (ka.coin > 0) {
        ka.coin *= 0.98; if (ka.coin < 0.01) ka.coin = 0; // 貨幣を未だ持たぬ国（鋳造手段の喪失）
      }
      // 技術: 都市・人口・富・鍛冶場・学院・鉱石・記念碑で進歩（賢明・政体・文字・印刷・治安・名君で加速）。
      const techRate = 1 + (hasTech(ka, "writing") ? 0.15 : 0) + (hasTech(ka, "printing") ? 0.3 : 0) + (ka.diversity || 0) * CP.diversityTech;
      ka.tech += (ka.cities.length * 0.4 + ka.humanCount * 0.01 + ka.wealth * 0.001 + fac.smithy * 0.6 + fac.academy * CP.academyTech + res.ore * 0.5 + fac.wonder * 1.2) * this._eff(ka, "tech") * techRate * order * kingWit;
      // 武具の備蓄: 金属（鉱石）と工芸力で鍛造する。鍛造の量は燃料(炭=森林)が支える――
      //   炉に火を入れられねば多くは打てない。富からの調達(輸入)は燃料に依らない。治安で増減。
      const fuelF = 0.4 + 0.6 * Math.min(1, (ka.fuel || 0) / CP.fuelIron);
      ka.tools += (metalAvail ? ((res.ore * 0.3 * (0.6 + 0.8 * ka.craft) + fac.smithy * CP.craftToolW * ka.craft) * fuelF + Math.min(2.5, ka.wealth * 0.0025)) : 0) * order;
      if (ka.tools > ka.humanCount) ka.tools = ka.humanCount;
      // 製鉄の炭焼き: 鉄・鋼を盛んに鍛える国は、森を炭に費やして後退させる（史実の森林伐採）。
      //   植生システムが時とともに森を再生し、過伐採と再生の均衡が生まれる。
      if (ka._fuelTile >= 0 && craftTier(ka) >= 3 && this.rand() < CP.charcoalChance * (0.5 + (ka.craft || 0))) {
        const fi = ka._fuelTile, Wd = this.world.width;
        this.world.terrain[fi] = Game.TERRAIN.GRASS;
        if (this.renderer && this.renderer.markDirty) this.renderer.markDirty(fi % Wd, (fi / Wd) | 0);
        ka._fuelTile = -1;
      }
      // 個別技術の発見（tech が閾値を超えたら獲得し、年代記に記録）。
      for (let ti = 0; ti < TECHS.length; ti++) {
        const T = TECHS[ti];
        if (ka.tech >= T.at && !ka.techBits[T.id]) {
          ka.techBits[T.id] = true;
          ka.discovered.push(T.name);
          this._logEvent("🔬 " + ka.name + " が「" + T.name + "」を発見した");
        }
      }
      // 時代の進歩を年代記に記録（初到達のみ）。
      const eidx = Math.min(ERAS.length - 1, (ka.tech / TECH_PER_ERA) | 0);
      if (ka._eraIdx === undefined) ka._eraIdx = eidx;
      else if (eidx > ka._eraIdx) { ka._eraIdx = eidx; this._logEvent("✦ " + ka.name + " が" + ERAS[eidx] + "を迎えた"); }

      // 信仰の篤さ: 神殿・記念碑・神官が育み、政体(神権制)・敬虔な君主が増幅する。
      const devote = (fac.temple * 0.4 + fac.wonder * 0.6 + (ka.roleCount[ROLE.PRIEST] || 0) * 0.2) / Math.max(1, ka.cities.length);
      let faithTgt = clamp01(0.12 + devote * 0.28) * this._eff(ka, "faith");
      if (faithTgt > 1) faithTgt = 1;
      ka.faith = (ka.faith || 0) + (faithTgt - (ka.faith || 0)) * 0.1; // ゆっくり推移
      // 不満: 戦争・過密・貧困で上昇、平和・繁栄・神殿・穀倉・信仰で低下（性格・政体で変調）。
      let dU = -1.5;
      const warCount = this._count(ka.wars);
      dU += warCount * 2.6;
      if (ka.humanCount > cap) dU += 3;
      if (ka.wealth < ka.tileCount * 0.4) dU += 1.5; else dU -= 1.2;
      dU -= fac.temple * 0.7 + fac.granary * 0.4 + fac.tavern * CP.tavernCalm + res.fish * 0.3 + fac.wonder * 2.5 + (hasTech(ka, "law") ? 2 : 0) + ka.faith * CP.faithCalm; // 信仰・食料・酒場・漁場・記念碑・法典で安定

      // 食料経済: 農民・農場・漁場・採集で生産し、人口が消費する。穀倉が備蓄上限を上げる。
      // 因果の要: 生産は「土地の肥沃度（=植生。干ばつ・火災・噴火で低下）」と「季節
      //   （冬は減産）」と「治安」に連動する。これにより気候・災害・植生・社会が食料を
      //   通じて人口に波及する。
      const agriF = hasTech(ka, "agri") ? 1.3 : 1;
      const warDisrupt = 1 - Math.min(0.5, warCount * 0.22); // 戦争は農地を荒らす
      // 植生システムがある時のみ肥沃度を反映（無い環境＝テスト等では中立=1）。
      const fert = Game.state.vegetation ? (0.55 + 0.55 * this._landFertility(ka)) : 1; // 0.55〜1.1
      const season = Game.state.clock && Game.state.clock.season;
      const seasonF = season ? (0.55 + 0.45 * season.growth) : 1; // 冬≈0.66 夏≈1.16
      // 長期気候: 多雨で実り、乾燥で痩せる。温暖は概ね恵み（平均0中心なので経済の均衡は不変、
      //   ただし「豊穣の時代／旱魃の時代」という起伏を作る）。植生のある環境でのみ反映。
      const clk = Game.state.clock;
      const climF = Game.state.vegetation && clk ? (1 + 0.3 * (clk.wetness || 0) + 0.1 * (clk.warmth || 0)) : 1;
      const produce = (ka.roleCount[ROLE.FARMER] * CP.foodFarmer + fac.farm * CP.foodFarmBldg +
        res.fish * CP.foodFish + fac.harbor * CP.foodHarbor + ka.tileCount * CP.foodGather) * agriF * warDisrupt * fert * seasonF * climF * order;
      const consume = ka.humanCount * CP.foodConsume * (1 + warCount * 0.5);
      ka.food += produce - consume;
      const maxStore = CP.foodStoreBase + fac.granary * CP.foodStoreGranary + (res.salt || 0) * CP.saltStore; // 塩で保存（備蓄増）
      ka._famineDeaths = 0;
      if (ka.food < 0) {
        // 飢饉: 不足分に応じて餓死者が出る（後でまとめて適用）。社会も動揺。
        ka._famineDeaths = Math.min((ka.humanCount / 4) | 0, Math.ceil(-ka.food / CP.famineDeathFood));
        ka.food = 0;
        dU += 6; // 飢饉は不満を煽る（この後の clamp に反映）
        if (!ka.famine) this._logEvent("🌾 " + ka.name + " を飢饉が襲った");
        ka.famine = true;
      } else {
        if (ka.food > maxStore) ka.food = maxStore;
        ka.famine = false;
        if (ka.food > maxStore * 0.5) dU -= 1; // 食料に余裕があれば安定
      }
      // 正統性: 威信ある統治者は人心をまとめ不満を抑える（弱い君主の国は乱れやすい）。
      const rr = ka.rulerRef;
      if (rr && rr.alive) dU -= Math.min(3, (rr.prestige || 0) * 0.25);
      dU *= this._eff(ka, "unrest");
      ka.unrest = Math.max(0, Math.min(100, ka.unrest + dU));

      // 政治: 統治者の確認と継承。
      if (!rr || !rr.alive || rr.kid !== ka.id) {
        this._succeed(ka); // 空位・崩御・離反 → 政体に応じて継承
      } else {
        ka.reign += CP.diploInterval;
        // 長すぎる治世 → 代替わり（共和制は任期で交代しやすい）。
        const turnover = ka.gov === "共和制" ? 0.25 : 0.18;
        if (ka.reign > CP.reignSpan && this.rand() < turnover) this._succeed(ka);
        // クーデター: 不満が高く、統治者を遥かに凌ぐ威信の者がいれば政権を簒奪する。
        else if (ka.unrest > 72 && this.rand() < 0.12) {
          let rival = null, rs = (rr.prestige || 0) + 3;
          const ppl = this.people;
          for (let p = 0; p < ppl.length; p++) {
            const o = ppl[p];
            if (o.alive && o.kid === ka.id && o !== rr && (o.prestige || 0) > rs) { rs = o.prestige; rival = o; }
          }
          if (rival) this._succeed(ka, true); // 簒奪
        }
      }

      // 疫病: 過密で技術・衛生（神殿）が乏しい国に発生し、社会を動揺させやがて収束する。
      if (ka.plague > 0) {
        ka.plague--;
        ka.unrest = Math.min(100, ka.unrest + 6);
        if (ka.plague === 0) this._logEvent("✚ " + ka.name + " の疫病が収束した");
      } else {
        const crowd = ka.humanCount / Math.max(1, cap);
        const resist = 1 + Math.min(1.5, ka.tech * 0.004) + fac.temple * 0.4; // 技術・神殿で抵抗
        if (crowd > 0.6 && this.rand() < CP.plagueChance * crowd / resist) {
          ka.plague = CP.plagueDuration;
          this._plagues = (this._plagues || 0) + 1;
          this._logEvent("☣ " + ka.name + " で疫病が発生した");
        }
      }

      // 反乱: 不満が高く、複数都市を持つ国は地方が独立しうる。
      if (ka.unrest > 80 && ka.cities.length >= 2 &&
          this.kingdoms.length - 1 < Game.config.sim.maxKingdoms && this.rand() < 0.18) {
        this._rebellion(ka);
      }
    }

    // 飢饉による餓死をまとめて適用（人を1回だけ走査）。
    let anyFamine = false;
    for (let a = 1; a < ks.length; a++) if (ks[a] && ks[a].alive && ks[a]._famineDeaths > 0) { anyFamine = true; break; }
    if (anyFamine) {
      const people = this.people;
      for (let p = 0; p < people.length; p++) {
        const o = people[p];
        if (!o.alive || !o.kid) continue;
        const k = ks[o.kid];
        if (k && k._famineDeaths > 0) { o.alive = false; k._famineDeaths--; }
      }
    }

    // 従属関係の維持（朝貢・独立運動・後始末）。
    this._maintainVassals();

    // --- 国家ペア: 文化伝播・交易・開戦/同盟/講和 ---
    for (let a = 1; a < ks.length; a++) {
      const ka = ks[a];
      if (!ka || !ka.alive) continue;
      for (const bStr in ka.relations) {
        const b = +bStr;
        if (b <= a) continue;
        const kb = ks[b];
        if (!kb || !kb.alive) continue;
        const rel = ka.relations[b];

        // 文化交流・同化: 接触する文明どうしが技術・宗教・政体を伝え合い、合わなくても
        // 何らかの理由で一部を取り込む（迎合・融合）。国力で勝る国の宗教も依然広まる。
        if (ka.religion !== kb.religion) {
          if (ka.humanCount > kb.humanCount * 1.6 && this.rand() < 0.1 * this._eff(ka, "faith") * (0.4 + (ka.faith||0))) kb.religion = ka.religion;
          else if (kb.humanCount > ka.humanCount * 1.6 && this.rand() < 0.1 * this._eff(kb, "faith") * (0.4 + (kb.faith||0))) ka.religion = kb.religion;
        }
        this._culturalExchange(a, b, ka, kb);

        // 言語と外交: 言葉が通じ合う国どうしは親しみ（共通語・同系統の言葉＝意思疎通が
        //   容易で結びつきやすい）、言葉の隔たる国とは疎遠になりがち。接触下でのみ働く。
        if (ka.langX != null && kb.langX != null &&
            (this._isNeighbor(ka, b) || ka.allies[b] || (ka.partners && ka.partners[b]))) {
          const lmi = mutualIntel(ka.langX, ka.langY, kb.langX, kb.langY);
          this._setRel(a, b, ka.relations[b] + (lmi - 0.7) * CP.langDiploPull);
        }

        // 信仰と外交: 同じ信仰の国は親しみ合い、異教の国とは隔たる（接触下でのみ働く）。
        if (this._isNeighbor(ka, b) || ka.allies[b] || (ka.partners && ka.partners[b])) {
          this._setRel(a, b, ka.relations[b] + (ka.religion === kb.religion ? CP.faithDiploPull : -CP.faithDiploFric));
        }

        // 疫病の伝播: 流行国に国境を接する隣国へ広がる。
        if (this._isNeighbor(ka, b)) {
          if (ka.plague > 0 && !(kb.plague > 0) && this.rand() < CP.plagueSpread) {
            kb.plague = CP.plagueDuration; this._logEvent("☣ " + kb.name + " にも疫病が広がった");
          } else if (kb.plague > 0 && !(ka.plague > 0) && this.rand() < CP.plagueSpread) {
            ka.plague = CP.plagueDuration; this._logEvent("☣ " + ka.name + " にも疫病が広がった");
          }
        }

        // 交易（取引）: 戦争でなければ、余剰と不足を交換して双方が富む（比較優位）。
        // 交易力は文明により異なり、食料は飢えた国へ流れて飢饉を和らげる。
        if (!ka.wars[b]) {
          const traded = this._trade(a, b, ka, kb);
          if (traded && !ka.allies[b]) this._setRel(a, b, rel + 0.5); // 通商は友好を育む
        }

        if (ka.wars[b]) {
          // 戦争疲弊: 長期化・劣勢ほど講和しやすい。
          const dur = (this._tickN || 1) - ka.wars[b];
          const m1 = this._military(ka), m2 = this._military(kb);
          // 決定的な軍事差 → 強国が講和条件（賠償・併合）を強いる。
          if (m1 >= m2 * CP.decisiveRatio) { this._imposePeace(a, b); }
          else if (m2 >= m1 * CP.decisiveRatio) { this._imposePeace(b, a); }
          else {
            let pc = CP.peaceChance * (1 + dur / 3000);
            if (m1 < m2 * 0.6 || m2 < m1 * 0.6) pc *= 2; // 大差がつけば手打ち
            if (this.rand() < pc) this._makePeace(a, b);
          }
        } else if (ka.allies[b]) {
          // 同盟解消: 国境を接し互いに土地不足だと利害が衝突し決裂しやすい。
          let breakC = 0.05;
          if (this._isNeighbor(ka, b) &&
              ka.humanCount >= this._capacity(ka) * 0.9 && kb.humanCount >= this._capacity(kb) * 0.9) {
            breakC = 0.15;
          }
          if (this.rand() < breakC) { delete ka.allies[b]; delete kb.allies[a]; this._setRel(a, b, 5); }
        } else {
          // 開戦は隣国どうしのみ（前近代は国境を接さない国へ兵を送れない）。
          // 同盟は遠国とも結べる（婚姻・通商同盟）。
          const neighbor = this._isNeighbor(ka, b);
          const sameFaith = ka.religion === kb.religion;
          // 聖戦: 異教の相手とは、双方の信仰が篤いほど開戦への熱が高まる。
          const fervor = sameFaith ? 1 : (1 + ((ka.faith || 0) + (kb.faith || 0)) * 0.5 * CP.faithWarFervor);
          const warF = (this._eff(ka, "war") + this._eff(kb, "war")) * 0.5 * (sameFaith ? 0.6 : 1.4) * fervor;
          const allyF = (this._eff(ka, "ally") + this._eff(kb, "ally")) * 0.5 * (sameFaith ? 1.4 : 0.6);
          // 土地不足の隣国どうしは領土紛争で開戦しやすい（信仰に左右されない casus belli）。
          let territorial = 0;
          if (neighbor) {
            const needA = ka.humanCount >= this._capacity(ka) * 0.9;
            const needB = kb.humanCount >= this._capacity(kb) * 0.9;
            if (needA || needB) territorial = CP.warPressure * 0.18;
          }
          let warP = (neighbor ? (0.06 + (rel < 0 ? (-rel / 100) * 0.25 : 0)) * warF : 0) + territorial;
          const allyP = (0.05 + (rel > 0 ? (rel / 100) * 0.2 : 0)) * allyF;
          // 経済的相互依存: 主要な交易相手とは戦になりにくい（交易が平和を育む）。
          const bond = (ka.partners && ka.partners[b]) || 0;
          if (bond > 0) { const dep = Math.min(1, bond / (1 + ka.tradeVol)); warP *= 1 - CP.tradePeace * dep; }
          // 休戦中・従属関係（宗主と属国）とは開戦しない。
          const truced = ka.truce && ka.truce[b] && ka.truce[b] > (this._tickN || 0);
          const bound = ka.suzerain === b || kb.suzerain === a;
          // 同盟上限に達していれば新たな同盟は結べない（同盟の乱立を防ぐ）。
          const canAlly = this._count(ka.allies) < CP.maxAllies && this._count(kb.allies) < CP.maxAllies;
          const r = this.rand();
          if (!truced && !bound && r < warP) this._declareWar(a, b);
          else if (canAlly && r < warP + allyP) this._formAlliance(a, b);
          else {
            // 平時のゆらぎ。異教は緊張（悪化寄り）、同教は親和（改善寄り）。
            // 国境を接さない国とは関係が徐々に中立へ薄れる。
            if (!neighbor && Math.abs(rel) > 4) this._setRel(a, b, rel * 0.85);
            else {
              const drift = sameFaith ? (this.rand() * 8 - 3) : (this.rand() * 8 - 5.5);
              this._setRel(a, b, rel + drift);
            }
          }
        }
      }
    }
  };

  CivSystem.prototype._count = function (obj) {
    let n = 0;
    for (const k in obj) n++;
    return n;
  };

  // 反乱: 最も首都から遠い地方都市が独立し、周辺領土と住民を奪って新国家になる。
  CivSystem.prototype._rebellion = function (parent) {
    if (parent.cities.length < 2) return;
    const cap = parent.cities[0];
    // 独立する都市（首都から最も遠い非首都都市）。
    let idx = -1, bd = -1;
    for (let c = 1; c < parent.cities.length; c++) {
      const dx = parent.cities[c].x - cap.x, dy = parent.cities[c].y - cap.y;
      const d = dx * dx + dy * dy;
      if (d > bd) { bd = d; idx = c; }
    }
    if (idx < 0) return;
    const city = parent.cities[idx];

    // 新国家レコード（独立都市を首都に）。
    const id = this.kingdoms.length;
    const govIdx = (this.rand() * GOV_TYPES.length) | 0;
    const nk = {
      id: id,
      name: makeName(this.rand),
      ruler: RULER_NAMES[(this.rand() * RULER_NAMES.length) | 0],
      gov: GOV_TYPES[govIdx],
      govMod: GOV_MODS[govIdx],
      color: makeColor(this.rand),
      cities: [{ x: city.x, y: city.y, capital: true, level: city.level || 1, buildings: (city.buildings || []) }],
      reign: 0,
      tileCount: 0, humanCount: 0, roleCount: [0, 0, 0, 0, 0, 0, 0], clanSeq: 0,
      facilities: newFacilities(),
      tools: parent.tools * 0.3,
      relations: {}, borders: {}, wars: {}, allies: {}, truce: {}, vassals: {}, suzerain: 0,
      tech: parent.tech * 0.7, techBits: {}, discovered: [], religion: parent.religion,
      // 言語: 独立した地方は母国の言葉を受け継ぎ、以後ゆるやかに方言として分岐していく。
      langX: clamp01((parent.langX == null ? 0.5 : parent.langX) + (this.rand() - 0.5) * 0.05),
      langY: clamp01((parent.langY == null ? 0.5 : parent.langY) + (this.rand() - 0.5) * 0.05),
      trait: TRAITS[(this.rand() * TRAITS.length) | 0],
      ethos: parent.ethos || NATION_ETHOS[(this.rand() * NATION_ETHOS.length) | 0], // 国是は母国から継ぐ
      wealth: 0, food: 20, famine: false, unrest: 30, plague: 0, res: { ore: 0, fish: 0, gems: 0, gold: 0, horses: 0, spice: 0, salt: 0, timber: 0 }, alive: true,
    };
    this.kingdoms.push(nk);
    // 宗派分裂（独立に伴う異端の発生）: 独立国はしばしば母国の信仰から分かれ、
    //   独自の宗派を立てる。これが宗教戦争や更なる対立の火種になる（信仰の多様化）。
    if (parent.religion && this.rand() < CP.schismChance) {
      nk.religion = schismName(parent.religion, this.rand);
      this._logEvent("☩ " + nk.name + " が " + nk.religion + " を奉じて宗派を分かった");
    }
    parent.cities.splice(idx, 1);

    // 周辺領土を割譲（独立都市の周囲 R タイル）。
    const world = this.world, W = world.width, H = world.height, owner = world.owner;
    const R = 22;
    for (let y = city.y - R; y <= city.y + R; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = city.x - R; x <= city.x + R; x++) {
        if (x < 0 || x >= W) continue;
        const i = y * W + x;
        if (owner[i] === parent.id) {
          owner[i] = id;
          parent.tileCount--; nk.tileCount++;
          if (this.renderer) this.renderer.markTerritoryDirty(x, y);
        }
      }
    }
    if (nk.tileCount === 0) { owner[city.y * W + city.x] = id; nk.tileCount = 1; }

    // 独立都市を home とする住民を新国家へ。
    // 言語の分岐: 独立は時に言葉の決別を伴う。独立集団が一斉に言葉をずらすことで、
    //   母国とは通じ合いにくい独自の言語系統へと枝分かれする（収束だけでない分化）。
    const split = this.rand() < CP.langSplit;
    const sox = (this.rand() - 0.5) * 2 * CP.langSplitAmt;
    const soy = (this.rand() - 0.5) * 2 * CP.langSplitAmt;
    const clan = ++nk.clanSeq;
    const R2 = R * R;
    const people = this.people;
    for (let p = 0; p < people.length; p++) {
      const o = people[p];
      if (!o.alive || o.kid !== parent.id) continue;
      const hx = o.home ? o.home.x : o.x, hy = o.home ? o.home.y : o.y;
      const dx = hx - city.x, dy = hy - city.y;
      if (dx * dx + dy * dy > R2) continue;
      parent.humanCount--; parent.roleCount[o.role]--;
      o.kid = id; o.clan = clan; o.home = { x: city.x, y: city.y }; o.farm = null;
      if (split && o.lx != null) { o.lx = clamp01(o.lx + sox); o.ly = clamp01(o.ly + soy); }
      nk.humanCount++; nk.roleCount[o.role]++;
    }

    // 独立戦争（親国と交戦）。親の不満は少し晴れる。
    const t = this._tickN || 1;
    nk.relations[parent.id] = -70; parent.relations[id] = -70;
    nk.wars[parent.id] = t; parent.wars[id] = t;
    parent.unrest = 45;
    this._logEvent("✊ " + nk.name + " が " + parent.name + " から独立した");
  };

  // UI 用: 各国の要約（人口降順）。
  CivSystem.prototype.getNations = function () {
    const ks = this.kingdoms;
    const out = [];
    for (let a = 1; a < ks.length; a++) {
      const k = ks[a];
      if (!k || !k.alive) continue;
      const wars = [], allies = [];
      for (const b in k.wars) if (ks[b] && ks[b].alive) wars.push(ks[b].name);
      for (const b in k.allies) if (ks[b] && ks[b].alive) allies.push(ks[b].name);
      out.push({
        id: a, name: k.name, ruler: k.ruler, dynasty: k.dynasty || null, gov: k.gov, color: k.color,
        pop: k.humanCount, cities: k.cities.length, tiles: k.tileCount,
        capital: k.cities[0], wars: wars, allies: allies,
        religion: k.religion, era: eraOf(k.tech), tech: Math.round(k.tech),
        trait: k.trait.name, wealth: Math.round(k.wealth), unrest: Math.round(k.unrest),
        tools: Math.round(k.tools || 0), facilities: k.facilities,
        food: Math.round(k.food || 0), famine: !!k.famine,
        techCount: k.discovered ? k.discovered.length : 0,
        latestTechs: k.discovered ? k.discovered.slice(-3) : [],
        morale: k.moodAvg != null ? Math.round(k.moodAvg * 100) : null,
        figure: k.figure || null,
        trade: Math.round(k.tradeVol || 0),
        tradeIncome: Math.round(k.tradeIncome || 0),
        foodTrade: Math.round(k.foodTrade || 0),
        market: k.prices ? (function () {
          // 最も高い（希少＝輸入したい）財と、最も安い（豊富＝輸出できる）財。
          let hi = null, hv = -1, lo = null, lv = 1e9;
          for (let i = 0; i < GOODS.length; i++) {
            const v = k.prices[GOODS[i].id];
            if (v > hv) { hv = v; hi = GOODS[i].name; }
            if (v < lv) { lv = v; lo = GOODS[i].name; }
          }
          return { scarce: hi, scarceP: hv, abundant: lo, abundantP: lv };
        })() : null,
        partners: k.partners ? (function () {
          const out = [];
          for (const id in k.partners) { const kb = ks[+id]; if (kb && kb.alive) out.push({ name: kb.name, vol: k.partners[id] }); }
          out.sort(function (x, y) { return y.vol - x.vol; });
          return out;
        })() : [],
      });
    }
    out.sort(function (x, y) { return y.pop - x.pop; });
    return out;
  };

  // 放浪者の1ティック: 採食・移動・繁殖。仲間と肥沃地に集まれば国を興す。
  CivSystem.prototype._tickNomad = function (h, world, tN, i) {
    h.age++;
    h.food -= CP.metab;
    if (h.repro > 0) h.repro--;

    // 採食。
    const tx = h.x | 0, ty = h.y | 0;
    const ti = ty * world.width + tx;
    if (tile.isEdible(world.terrain[ti])) {
      let gain = CP.eatGain;
      if (world.fertility) {
        const f = world.fertility[ti];
        gain *= 0.5 + 0.5 * (f > 1 ? 1 : f);
        world.fertility[ti] = f > CP.harvest ? f - CP.harvest : 0;
      }
      h.food += gain;
      if (h.food > 1) h.food = 1;
    }

    // 思考（重い処理は間引き）: 加入・建国・定住地探し・繁殖。
    if (((tN + i) % CP.thinkInterval) === 0) {
      // 1) 加入: 足下が既存国の領土なら、その国に加わる（最優先）。
      const o = world.owner[ti];
      if (o !== 0) {
        const k = this.kingdoms[o];
        if (k && k.alive && k.humanCount < CP.perKingdomCap) { this._joinKingdom(h, k); return; }
      }
      // 2) 近くに国の民がいれば、そこへ向かって加入を目指す。
      const citizen = this._scan(h.x, h.y, CP.joinRadius, function (oo) {
        return (oo.kid !== 0 && oo.alive) ? 2 : 0;
      }).best;
      if (citizen) {
        const dx = citizen.x - h.x, dy = citizen.y - h.y;
        if (dx * dx + dy * dy < 6) {
          const k = this.kingdoms[citizen.kid];
          if (k && k.alive && k.humanCount < CP.perKingdomCap) { this._joinKingdom(h, k); return; }
        }
        h.gx = citizen.x | 0; h.gy = citizen.y | 0; h.state = 9;
      } else {
        // 3) 定住先（肥沃な無所属地）を探す。無ければ仲間と群れる/徘徊。
        const spot = this._nearestTile(h, world, 5, function (terr, ow) {
          return ow === 0 && tile.isEdible(terr);
        });
        if (spot) { h.gx = spot.x; h.gy = spot.y; h.state = 10; }
        else {
          const mate = this._scan(h.x, h.y, CP.nomadClusterRadius, function (oo) { return oo.kid === 0 && oo.alive ? 2 : 0; }).best;
          if (mate) { h.gx = mate.x | 0; h.gy = mate.y | 0; }
          else { h.gx = (h.x + (this.rand() - 0.5) * 8) | 0; h.gy = (h.y + (this.rand() - 0.5) * 8) | 0; }
          h.state = 11;
        }

        // 4) 建国: 無所属の可食地に仲間が集まっていれば国を興す（近くに国が無いときのみ）。
        if (world.owner[ti] === 0 && tile.isEdible(world.terrain[ti]) &&
            this.kingdoms.length - 1 < Game.config.sim.maxKingdoms) {
          const band = this._scan(h.x, h.y, CP.nomadFoundRadius, function (oo) { return oo.kid === 0 && oo.alive ? 1 : 0; });
          if (band.count >= CP.nomadFoundBand && this.rand() < CP.nomadFoundChance) {
            this._foundFromNomads(h, tx, ty);
            return;
          }
        }
      }

      // 繁殖（放浪者同士）。
      this._tryReproduceNomad(h);
    }

    this._move(h, null, world);

    if (h.food <= 0 || h.age > CP.maxAge) h.alive = false;
  };

  // 放浪者が既存の国に加入して市民になる。
  CivSystem.prototype._joinKingdom = function (h, k) {
    h.kid = k.id;
    h.clan = ++k.clanSeq;
    h.role = this._assignRole(k);
    h.home = this._nearestCity(k, h.x, h.y);
    h.farm = null;
    h.gx = h.home.x; h.gy = h.home.y;
    h.repro = CP.reproCooldown;
    h.social = 0;
    k.humanCount++;
    k.roleCount[h.role]++;
  };

  // 過密＋飢餓の市民は国を離れて流民になり、よりよい土地を求める（移民）。
  CivSystem.prototype._leaveKingdom = function (h, k) {
    k.humanCount--;
    k.roleCount[h.role]--;
    h.kid = 0;
    h.clan = 0;
    h.role = ROLE.EXPLORER;
    h.home = null;
    h.farm = null;
    h.repro = CP.reproCooldown;
  };

  // 市民が状況に応じて転職する（飢饉で農民へ、戦時に兵士へ等の適応行動）。
  CivSystem.prototype._switchRole = function (h, k, role) {
    if (h.role === role) return;
    k.roleCount[h.role]--;
    h.role = role;
    k.roleCount[role]++;
    h.farm = null; h.work = null; h._enemy = null;
    // 転職で練度はかなり失われる（新しい技能を一から積み直す）。
    if (h.skill != null) h.skill *= 0.4;
  };

  // 放浪者の集団が建国: 中心の人とその周囲の放浪者が新王国の住人になる。
  CivSystem.prototype._foundFromNomads = function (h, tx, ty) {
    const k = this._newKingdom(tx, ty);
    if (!k) return;
    const clan = ++k.clanSeq;
    const people = this.people;
    const r = CP.nomadFoundRadius;
    const r2 = r * r;
    // 中心の人＋周囲の放浪者を市民に転向。
    for (let p = 0; p < people.length; p++) {
      const o = people[p];
      if (!o.alive || o.kid !== 0) continue;
      const dx = o.x - h.x, dy = o.y - h.y;
      if (dx * dx + dy * dy > r2) continue;
      if (k.humanCount >= CP.perKingdomCap) break;
      o.kid = k.id;
      o.clan = clan;
      o.role = this._assignRole(k);
      o.home = { x: tx, y: ty };
      o.farm = null;
      o.gx = tx; o.gy = ty;
      o.repro = CP.reproCooldown;
      o.social = 0;
      k.humanCount++;
      k.roleCount[o.role]++;
    }
    this._logEvent("⚑ " + k.name + " が建国された");
  };

  CivSystem.prototype._tryReproduceNomad = function (h) {
    if (h.age < CP.adultAge || h.age > CP.elderAge) return;
    if (h.food < CP.reproFood || h.repro > 0) return;
    if (this.people.length + this._births.length >= Game.config.sim.maxPeople) return;
    const partner = this._scan(h.x, h.y, CP.reproRadius, function (o) {
      return (o.kid === 0 && o !== h && o.alive && o.age >= CP.adultAge && o.food >= CP.reproFood &&
        o.repro <= 0 && !closeKin(h, o)) ? 2 : 0;
    }).best;
    if (!partner) return;
    h.repro = (h.aspire === 4 ? CP.reproCooldown / CP.aspireFamily : CP.reproCooldown);
    partner.repro = (partner.aspire === 4 ? CP.reproCooldown / CP.aspireFamily : CP.reproCooldown);
    h.food -= CP.reproCost; partner.food -= CP.reproCost;
    const child = {
      x: h.x, y: h.y, hx: 0, hy: 0,
      kid: 0, clan: 0, age: 0, food: 0.7,
      role: ROLE.EXPLORER, state: 0, gx: h.x | 0, gy: h.y | 0,
      repro: CP.reproCooldown, social: 0, alive: true,
    };
    this._endow(child, h, partner); // 両親から個性・文化を遺伝
    this._bond(h, partner);         // 伴侶として結ばれる
    this._births.push(child);
  };

  // 自国領に地続きの未開地のみ確保する（足下が自国領のときだけ周囲へ拡張）。
  // これにより領土は都市から連続した塊として広がる（斑点・飛び地を防ぐ）。
  CivSystem.prototype._claimNeighbors = function (h, k, world) {
    const W = world.width, H = world.height, owner = world.owner, id = k.id;
    const cx = h.x | 0, cy = h.y | 0;
    // 足下が自国領でなければ拡張しない（連続性の担保）。
    if (owner[cy * W + cx] !== id) return;
    const nb = [cx - 1, cy, cx + 1, cy, cx, cy - 1, cx, cy + 1];
    for (let n = 0; n < 8; n += 2) {
      const x = nb[n], y = nb[n + 1];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const ni = y * W + x;
      if (!tile.isLand(world.terrain[ni])) continue;
      const o = owner[ni];
      if (o === 0) {
        owner[ni] = id; k.tileCount++;
        if (this.renderer) this.renderer.markTerritoryDirty(x, y);
      } else if (o !== id) {
        this._contact(id, o);
      }
    }
  };

  // (x,y) の4近傍に id の領土があるか（前線判定）。
  CivSystem.prototype._adjacentOwner = function (world, x, y, id) {
    const W = world.width, H = world.height, owner = world.owner;
    if (x > 0 && owner[y * W + x - 1] === id) return true;
    if (x < W - 1 && owner[y * W + x + 1] === id) return true;
    if (y > 0 && owner[(y - 1) * W + x] === id) return true;
    if (y < H - 1 && owner[(y + 1) * W + x] === id) return true;
    return false;
  };

  // 最寄り集落への方向・距離2乗を返す。
  CivSystem.prototype._home = function (h, k) {
    let dx = 0, dy = 0, d2 = 1e9;
    for (let c = 0; c < k.cities.length; c++) {
      const ddx = k.cities[c].x + 0.5 - h.x;
      const ddy = k.cities[c].y + 0.5 - h.y;
      const d = ddx * ddx + ddy * ddy;
      if (d < d2) { d2 = d; dx = ddx; dy = ddy; }
    }
    return { dx: dx, dy: dy, d2: d2 };
  };

  // 二人を伴侶として結ぶ（独身どうしのみ。一夫一妻的な家族の核を作る）。
  CivSystem.prototype._bond = function (a, b) {
    if (a === b) return;
    if (!a.partner && !b.partner) { a.partner = b; b.partner = a; }
  };

  // a の親友リストに b を加える/絆を深める（会話の積み重ねで友誼が育つ。上限あり）。
  CivSystem.prototype._befriend = function (a, b, amount) {
    let list = a.bonds;
    if (!list) list = a.bonds = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].ref === b) { list[i].aff = Math.min(1, list[i].aff + amount); return; }
    }
    if (list.length < MAX_BONDS) { list.push({ ref: b, aff: amount }); return; }
    // 満杯なら最も希薄な絆を、新しい相手が上回るとき置き換える（関係の新陳代謝）。
    let wi = 0, wv = list[0].aff;
    for (let i = 1; i < list.length; i++) if (list[i].aff < wv) { wv = list[i].aff; wi = i; }
    if (amount > wv * 0.5) list[wi] = { ref: b, aff: amount };
  };

  // 親友・伴侶の死を悼む（絆の相手が世を去っていたら悲嘆し、リストを整理する）。
  // grief は機嫌を下げ、社会の喪失が個人に影を落とす。
  CivSystem.prototype._mournLost = function (h) {
    let grief = 0;
    if (h.partner && !h.partner.alive) { grief += 0.28; h.partner = null; }
    const list = h.bonds;
    if (list && list.length) {
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i].ref.alive) list[w++] = list[i];
        else grief += 0.1 * list[i].aff;
      }
      list.length = w;
    }
    return grief;
  };

  // 会話・交流・機嫌の更新（thinkInterval 毎・低負荷）。社会の核となる処理。
  // 近くの同胞ひとりと「言葉を交わし」、互いに影響を及ぼし合う:
  //  - 孤独が癒え、機嫌が伝染する（名士ほど強く人心を動かす＝influence）。
  //  - 腕利きから技を学び練度が伝播する（知識の社会的伝達）。
  //  - 食料地の知らせを分かち合う（資源の知識が口伝えに広まる）。
  //  - 文化的気質が混ざり合う（地域・国ごとの文化が創発する）。
  //  - 語らいを重ねた相手とは親友になる。伴侶・親友の死は深く悼む。
  // 機嫌は暮らし向き（食料・社交・戦争・飢饉・絆の喪失）へ向けて推移し、実効能力に効く。
  CivSystem.prototype._socialize = function (h, k) {
    const self = this;
    // 喪失を悼む（伴侶・親友の死）。
    const grief = this._mournLost(h);
    // 名声: 練度・齢・徳がにじみ出て、ゆっくり高まる（功績＝武功・普請は別途加算）。
    // 熟達し齢を重ねた者ほど周囲に一目置かれ、やがて名のある人物となる（ごく一部）。
    h.prestige = (h.prestige || 0) + 0.05 * (0.2 + (h.skill || 0)) * (h.age > CP.elderAge ? 1.6 : h.age > CP.adultAge ? 1 : 0.2) * ((h.aspire === 0 || h.aspire === 3) ? CP.aspirePrestige : 1);
    // 名のある人物として歴史に登場（初めて閾値を超えたとき）。
    if (!h._famed && h.prestige >= FAME_THRESHOLD) {
      h._famed = true;
      this._logEvent("◆ " + h.name + "（" + k.name + "）が" + titleOf(h) + "として名を馳せた");
    }

    // 近傍の同胞を数え、最寄りの一人を「会話相手」とする。
    const scan = this._scan(h.x, h.y, CP.socialRadius, function (o) {
      return (o !== h && o.kid === h.kid) ? 2 : 0;
    });
    const company = scan.count2;
    const other = scan.best;
    if (company > 0) h.social = 0; // 語らいで孤独が癒える

    if (other) {
      const infl = influence(other); // 相手の社会的影響力
      // 言葉の通じ合い（相互理解度）: 同じ言葉ならよく伝わり、異なる言葉だと意思疎通が
      //   滞る。会話による学び・気分や文化の伝播・友誼はこの理解度に比例して濃くなる。
      const mi = (h.lx != null && other.lx != null)
        ? mutualIntel(h.lx, h.ly, other.lx, other.ly) : 1;
      // 言葉の歩み寄り（収束）: 互いに相手の言葉へ少し近づく。これが世代を超えて
      //   少数派を多数派の言葉へ同化させ、共通語・方言地理を創発させる。若いほど速い。
      if (h.lx != null && other.lx != null) {
        const acc = CP.langAccom * (h.age < CP.adultAge ? 1.6 : 1);
        h.lx += (other.lx - h.lx) * acc; h.ly += (other.ly - h.ly) * acc;
      }
      // 機嫌の伝染（名士の上機嫌・不機嫌は周囲に強く広がる。言葉が通じるほど強く）。
      h.mood += (other.mood - h.mood) * 0.06 * infl * mi;
      // 感情の伝染: 恐怖は群れに燃え移りパニックに（上向きに強く伝わる）、喜びも分かち合う。
      // これにより一頭の猛獣が群衆の将棋倒し的な逃走を引き起こす等の創発が生まれる。
      // （恐怖は言葉に依らず伝わる原初的な情動なので理解度の影響は小さめ。）
      const of = other.fear || 0;
      if (of > (h.fear || 0)) h.fear = Math.min(1, (h.fear || 0) + (of - (h.fear || 0)) * 0.35 * (0.7 + 0.3 * mi));
      h.joy = clamp01((h.joy || 0) + (((other.joy || 0)) - (h.joy || 0)) * 0.12 * mi);
      // 知識の伝播: 相手の方が熟練していれば技を学ぶ（賢い者ほど速い。言葉が通じるほど速い）。
      const gap = (other.skill || 0) - (h.skill || 0);
      if (gap > 0.02) { h.skill += gap * 0.05 * (h.wit || 1) * infl * mi; if (h.skill > 1) h.skill = 1; }
      // 食料地の知らせを分かち合う（自分が知らず相手が知っていれば教わる。要・意思疎通）。
      if (!h.memFood && other.memFood && mi > 0.55) h.memFood = { x: other.memFood.x, y: other.memFood.y };
      // 文化の混交（相手の気質に少し近づく。名士の文化ほど・言葉が通じるほど伝播力が強い）。
      h.culture = clamp01((h.culture == null ? 0.5 : h.culture) + (((other.culture == null ? 0.5 : other.culture)) - (h.culture == null ? 0.5 : h.culture)) * 0.04 * infl * mi);
      // 友誼: 同氏族・近距離・気の合う（文化が近い）相手とは絆が深まる。
      // 血縁(氏族)に加え、同じ人種とはやや親しみやすく、言葉が通じるほど親しみやすい。
      const akin = ((h.clan && other.clan === h.clan) ? 1.6 : 1) * (h.race === other.race ? 1.12 : 1);
      const cultSim = 1 - Math.abs((h.culture || 0.5) - (other.culture || 0.5));
      this._befriend(h, other, 0.06 * akin * cultSim * mi);
      // 血縁の扶助: 満ち足りた者は、飢えた同じ血統（家族・氏族）の者に食を分け与える
      // （血縁淘汰＝身内を助ける利他）。伴侶には特に手厚く。
      const kin = (h.partner === other) ? 1 : (h.clan && other.clan === h.clan ? 0.7 : 0);
      if (kin > 0 && h.food > 0.65 && other.food < 0.3) {
        const give = Math.min(0.18 * kin, h.food - 0.5);
        if (give > 0.02) { h.food -= give; other.food = Math.min(1, other.food + give); }
      }
    }

    // 分岐・独自進化: 言葉と文化は会話で収束（同化）するだけでなく、絶えず微小に揺らぎ、
    //   稀に大きく革新して独自の系統へ枝分かれする。会話相手のいない孤立した辺境ほど
    //   歩み寄りが効かず分化が進み、革新は新たな方言・文化の源となる。
    if (h.lx != null) {
      h.lx = clamp01(h.lx + (this.rand() - 0.5) * CP.langDrift);
      h.ly = clamp01(h.ly + (this.rand() - 0.5) * CP.langDrift);
      if (this.rand() < CP.langInnov) {
        h.lx = clamp01(h.lx + (this.rand() - 0.5) * CP.langInnovAmt);
        h.ly = clamp01(h.ly + (this.rand() - 0.5) * CP.langInnovAmt);
      }
    }
    if (h.culture != null) {
      h.culture = clamp01(h.culture + (this.rand() - 0.5) * CP.cultDrift);
      if (this.rand() < CP.cultInnov) h.culture = clamp01(h.culture + (this.rand() - 0.5) * CP.cultInnovAmt);
    }

    // 喜び(joy)を更新: 仲間・伴侶と過ごし、満ち足りていると湧く（社交欲は synSoc で個人差）。
    const socSat = CP.socialNeed * (h.synSoc || 1);
    let dj = 0;
    if (company > 0) dj += 0.06;
    if (h.partner && h.partner.alive) dj += 0.05;
    if (h.food > 0.6) dj += 0.05;
    h.joy = Math.min(1, (h.joy || 0) + dj);

    // 機嫌の目標値: 普通(0.5)を基準に、満腹・社交・親友・国情＋感情で上下する。
    let target = 0.5 + (h.food - 0.5) * 0.4;
    if (company >= socSat) target += 0.08; else if (company === 0) target -= 0.12;
    const friends = h.bonds ? h.bonds.length : 0;
    if (friends > 0) target += 0.012 * (friends > 3 ? 3 : friends); // 親しい仲間がいると心安らか
    if (h.partner && h.partner.alive) target += 0.03;   // 伴侶の支え
    if (k.famine) target -= 0.22;
    if (this._count(k.wars) > 0) target -= 0.12;
    target += (40 - (k.unrest || 0)) * 0.0015;          // 安定した国は人心も穏やか
    target += 0.12 * (h.joy || 0) - 0.18 * (h.fear || 0); // 感情が気分を彩る
    if (target < 0) target = 0; else if (target > 1) target = 1;
    h.mood += (target - h.mood) * 0.15 - grief;         // ゆっくり推移＋喪失の悲嘆
    if (h.mood < 0) h.mood = 0; else if (h.mood > 1) h.mood = 1;
  };

  // AI: 欲求と役割を勘案して目標(gx,gy)を決める「熟考」。thinkInterval 毎にのみ実行。
  CivSystem.prototype._think = function (h, k, world) {
    const self = this;
    // 知性(wit)が判断の質を左右する: 賢い者ほど脅威に早く気づき、状況に応じて
    // 適切に立ち回り（転職）、肥沃な農地を選ぶ。これにより wit に選択圧がかかる。
    const wit = h.wit || 1;
    // 視野: その人が世界をどれだけ見渡せるか。知性で広く、夜は狭く、幼少・老齢では
    // やや狭い。さらに地形が効く: 森・密林は見通しを奪い(隠れ場所＝待ち伏せ)、丘・山は
    // 物見の高所として視界を広げる。以降の脅威察知・採餌はこの視野の内側だけを知覚する。
    const ageF = h.age < CP.adultAge ? 0.78 : (h.age >= CP.elderAge ? 0.85 : 1);
    const T = Game.TERRAIN;
    const hereT = world.terrain[(h.y | 0) * world.width + (h.x | 0)];
    const terrSight = (hereT === T.FOREST || hereT === T.JUNGLE || hereT === T.SWAMP) ? 0.6
      : (hereT === T.HILL || hereT === T.MOUNTAIN) ? 1.4 : 1;
    const sight = h.sight = CP.sightBase * (0.7 + 0.3 * wit) * (this._night ? 0.62 : 1) * ageF * terrSight;
    // 感情の自然減衰（時間とともに落ち着く）。出来事が以下で高ぶらせる。
    h.fear = (h.fear || 0) * 0.7;
    h.anger = (h.anger || 0) * 0.72;
    h.joy = (h.joy || 0) * 0.8;
    // シナプス可塑性（経験からの学習＝氏より育ち）: 直近の経験で脳の配線が少しずつ変わる。
    //   恐ろしい目に遭えば用心深く(synSafe↑)、飢えれば食を優先するよう(synFood↑)に。
    //   危険も飢えも無く穏やかなら配線は中庸へ緩む。子供ほど・賢いほど学習が速い。
    if (h.synSafe !== undefined) {
      const up = (h.age < CP.adultAge ? 0.02 : 0.008) * (0.6 + 0.4 * wit); // 子供ほど・賢いほど速く学ぶ
      const down = up * 0.22; // 習い性はゆっくりしか抜けない（経験が永く残る）
      h.synSafe = learn(h.synSafe, (h.fear || 0) > 0.4 ? 1.3 : 1.0, up, down);
      h.synFood = learn(h.synFood, h.food < 0.3 ? 1.3 : 1.0, up, down);
    }
    // 近傍の土地を確保（足下は毎ティック）。
    this._claimNeighbors(h, k, world);
    // 社会的な交わり（会話）と機嫌の更新。人々が互いに影響し合い社会を形づくる。
    this._socialize(h, k);
    // 繁殖（成人・食料十分・近くに同胞成人がいれば家族を作る）。
    this._tryReproduce(h, k);

    // 0) 移民: 国が過密で食料も乏しければ、町を捨て流民となり新天地を探す。
    const capacity = this._capacity(k);
    if (h.food < 0.3 && k.humanCount > capacity && this.rand() < 0.12) {
      this._leaveKingdom(h, k); return;
    }

    // 0.2) 適応: 慢性的な飢えで農民が手薄なら食料生産へ転職。戦時に兵が手薄なら民間人が
    //      武器を取る（緊急徴募）。状況に応じて職を変える＝賢い集団としての振る舞い。
    if (h.role !== ROLE.FARMER && h.food < 0.25 &&
        k.roleCount[ROLE.FARMER] < k.humanCount * 0.3 && this.rand() < 0.12 * wit) {
      this._switchRole(h, k, ROLE.FARMER);
    } else if ((h.role === ROLE.EXPLORER || h.role === ROLE.BUILDER) && this._count(k.wars) > 0 &&
        k.roleCount[ROLE.SOLDIER] < k.humanCount * 0.12 && this.rand() < 0.06 * wit * (h.aspire === 1 ? 1.8 : 1)) {
      this._switchRole(h, k, ROLE.SOLDIER);
    }

    // 自分の町（home）への方向・距離。
    const hcx = (h.home ? h.home.x : k.cities[0].x);
    const hcy = (h.home ? h.home.y : k.cities[0].y);
    const hdx = hcx + 0.5 - h.x, hdy = hcy + 0.5 - h.y;
    const hd2 = hdx * hdx + hdy * hdy;

    // 0.4) 火災回避（最優先・全員）: 近くに火があれば離れる方向へ逃げる。
    if (this._fireNear) {
      const fr = this._nearestFireTile(world, h.x | 0, h.y | 0, 4);
      if (fr) {
        const ax = h.x - (fr.x + 0.5), ay = h.y - (fr.y + 0.5);
        h.gx = Game.utils.clamp((h.x + ax * 1.6) | 0, 0, world.width - 1);
        h.gy = Game.utils.clamp((h.y + ay * 1.6) | 0, 0, world.height - 1);
        h.state = 8; return;
      }
    }

    // 0.45) 野生の捕食者への対応（脅威判断）: 武装者は狩り、丸腰は逃げる。
    {
      const cr = Game.state.creatures, ents = Game.state.entities;
      if (cr && ents && cr.nearestAnimal) {
        const pi = cr.nearestAnimal(h.x, h.y, Game.SPECIES.PREDATOR, sight); // 視野内の捕食者だけ知覚
        if (pi !== -1 && ents.alive[pi]) {
          const dx = ents.x[pi] - h.x, dy = ents.y[pi] - h.y, d2 = dx * dx + dy * dy;
          h.fear = Math.min(1, (h.fear || 0) + 1.2 / (1 + d2)); // 近い猛獣ほど強い恐怖
          const armed = h.role === ROLE.SOLDIER || (h.gear || 0) > 0;
          // 闘うか逃げるか: 勇気＝勇敢さ＋怒り−恐怖。安全志向(synSafe)が高いほど退きやすい。
          const courage = (h.brave || 1) + (h.anger || 0) * 0.5 - (h.fear || 0) * 0.9 - ((h.synSafe || 1) - 1) + (h.aspire === 1 ? 0.4 : 0); // 武功の志は怯まない
          if (armed && courage > 0.7) {
            if (d2 < 2.2) { ents.kill(pi); h.food = h.food + 0.3 > 1 ? 1 : h.food + 0.3; h.anger = Math.min(1, (h.anger || 0) + 0.3); } // 撃退・狩り
            else { h.gx = ents.x[pi] | 0; h.gy = ents.y[pi] | 0; h.state = 16; return; }
          } else {
            if (d2 < 2.5) h.food = h.food - 0.05 > 0 ? h.food - 0.05 : 0; // 襲われ負傷
            h.memDanger = { x: ents.x[pi] | 0, y: ents.y[pi] | 0, t: this._tickN }; // 危険地を記憶
            h.gx = Game.utils.clamp((h.x - dx * 1.4) | 0, 0, world.width - 1);
            h.gy = Game.utils.clamp((h.y - dy * 1.4) | 0, 0, world.height - 1);
            h.state = 8; return;
          }
        }
      }
    }

    // 0.5) 戦時の民間人は侵入してきた敵兵から逃げる（視野内で察知すると恐怖に駆られて逃げる）。
    if (h.role !== ROLE.SOLDIER && this._count(k.wars) > 0) {
      const foe = this._scan(h.x, h.y, sight * 1.2, function (o) {
        return (o.kid !== h.kid && o.kid !== 0 && o.role === ROLE.SOLDIER && self._atWar(h.kid, o.kid)) ? 2 : 0;
      }).best;
      if (foe) {
        h.fear = Math.min(1, (h.fear || 0) + 0.6);
        h.memDanger = { x: foe.x | 0, y: foe.y | 0, t: this._tickN }; // 戦火の地を記憶
        // 敵から離れる向き＋自国の町方向へ退避。
        const ax = h.x - foe.x, ay = h.y - foe.y;
        h.gx = Game.utils.clamp((h.x + ax + (hcx - h.x) * 0.3) | 0, 0, world.width - 1);
        h.gy = Game.utils.clamp((h.y + ay + (hcy - h.y) * 0.3) | 0, 0, world.height - 1);
        h.state = 8; return;
      }
    }

    // 0.7) 危険地の記憶（嫌悪学習）: 以前に襲われた/戦火に遭った場所の近くは、差し迫った
    //      飢えが無ければ避ける（不安を覚え遠ざかる）。時間が経てば記憶は薄れる。
    if (h.memDanger) {
      if (this._tickN - h.memDanger.t > CP.dangerTtl) h.memDanger = null;
      else if (h.food > 0.28) {
        const ddx = h.x - (h.memDanger.x + 0.5), ddy = h.y - (h.memDanger.y + 0.5);
        if (ddx * ddx + ddy * ddy < CP.dangerR * CP.dangerR) {
          h.fear = Math.min(1, (h.fear || 0) + 0.2);
          h.gx = Game.utils.clamp((h.x + ddx * 1.5) | 0, 0, world.width - 1);
          h.gy = Game.utils.clamp((h.y + ddy * 1.5) | 0, 0, world.height - 1);
          h.state = 8; return;
        }
      }
    }

    // 1) 空腹 → 記憶した食料地、無ければ視野内の可食地を探す（空間記憶＝賢い採食）。
    //    食欲シナプス(synFood)が強い人ほど早めに食料を求める。
    if (h.food < 0.4 * (h.synFood || 1)) {
      let t = null;
      if (h.memFood) {
        const mi = h.memFood.y * world.width + h.memFood.x;
        if (tile.isEdible(world.terrain[mi])) t = h.memFood; else h.memFood = null;
      }
      if (!t) {
        t = this._nearestTile(h, world, Math.round(sight), function (terr) { return tile.isEdible(terr); });
        if (t) h.memFood = { x: t.x, y: t.y };
      }
      if (t) { h.gx = t.x; h.gy = t.y; h.state = 1; return; }
    }
    // 1.2) 狩り: 開拓者・兵士は近くの野生動物を仕留めて食料にする（人と動物の関わり）。
    if ((h.role === ROLE.EXPLORER || h.role === ROLE.SOLDIER) && h.food < 0.75) {
      const cr = Game.state.creatures, ents = Game.state.entities;
      if (cr && ents && cr.nearestAnimal) {
        const prey = cr.nearestAnimal(h.x, h.y, Game.SPECIES.HERBIVORE, 5);
        if (prey !== -1 && ents.alive[prey]) {
          const dx = ents.x[prey] - h.x, dy = ents.y[prey] - h.y;
          if (dx * dx + dy * dy < 1.8) {
            ents.kill(prey);                       // 仕留めた
            h.food = h.food + 0.5 > 1 ? 1 : h.food + 0.5; // 肉で回復
            h.state = 16;
          } else {
            h.gx = ents.x[prey] | 0; h.gy = ents.y[prey] | 0; h.state = 16; return; // 追跡
          }
        }
      }
    }
    // 1.5) 夜は帰宅して休む（戦時の兵士は夜も戦う）。昼は働き夜は静まる生活リズムを作る。
    if (this._night && !(h.role === ROLE.SOLDIER && this._count(k.wars) > 0)) {
      if (hd2 > 9) { h.gx = hcx; h.gy = hcy; }            // 町へ帰る
      else { this._ringGoal(h, world, hcx, hcy, 0, 2); }  // 家の周りで休む
      h.state = 13; return;
    }
    // 2) 孤独 → 同胞のもとへ集まる。
    if (h.social > 1) {
      const soc = this._scan(h.x, h.y, CP.socialRadius, function (o) { return o.kid === h.kid ? 1 : 0; });
      if (soc.count >= CP.socialNeed) h.social = 0;
      else { h.gx = hcx; h.gy = hcy; h.state = 2; return; }
    }
    // 3) 行動範囲外 → 自分の町へ帰る（農民・建築家は狭く定住、開拓者・兵士は広く）。
    let tether = (h.role === ROLE.EXPLORER || h.role === ROLE.SOLDIER) ? CP.tether : CP.tetherSettled;
    if (h.aspire === 2) tether *= 1.3; else if (h.aspire === 4) tether *= 0.82; // 探求は広く、家族は近く
    if (hd2 > tether * tether) {
      h.gx = hcx; h.gy = hcy; h.state = 3; return;
    }

    // 4) 役割ごとの目的地・判断（各自ばらけた行動圏を巡回する）。
    if (h.role === ROLE.SOLDIER) {
      // 周囲の戦力を把握（味方=count, 敵=count2, 最寄りの交戦相手=best）。
      const scan = this._scan(h.x, h.y, 9, function (o) {
        if (o.role !== ROLE.SOLDIER || o.kid === 0) return 0;
        if (o.kid === h.kid) return 1;            // 味方兵
        return self._atWar(h.kid, o.kid) ? 2 : 0; // 交戦中の敵兵
      });
      const e = scan.best;
      h._enemy = e;
      if (e) { h.anger = Math.min(1, (h.anger || 0) + 0.35); h.fear = Math.min(1, (h.fear || 0) + 0.2); } // 戦意と恐怖
      // 士気: 局所的に大きく劣勢なら退却して味方と合流する（無謀な突撃を避ける）。
      // 勇敢で怒る兵ほど劣勢でも踏みとどまり、恐怖に駆られた兵は早く退く（感情が戦場を左右する）。
      const grit = 0.4 + 1.2 * (h.brave || 1) + 0.5 * (h.anger || 0) - 0.7 * (h.fear || 0);
      if (e && scan.count2 > scan.count + grit) {
        h.gx = hcx; h.gy = hcy; h.state = 14; return;
      }
      // 敵が見えれば交戦。
      if (e) { h.gx = e.x | 0; h.gy = e.y | 0; h.state = 5; return; }
      // 敵影が無ければ前線（交戦国の領土）へ前進する。
      const t = this._nearestTile(h, world, 7, function (terr, ow) {
        return ow !== 0 && ow !== h.kid && self._atWar(h.kid, ow);
      });
      if (t) { h.gx = t.x; h.gy = t.y; h.state = 5; return; }
      // 平時は領内を広く警邏（外周寄りを巡回）。
      this._ringGoal(h, world, hcx, hcy, CP.tether * 0.4, CP.tether);
      h.state = 5; return;
    }
    if (h.role === ROLE.EXPLORER) {
      this._maybeFoundTown(h, k); // 遠地で新集落
      const t = this._nearestTile(h, world, CP.seekRange + 1, function (terr, ow) { return ow === 0 && tile.isLand(terr); });
      if (t) { h.gx = t.x; h.gy = t.y; h.state = 4; return; }
      // 近くに未開の陸が無い → 海を越える植民を試みる（時代1以降・沿岸・確率）。
      // 航海術を持つ国は積極的に海へ進出する。
      const embChance = CP.embarkChance * (hasTech(k, "sail") ? 2 : 1);
      if (k.tech >= TECH_PER_ERA && this.rand() < embChance && this._coastal(world, h.x | 0, h.y | 0)) {
        const tgt = this._findOverseasLand(world, h.x | 0, h.y | 0);
        if (tgt) {
          h.sailing = true; h.sea = tgt; h.gx = tgt.x; h.gy = tgt.y; h.state = 15;
          this._embarks = (this._embarks || 0) + 1;
          this._logEvent(k.name + "の入植者が海へ船出した");
          return;
        }
      }
      this._ringGoal(h, world, hcx, hcy, 4, CP.tether); // 未開地が無ければ領内を広く移動
      h.state = 4; return;
    }
    if (h.role === ROLE.BUILDER) {
      // 町に居れば実際に建設・建て替え。遠地に出たら新集落を興す。
      if (hd2 < 36) {
        const city = this._cityAt(k, hcx, hcy);
        if (city) { this._construct(k, city, world); practice(h); h.prestige = (h.prestige || 0) + 0.06; } // 普請で腕と名を上げる
      } else {
        this._maybeFoundTown(h, k);
      }
      // 工事現場（町なか）をうろつく。
      this._ringGoal(h, world, hcx, hcy, 0, 5);
      h.state = 6; return;
    }
    // 専門職（鍛冶・商人・神官）: 対応する施設へ出勤して働く。職場のある町に定住する
    // （職場が遠い町に属していると行動範囲外で働けないため、職場へ住み替える）。
    if (h.role === ROLE.SMITH || h.role === ROLE.MERCHANT || h.role === ROLE.PRIEST) {
      const ftype = h.role === ROLE.SMITH ? BUILDING.SMITHY
        : h.role === ROLE.MERCHANT ? BUILDING.MARKET : BUILDING.TEMPLE;
      if (!h.work || this.rand() < 0.03) h.work = this._nearestFacility(k, h.x, h.y, ftype);
      if (h.work) {
        h.home = { x: h.work.x, y: h.work.y }; // 職場の都市に通勤定住
        if (this.rand() < 0.7) { h.gx = h.work.x; h.gy = h.work.y; } // 出勤
        else { this._ringGoal(h, world, h.work.x, h.work.y, 0, 4); }  // 職場周辺
      } else {
        // 職場がまだ無ければ町なかで待機（やがて建築家が施設を建てる）。
        this._ringGoal(h, world, hcx, hcy, 0, 5);
      }
      h.state = 12; return;
    }
    // FARMER（既定）: 町の周りに自分の畑を持ち、出勤して耕し、たまに帰宅する（職住近接）。
    // 賢い農夫は数か所を見比べて最も肥沃な土地を選ぶ（知性→食料生産の質）。
    if (!h.farm) {
      const samples = world.fertility ? (1 + Math.round(wit * 2)) : 1; // wit~1で約3か所
      let bx = 0, by = 0, bf = -1;
      for (let s = 0; s < samples; s++) {
        const ang = this.rand() * Math.PI * 2;
        const dr = 3 + this.rand() * (CP.tetherSettled - 3);
        const fx = Game.utils.clamp((hcx + Math.cos(ang) * dr) | 0, 0, world.width - 1);
        const fy = Game.utils.clamp((hcy + Math.sin(ang) * dr) | 0, 0, world.height - 1);
        const f = world.fertility ? world.fertility[fy * world.width + fx] : 0;
        if (f > bf) { bf = f; bx = fx; by = fy; }
      }
      h.farm = { x: bx, y: by };
    }
    if (this.rand() < 0.25) { h.gx = hcx; h.gy = hcy; } // 帰宅
    else { h.gx = h.farm.x; h.gy = h.farm.y; }          // 畑へ出勤
    h.state = 7;
  };

  // (x,y) が海に接する沿岸タイルか（4近傍に水）。
  CivSystem.prototype._coastal = function (world, x, y) {
    const W = world.width, H = world.height, terr = world.terrain;
    if (x > 0 && tile.isWater(terr[y * W + x - 1])) return true;
    if (x < W - 1 && tile.isWater(terr[y * W + x + 1])) return true;
    if (y > 0 && tile.isWater(terr[(y - 1) * W + x])) return true;
    if (y < H - 1 && tile.isWater(terr[(y + 1) * W + x])) return true;
    return false;
  };

  // 海を隔てた未開の陸地を探す。中点が海であること（=海路で渡る）を条件に、
  // minSailGap〜maxSailRange の範囲でランダム方向に走査して最初の候補を返す。
  CivSystem.prototype._findOverseasLand = function (world, x, y) {
    const W = world.width, H = world.height, terr = world.terrain, owner = world.owner;
    const minR = CP.minSailGap, maxR = CP.maxSailRange;
    // 8方向を起点ランダムで一巡。各方向に外側へ伸ばし、海を越えた先の未開地を探す。
    const start = (this.rand() * 8) | 0;
    for (let s = 0; s < 8; s++) {
      const a = ((start + s) % 8) * (Math.PI / 4);
      const cx = Math.cos(a), cy = Math.sin(a);
      let crossedWater = false;
      for (let r = 2; r <= maxR; r++) {
        const nx = (x + cx * r) | 0, ny = (y + cy * r) | 0;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
        const i = ny * W + nx;
        if (tile.isWater(terr[i])) { crossedWater = true; continue; }
        // 陸に到達。海を越えており、未開（無所属）かつ十分遠ければ植民先。
        if (crossedWater && r >= minR && owner[i] === 0 && tile.isLand(terr[i])) {
          return { x: nx, y: ny };
        }
        // 海を越える前に陸（地続き）に当たったら、その方向は不可。
        if (!crossedWater) break;
      }
    }
    return null;
  };

  // 航海中の入植者の1ティック: 目的地へ水上を直進し、上陸して植民する。
  CivSystem.prototype._tickSail = function (h, world) {
    h.age++;
    h.food -= CP.sailMetab;
    const tx = h.sea.x + 0.5, ty = h.sea.y + 0.5;
    const dx = tx - h.x, dy = ty - h.y;
    const d = Math.hypot(dx, dy);
    if (d < 1.3) { this._landColony(h); return; }
    const sp = CP.sailSpeed;
    h.x += dx / d * sp; h.y += dy / d * sp;
    h.hx = dx / d * sp; h.hy = dy / d * sp;
    if (h.food <= 0 || h.age > CP.maxAge) h.alive = false; // 海難（行方不明）
  };

  // 上陸して植民地（新王国）を興す。母国の宗教・技術を引き継ぐ。
  CivSystem.prototype._landColony = function (h) {
    const k0 = this.kingdoms[h.kid];
    const tx = h.sea ? h.sea.x : (h.x | 0), ty = h.sea ? h.sea.y : (h.y | 0);
    h.sailing = false; h.sea = null;
    h.x = tx + 0.5; h.y = ty + 0.5;
    const nk = this._newKingdom(tx, ty);
    // 入植者を母国から外す。
    if (k0 && k0.alive) { k0.humanCount--; k0.roleCount[h.role]--; }
    if (nk) {
      if (k0) {
        nk.religion = k0.religion; nk.tech = k0.tech * 0.6;
        // 言語: 植民地は母国の言葉を受け継ぐ（入植者の言葉）。海を隔てた孤立で、時に
        //   早くから独自の言語へ大きく分岐する（独自進化）。以後は子孫がこれを継ぐ。
        if (h.lx != null && this.rand() < CP.langSplit) {
          h.lx = clamp01(h.lx + (this.rand() - 0.5) * 2 * CP.langSplitAmt);
          h.ly = clamp01(h.ly + (this.rand() - 0.5) * 2 * CP.langSplitAmt);
        }
        nk.langX = h.lx == null ? k0.langX : h.lx; nk.langY = h.ly == null ? k0.langY : h.ly;
      }
      h.kid = nk.id; h.clan = ++nk.clanSeq; h.role = ROLE.EXPLORER;
      h.home = { x: tx, y: ty }; h.farm = null; h.work = null;
      nk.humanCount++; nk.roleCount[h.role]++;
      this._colonies = (this._colonies || 0) + 1;
      this._logEvent(nk.name + " が海の彼方に建国した" + (k0 ? "（" + k0.name + "の植民地）" : ""));
    } else {
      // 上陸地が既に所有/不適 → 放浪者になる。
      h.kid = 0; h.clan = 0; h.role = ROLE.EXPLORER; h.home = null; h.farm = null; h.work = null;
    }
  };

  // (x,y) に一致する k の都市オブジェクトを返す。
  CivSystem.prototype._cityAt = function (k, x, y) {
    for (let c = 0; c < k.cities.length; c++) {
      if (k.cities[c].x === x && k.cities[c].y === y) return k.cities[c];
    }
    return k.cities[0];
  };

  // 建築家が都市で建設/建て替えを行う（人間が街を作る）。
  // 住居だけでなく、時代と都市の必要に応じて農場・鍛冶場・市場・兵舎・神殿・穀倉を
  // バランスよく建て、人々の職場と国の機能を生み出す。
  CivSystem.prototype._construct = function (k, city, world) {
    if (!city.buildings) city.buildings = [];
    const bs = city.buildings;

    // 大記念碑（ワンダー）: 発展した大国が首都に建立する誇りの大建造物（稀）。
    // 上限とは別枠で、満杯の首都でも建てられるよう最優先で判定する。
    if (city.capital && (k.tech / TECH_PER_ERA | 0) >= 2 && k.wealth > 400 && k.humanCount > 45 &&
        this.rand() < 0.04) {
      let hasWonder = false;
      for (let i = 0; i < bs.length; i++) if (bs[i].t === BUILDING.WONDER) { hasWonder = true; break; }
      if (!hasWonder) {
        const spot = this._buildSpot(world, k, city);
        if (spot) {
          bs.push({ x: spot.x, y: spot.y, t: BUILDING.WONDER });
          this._logEvent("🏛 " + k.name + " が大記念碑を建立した");
          return;
        }
      }
    }

    // 上限に達したら建て替え（時代遅れの住居を更新）のみ。
    if (bs.length >= MAX_BUILDINGS) { this._rebuild(k, city); return; }
    // 建設は緩やかに進める。建てない番は古い住居の更新に充てる。
    if (this.rand() > 0.2) { this._rebuild(k, city); return; }

    const tier = dwellingTier(k.tech);
    // 現在の構成を数える。
    let dwell = 0; const has = {};
    for (let i = 0; i < bs.length; i++) {
      const t = bs[i].t;
      if (t === BUILDING.HUT || t === BUILDING.HOUSE || t === BUILDING.MANOR) dwell++;
      has[t] = (has[t] || 0) + 1;
    }

    // 鉱山: 領内に未採掘の鉱石があれば、そのタイルに鉱山を建てて採掘する。
    if (!has[BUILDING.MINE] && bs.length >= 2) {
      const ore = this._oreSpotNear(world, k, city);
      if (ore) {
        bs.push({ x: ore.x, y: ore.y, t: BUILDING.MINE });
        city.level = 1 + ((bs.length / 3) | 0);
        return;
      }
    }

    // 必要な建物を優先順位で選ぶ。基幹施設（工房・倉・市・兵舎）は原始的な形で早期から
    // 建ち、産物は技術で増える。神殿は社会が成熟してから。最後は住居で人口増に対応。
    const n = bs.length;
    let want;
    const coastal = this._coastal(world, city.x, city.y); // 沿岸都市か（港を建てられる）
    if (!has[BUILDING.FARM] && n >= 1) want = BUILDING.FARM;               // まず食料生産
    else if (dwell < 2) want = tier;                                       // 最低限の住居
    else if (coastal && !has[BUILDING.HARBOR] && n >= 3) want = BUILDING.HARBOR; // 港（沿岸の漁・海上交易）
    else if (!has[BUILDING.SMITHY] && n >= 3) want = BUILDING.SMITHY;      // 工房（道具・武具）
    else if (!has[BUILDING.GRANARY] && n >= 4) want = BUILDING.GRANARY;    // 倉（食料安全）
    else if (!has[BUILDING.MARKET] && n >= 4) want = BUILDING.MARKET;      // 市（富）
    else if ((this._count(k.wars) > 0 || city.capital) && !has[BUILDING.BARRACKS] && n >= 5) want = BUILDING.BARRACKS; // 兵舎
    else if (!has[BUILDING.TAVERN] && n >= 6) want = BUILDING.TAVERN;      // 酒場（娯楽・士気）
    else if (!has[BUILDING.TEMPLE] && n >= 7) want = BUILDING.TEMPLE;      // 神殿（信仰・成熟した都市）
    else if (!has[BUILDING.ACADEMY] && n >= 9 && k.tech >= TECH_PER_ERA) want = BUILDING.ACADEMY; // 学院（技術・進んだ都市）
    else if (dwell < Math.max(3, n * 0.5)) want = tier;                   // 人口に見合う住居
    else if ((has[BUILDING.SMITHY] || 0) < 2 && n >= 12) want = BUILDING.SMITHY;    // 大都市は2軒目
    else if ((has[BUILDING.MARKET] || 0) < 2 && n >= 14) want = BUILDING.MARKET;
    else want = tier;                                                      // さらに住居を増やす

    const spot = this._buildSpot(world, k, city);
    if (spot) {
      bs.push({ x: spot.x, y: spot.y, t: want });
      city.level = 1 + ((bs.length / 3) | 0);
    }
  };

  // 時代遅れの住居を現代の様式へ建て替える（古いものは建て替える）。
  CivSystem.prototype._rebuild = function (k, city) {
    if (this.rand() > 0.12) return;
    const tier = dwellingTier(k.tech);
    const bs = city.buildings;
    for (let i = 0; i < bs.length; i++) {
      const t = bs[i].t;
      if ((t === BUILDING.HUT || t === BUILDING.HOUSE || t === BUILDING.MANOR) && t < tier) { bs[i].t = tier; return; }
    }
  };

  // 都市の近くにある、自国領の未採掘の鉱石タイルを探す（鉱山の建設地）。
  CivSystem.prototype._oreSpotNear = function (world, k, city) {
    if (!world.resource) return null;
    const W = world.width, H = world.height, owner = world.owner, res = world.resource;
    const R = 7;
    const cx = city.x, cy = city.y;
    let bx = -1, by = -1, bd = 1e9;
    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy; if (y < 0 || y >= H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx; if (x < 0 || x >= W) continue;
        const i = y * W + x;
        if (res[i] !== Game.RESOURCE.ORE || owner[i] !== k.id) continue;
        let occupied = false;
        const bs = city.buildings;
        for (let bi = 0; bi < bs.length; bi++) { if (bs[bi].x === x && bs[bi].y === y) { occupied = true; break; } }
        if (occupied) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bx = x; by = y; }
      }
    }
    return bx < 0 ? null : { x: bx, y: by };
  };

  // 都市の近くで建設可能な空きタイル（自国の陸地・建物が未設置）を探す。
  CivSystem.prototype._buildSpot = function (world, k, city) {
    const W = world.width, H = world.height, owner = world.owner;
    for (let r = 1; r <= 4; r++) {
      for (let tries = 0; tries < 6; tries++) {
        const ang = this.rand() * Math.PI * 2;
        const x = (city.x + Math.cos(ang) * r) | 0;
        const y = (city.y + Math.sin(ang) * r) | 0;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (owner[i] !== k.id || !tile.isLand(world.terrain[i])) continue;
        let occupied = false;
        for (let bi = 0; bi < city.buildings.length; bi++) {
          if (city.buildings[bi].x === x && city.buildings[bi].y === y) { occupied = true; break; }
        }
        if (!occupied) return { x: x, y: y };
      }
    }
    return null;
  };

  // (cx,cy) を中心とした [minR,maxR] のリング内のランダムな点を目標にする。
  // 役割ごとの行動圏に人々を散らし、絶えず動かすためのもの。
  CivSystem.prototype._ringGoal = function (h, world, cx, cy, minR, maxR) {
    const ang = this.rand() * Math.PI * 2;
    const dist = minR + this.rand() * (maxR - minR);
    h.gx = Game.utils.clamp((cx + Math.cos(ang) * dist) | 0, 0, world.width - 1);
    h.gy = Game.utils.clamp((cy + Math.sin(ang) * dist) | 0, 0, world.height - 1);
  };

  // 半径 r 内で pred(terrain, owner) を満たす最寄りタイル（無ければ null）。
  CivSystem.prototype._nearestTile = function (h, world, r, pred) {
    const W = world.width, H = world.height;
    const cx = h.x | 0, cy = h.y | 0;
    let bx = -1, by = -1, bd = 1e9;
    for (let dy = -r; dy <= r; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const nx = cx + dx;
        if (nx < 0 || nx >= W) continue;
        const ni = ny * W + nx;
        if (pred(world.terrain[ni], world.owner[ni])) {
          const d = dx * dx + dy * dy;
          if (d > 0 && d < bd) { bd = d; bx = nx; by = ny; }
        }
      }
    }
    return bx < 0 ? null : { x: bx, y: by };
  };

  CivSystem.prototype._tryReproduce = function (h, k) {
    if (h.age < CP.adultAge || h.age > CP.elderAge) return;
    if (h.food < CP.reproFood || h.repro > 0) return;
    if (k.famine) return; // 飢饉中は子をもうけない
    const capacity = this._capacity(k);
    if (k.humanCount >= capacity) return;
    if (this.people.length + this._births.length >= Game.config.sim.maxPeople) return;
    // パートナー選び: 伴侶が近くにいて適齢なら添い遂げる（家族の継続）。
    // いなければ新たな伴侶を選ぶ。近親婚は避け（incest taboo）、別の血統＝外婚を好み、
    // 健やかで威信ある相手を選ぶ（配偶者選択＝性淘汰）。
    let partner = null;
    const sp = h.partner;
    if (sp && sp.alive && sp.kid === h.kid && sp.age >= CP.adultAge && sp.age <= CP.elderAge &&
        sp.food >= CP.reproFood && sp.repro <= 0) {
      const dx = sp.x - h.x, dy = sp.y - h.y;
      if (dx * dx + dy * dy <= CP.reproRadius * CP.reproRadius) partner = sp;
    }
    if (!partner) {
      const eligible = function (o) {
        return o.kid === h.kid && o !== h && o.age >= CP.adultAge && o.age <= CP.elderAge &&
          o.food >= CP.reproFood && o.repro <= 0 && !closeKin(h, o);
      };
      // ①独身・別血統・健康で素質のある相手（外婚＋性淘汰）。
      partner = this._scan(h.x, h.y, CP.reproRadius, function (o) {
        return (eligible(o) && !o.partner && o.clan !== h.clan && o.food > 0.65 && (o.vigor || 1) >= 1.0) ? 2 : 0;
      }).best;
      // ②独身・別血統。
      if (!partner) partner = this._scan(h.x, h.y, CP.reproRadius, function (o) {
        return (eligible(o) && !o.partner && o.clan !== h.clan) ? 2 : 0;
      }).best;
      // ③独身（同血統でも可。近親は除く）。
      if (!partner) partner = this._scan(h.x, h.y, CP.reproRadius, function (o) {
        return (eligible(o) && !o.partner) ? 2 : 0;
      }).best;
      // ④既婚でも近親でない相手（小集団での最後の手段。近親婚だけは避ける）。
      if (!partner) partner = this._scan(h.x, h.y, CP.reproRadius, function (o) {
        return eligible(o) ? 2 : 0;
      }).best;
    }
    if (!partner) return;
    h.repro = CP.reproCooldown; partner.repro = CP.reproCooldown;
    h.food -= CP.reproCost; partner.food -= CP.reproCost;
    this._bond(h, partner); // 伴侶として結ばれる
    const child = this._spawnHuman(k, h.x, h.y, h.clan, this._assignRole(k), 0.7, h, partner);
    if (child) this._births.push(child);
  };

  CivSystem.prototype._move = function (h, k, world) {
    const W = world.width, H = world.height;
    // 操舵の間引き: 多くのティックは前回の速度(hx,hy)でそのまま前進し（移動は毎ティック
    //   滑らか）、経路・慣性・障害回避の再計算は steerEvery ティックに1回だけ行う。
    //   進路が水/外なら位相に関わらず即座に再操舵する（水侵入を防ぐ）。
    if (((this._tickN + (h.pid || 0)) % CP.steerEvery) !== 0 && (h.hx || h.hy)) {
      let nxp = h.x + h.hx, nyp = h.y + h.hy;
      if (nxp < 0) nxp = 0; else if (nxp > W - 1) nxp = W - 1;
      if (nyp < 0) nyp = 0; else if (nyp > H - 1) nyp = H - 1;
      const ni = (nyp | 0) * W + (nxp | 0);
      const fr = Game.state.fire, bn = (fr && fr.burn) ? fr.burn : null;
      if (tile.isLand(world.terrain[ni]) && !(bn && bn[ni] > 0)) { h.x = nxp; h.y = nyp; return; }
      // 進路が塞がれている → 下の通常処理で再操舵する。
    }
    let dux = h.gx + 0.5 - h.x;
    let duy = h.gy + 0.5 - h.y;
    const dist = Math.sqrt(dux * dux + duy * duy);
    let speed = CP.speed;
    // 街道の上では速く移動できる（交通インフラの効果）。
    if (world.road && world.road[(h.y | 0) * W + (h.x | 0)]) speed *= 1.5;
    if (dist < 0.6) {
      // 目標到達 → 直前の向きを保ちつつ緩やかに彷徨う（カクつき防止）。
      dux = (h.hx || 0) * 6 + (this.rand() - 0.5) * 0.5;
      duy = (h.hy || 0) * 6 + (this.rand() - 0.5) * 0.5;
      speed *= 0.45;
    } else {
      dux /= dist; duy /= dist;
    }
    // 慣性: 直前の進行方向と混ぜて滑らかに曲がる。
    const hx0 = h.hx || 0, hy0 = h.hy || 0;
    const pl = Math.sqrt(hx0 * hx0 + hy0 * hy0);
    const pux = pl > 1e-4 ? h.hx / pl : dux;
    const puy = pl > 1e-4 ? h.hy / pl : duy;
    let bx = pux * 0.55 + dux * 0.45;
    let by = puy * 0.55 + duy * 0.45;
    const bl = Math.sqrt(bx * bx + by * by) || 1;
    const bnx = bx / bl, bny = by / bl; // 正規化した進行方向
    const terr = world.terrain;
    const fire = Game.state.fire, burn = (fire && fire.burn) ? fire.burn : null;
    let moved = false;
    // 速い経路: まず直進を試す（多くの場合これで通る）。三角関数を使わず方向ベクトルで進む。
    {
      const sxv = bnx * speed, syv = bny * speed;
      const nxp = h.x + sxv, nyp = h.y + syv;
      const ntx = nxp < 0 ? 0 : nxp >= W ? W - 1 : nxp | 0;
      const nty = nyp < 0 ? 0 : nyp >= H ? H - 1 : nyp | 0;
      const ni = nty * W + ntx;
      if (tile.isLand(terr[ni]) && !(burn && burn[ni] > 0)) {
        h.hx = sxv; h.hy = syv; h.x = nxp; h.y = nyp; moved = true;
      }
    }
    // 直進が塞がれている時だけ、向きを振って障害物を回り込む（±約35°→±約70°）。
    if (!moved) {
      const baseAng = Math.atan2(by, bx);
      const OFF = [0.6, -0.6, 1.2, -1.2, 1.9, -1.9];
      for (let di = 0; di < OFF.length; di++) {
        const ang = baseAng + OFF[di];
        const sxv = Math.cos(ang) * speed, syv = Math.sin(ang) * speed;
        const nxp = h.x + sxv, nyp = h.y + syv;
        const ntx = nxp < 0 ? 0 : nxp >= W ? W - 1 : nxp | 0;
        const nty = nyp < 0 ? 0 : nyp >= H ? H - 1 : nyp | 0;
        const ni = nty * W + ntx;
        if (tile.isLand(terr[ni]) && !(burn && burn[ni] > 0)) {
          h.hx = sxv; h.hy = syv; h.x = nxp; h.y = nyp; moved = true; break;
        }
      }
    }
    if (!moved) { h.hx *= -0.4; h.hy *= -0.4; } // 完全に囲まれたら減衰
  };

  // タイル index が燃えているか（火災回避用）。
  CivSystem.prototype._onFire = function (world, i) {
    const fire = Game.state.fire;
    return !!(fire && fire.burn && fire.burn[i] > 0);
  };

  // (cx,cy) 半径 r 内で最も近い燃焼タイルを返す（無ければ null）。
  CivSystem.prototype._nearestFireTile = function (world, cx, cy, r) {
    const fire = Game.state.fire;
    if (!fire || !fire.burn) return null;
    const W = world.width, H = world.height, burn = fire.burn;
    let bx = -1, by = -1, bd = 1e9;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy; if (y < 0 || y >= H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx; if (x < 0 || x >= W) continue;
        if (burn[y * W + x] > 0) { const d = dx * dx + dy * dy; if (d < bd) { bd = d; bx = x; by = y; } }
      }
    }
    return bx < 0 ? null : { x: bx, y: by };
  };

  // 火災が集落に達したときの建物被害: 延焼中・焼け跡(SCORCHED)のタイルに建つ建物が失われる。
  // 都市ごとに評価時のみ走査する（建物数は都市あたり最大26で軽い）。砦(KEEP)は残す。
  CivSystem.prototype._fireDamageBuildings = function (k, world) {
    const burn = (Game.state.fire && Game.state.fire.burn) ? Game.state.fire.burn : null;
    const W = world.width, SC = Game.TERRAIN.SCORCHED;
    let lost = 0;
    for (let c = 0; c < k.cities.length; c++) {
      const bs = k.cities[c].buildings;
      if (!bs) continue;
      for (let b = bs.length - 1; b >= 0; b--) {
        const bd = bs[b];
        if (bd.t === BUILDING.KEEP) continue; // 砦は焼け残る（都市の核）
        const ti = bd.y * W + bd.x;
        const ablaze = (burn && burn[ti] > 0) || world.terrain[ti] === SC;
        if (ablaze && this.rand() < CP.fireBuildBurn) { bs.splice(b, 1); lost++; }
      }
    }
    if (lost > 0) {
      k.unrest = Math.min(100, (k.unrest || 0) + lost * 1.5);
      this._logEvent("🔥 " + k.name + " で火災により建物 " + lost + " 棟が焼失した");
    }
  };

  // 施設で就労中（職場座標に十分近い）か。
  CivSystem.prototype._atWork = function (h) {
    if (!h.work) return false;
    const dx = h.work.x + 0.5 - h.x, dy = h.work.y + 0.5 - h.y;
    return dx * dx + dy * dy < CP.workRadius * CP.workRadius;
  };

  // 支給する装備の段階。国が作れる段階(craftTier)を基準に、工芸力が高いほど稀に
  //   業物（一段上の傑作）を打つ（名工の業）。金属が無い国は石器どまり。
  CivSystem.prototype._equipTier = function (k) {
    let t = craftTier(k);
    // 業物は金属を扱える国でのみ（石器のままでは傑作にならない）。
    if (t >= 2 && this.rand() < (k.craft || 0) * CP.masterwork) t = Math.min(6, t + 1);
    return t;
  };
  // 工芸の概況（UI 用）: 工芸力・標準の装備段階とその名。
  CivSystem.prototype.gearName = function (t) { return gearName(t); };
  CivSystem.prototype.aspireName = function (i) { return ASPIRE_NAMES[i] || "立身"; };
  CivSystem.prototype.craftInfo = function (k) {
    const t = craftTier(k);
    const ore = !!((k.res && k.res.ore > 0) || (k.facilities && k.facilities.mine > 0));
    return { level: k.craft || 0, tier: t, name: gearName(t), ore: ore, fuel: k.fuel || 0 };
  };

  // 役割の局所効果（毎ティックだが探索なし＝低負荷）。ti は足下のタイル index。
  CivSystem.prototype._roleTick = function (h, k, world, ti) {
    if (h.role === ROLE.FARMER) {
      // 耕作: 道具があるほど、また腕の良い（勤勉・熟練・壮年・上機嫌な）農夫ほど効率よく耕す。
      if (world.fertility && tile.isLand(world.terrain[ti])) {
        const f = world.fertility[ti] + CP.cultivate * (1 + (h.gear || 0) * 0.15) * ability(h);
        world.fertility[ti] = f > 1 ? 1 : f;
        practice(h); // 耕すたびに腕が上がる
      }
      // 道具の支給（在庫があれば）。
      if (!h.gear && this.rand() < CP.equipChance) h.gear = this._equipTier(k);
      return;
    }
    // 鍛冶: 鍛冶場で道具・武具を生産する（人口を上限に飽和）。熟練の職人ほど多く打つ。
    if (h.role === ROLE.SMITH) {
      if (this._atWork(h)) {
        if (k.tools < k.humanCount) k.tools += CP.toolRate * (1 + k.tech * 0.002) * ability(h);
        if (!h.gear) h.gear = this._equipTier(k);
        practice(h);
      }
      return;
    }
    // 商人: 市場で富を生む。商才ある熟練の商人ほど稼ぐ。
    if (h.role === ROLE.MERCHANT) {
      if (this._atWork(h)) {
        k.wealth += CP.marketRate * this._eff(k, "trade") * ability(h);
        if (!h.gear) h.gear = this._equipTier(k);
        practice(h);
      }
      return;
    }
    // 神官: 神殿で不満を鎮める。徳の高い熟練の神官ほど人心を安んじる。
    if (h.role === ROLE.PRIEST) {
      if (this._atWork(h)) {
        if (k.unrest > 0) k.unrest = Math.max(0, k.unrest - CP.templeCalm * this._eff(k, "faith") * ability(h));
        if (!h.gear) h.gear = this._equipTier(k);
        practice(h);
      }
      return;
    }
    if (h.role === ROLE.SOLDIER) {
      // 武具の支給（在庫があれば）。
      if (!h.gear && this.rand() < CP.equipChance) h.gear = this._equipTier(k);
      // 思考時にキャッシュした敵が隣接していれば交戦（探索不要）。
      const e = h._enemy;
      if (e && e.alive && this._atWar(h.kid, e.kid)) {
        const dx = e.x - h.x, dy = e.y - h.y;
        if (dx * dx + dy * dy < 2.25) {
          // 戦闘: 軍事力で勝る側ほど、また武装が良いほど大きな損害を与える。0 で戦死。
          const other = this.kingdoms[e.kid];
          const m1 = this._military(k), m2 = other ? this._military(other) : 1;
          const edge = m1 / (m1 + m2);
          // 地形と郷土の利: 守備兵が丘・山・森・湿地、または自国領で戦うと被害が減る（戦術）。
          const eti = (e.y | 0) * world.width + (e.x | 0);
          const dt = world.terrain[eti], TT = Game.TERRAIN;
          let defF = 1;
          if (dt === TT.HILL || dt === TT.MOUNTAIN) defF -= 0.25;
          else if (dt === TT.FOREST || dt === TT.JUNGLE || dt === TT.SWAMP) defF -= 0.15;
          if (world.owner[eti] === e.kid) defF -= CP.homeDefense * 0.3; // 郷土防衛の士気
          if (defF < 0.4) defF = 0.4;
          // 個の武勇: 勇敢で歴戦（高練度）の壮年兵ほど、また怒りに燃えるほど痛打を与える。
          e.food -= CP.attack * (0.6 + edge) * (1 + (h.gear || 0) * 0.12) *
            (0.55 + 0.45 * ability(h, "brave")) * (1 + 0.3 * (h.anger || 0)) * defF;
          practice(h); // 実戦で武を磨く
          if (e.food <= 0) { e.food = 0; e.alive = false; this._addMark(e.x, e.y); h.prestige = (h.prestige || 0) + 1.2; } // 戦死させ武功を上げる
        }
      } else {
        h._enemy = null;
      }
      // 征服: 足下が交戦国の前線タイルのときだけ奪う（探索は隣接4のみ）。
      const o = world.owner[ti];
      if (o !== 0 && o !== h.kid && this._atWar(h.kid, o)) {
        const other = this.kingdoms[o];
        if (other && other.alive) {
          const tx = h.x | 0, ty = h.y | 0;
          // 征服成功率は相対的な軍事力で決まる（強国が前線を押す）。
          // 防御に有利な地形（丘・森・密林・湿地）は奪いにくい（地形の戦術効果）。
          const m1 = this._military(k), m2 = this._military(other);
          const T = Game.TERRAIN, dter = world.terrain[ti];
          let defMul = (dter === T.HILL || dter === T.FOREST) ? 0.55
            : (dter === T.JUNGLE || dter === T.SWAMP) ? 0.7 : 1;
          // 防備: 砦(KEEP)を備えた都市タイルは攻めにくい（城壁＝包囲戦の抵抗）。
          for (let c = 0; c < other.cities.length; c++) {
            const cc = other.cities[c];
            if (cc.x === tx && cc.y === ty) {
              if (cc.buildings) { for (let bi = 0; bi < cc.buildings.length; bi++) if (cc.buildings[bi].t === BUILDING.KEEP) { defMul *= (1 - CP.fortDefense); break; } }
              break;
            }
          }
          const chance = CP.conflictChance * 2 * (m1 / (m1 + m2)) * defMul;
          if (this._adjacentOwner(world, tx, ty, h.kid) && this.rand() < chance) {
            world.owner[ti] = h.kid; k.tileCount++; other.tileCount--;
            if (this.renderer) this.renderer.markTerritoryDirty(tx, ty);
            // 都市の攻略: 足下に敵都市があれば占領（自国の都市になる）。
            for (let c = 0; c < other.cities.length; c++) {
              if (other.cities[c].x === tx && other.cities[c].y === ty) {
                const captured = other.cities[c];
                const wasCapital = c === 0;
                other.cities.splice(c, 1);
                captured.capital = false;
                k.cities.push(captured);
                this._fuse(k, other); // 占領した都市の文明（技術・信仰）を取り込む（融合）
                if (other.cities.length === 0) {
                  other.alive = false; // 最後の都市を失い国家崩壊
                  this._logEvent("☠ " + other.name + " が " + k.name + " に征服された");
                } else if (wasCapital) {
                  other.cities[0].capital = true; // 遷都
                }
                break;
              }
            }
            if (other.alive && other.tileCount <= 0) { other.alive = false; this._logEvent("☠ " + other.name + " が滅亡した"); }
          }
        }
      }
    }
  };

  CivSystem.prototype._maybeFoundTown = function (h, k) {
    if (k.cities.length >= CP.maxSettlements) return;
    const home = this._home(h, k);
    if (home.d2 < CP.newTownDist * CP.newTownDist) return;
    const world = this.world;
    const i = (h.y | 0) * world.width + (h.x | 0);
    const fertile = !world.fertility || world.fertility[i] > 0.3;
    if (world.owner[i] === k.id && fertile && this.rand() < CP.foundRate * this._eff(k, "expand")) {
      k.cities.push({ x: h.x | 0, y: h.y | 0, capital: false, level: 1, buildings: [] });
    }
  };

  Game.CivSystem = CivSystem;
  Game.ROLE = ROLE;
  // 描画の年齢段階（子供/老人）と一致させるための閾値。
  Game.lifeStages = { adult: CP.adultAge, elder: CP.elderAge };
})(window.Game);
