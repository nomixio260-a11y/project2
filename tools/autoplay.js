// 自動プレイ（オートプレイ）。Puppeteer で実ゲームをヘッドレス起動し、世界に文明と野生を
// 芽吹かせ、数千ティック「遊ばせ」て、その移り変わりをタイムラプス画像・年代記・統計として
// 書き出す。GitHub Actions から呼ばれ、結果を Pages のギャラリー／成果物／ジョブ要約にする。
//
//   node tools/autoplay.js            # 既定設定で実行
//   AUTOPLAY_TICKS=12000 AUTOPLAY_FRAMES=24 AUTOPLAY_SIZE=420 node tools/autoplay.js
//
// 出力: playthrough/frameNN.png（コマ）, index.html（スライドショー）,
//       chronicle.md（年代記）, stats.json（統計の推移）
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "playthrough");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const TICKS = parseInt(process.env.AUTOPLAY_TICKS || "9000", 10);
const FRAMES = parseInt(process.env.AUTOPLAY_FRAMES || "18", 10);
const SIZE = parseInt(process.env.AUTOPLAY_SIZE || "384", 10);
const KINGDOMS = parseInt(process.env.AUTOPLAY_KINGDOMS || "16", 10);
const HERBIVORES = parseInt(process.env.AUTOPLAY_HERBIVORES || "600", 10);
const PREDATORS = parseInt(process.env.AUTOPLAY_PREDATORS || "60", 10);

function log(...a) { console.log("[autoplay]", ...a); }

async function main() {
  const puppeteer = require("puppeteer");

  // 静的サーバ（テストと同じ簡易版）。
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseURL = "http://127.0.0.1:" + server.address().port + "/";
  log("server", baseURL);

  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));

  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.Game && Game.state && Game.state.world", { timeout: 20000 });
  log("booted");

  // 世界を整える: 手頃な大きさで再生成し、文明と野生を芽吹かせ、全景を映す。
  const setup = await page.evaluate((cfgIn) => {
    const Game = window.Game;
    // 観賞しやすい大きさへ作り替える（端末既定より小さく＝CI で軽快に動く）。
    Game.config.mapWidth = cfgIn.size;
    Game.config.mapHeight = cfgIn.size;
    Game.regenerate();
    Game.setPaused(true); // 描画ループに任意でティックさせず、こちらで決定的に進める。

    const w = Game.state.world, civ = Game.state.civ, ent = Game.state.entities;
    const W = w.width, H = w.height;
    // 文明を建国（適地に分散）。
    let founded = 0;
    for (let a = 0; a < 30000 && founded < cfgIn.kingdoms; a++) {
      const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
      if (Game.tile.isLand(w.terrain[y * W + x]) && civ.foundAt(x, y) > 0) founded++;
    }
    // 野生を放つ（草食・肉食）。
    const rg = () => 0.8 + Math.random() * 0.4;
    let herb = 0, pred = 0;
    for (let a = 0; a < 60000 && herb < cfgIn.herb; a++) {
      const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
      if (Game.tile.isEdible(w.terrain[y * W + x])) { ent.spawn(Game.SPECIES.HERBIVORE, x + 0.5, y + 0.5, 0.8, rg(), rg(), rg(), rg()); herb++; }
    }
    for (let a = 0; a < 60000 && pred < cfgIn.pred; a++) {
      const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
      if (Game.tile.isEdible(w.terrain[y * W + x])) { ent.spawn(Game.SPECIES.PREDATOR, x + 0.5, y + 0.5, 0.85, rg(), rg(), rg(), rg()); pred++; }
    }
    // カメラを全景へ。
    Game.state.camera.fitTiles(Math.max(W, H));
    Game.state.camera.centerOnTile((W / 2) | 0, (H / 2) | 0);
    return { W, H, founded, herb, pred, seed: Game.config.seed };
  }, { size: SIZE, kingdoms: KINGDOMS, herb: HERBIVORES, pred: PREDATORS });
  log("seeded", JSON.stringify(setup));

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  // 古いコマを掃除（毎回 plays を上書きしてリポジトリ肥大を防ぐ）。
  for (const f of fs.readdirSync(OUT)) if (/^frame\d+\.png$/.test(f)) fs.unlinkSync(path.join(OUT, f));

  const perFrame = Math.max(1, Math.round(TICKS / FRAMES));
  const stats = [];
  for (let f = 0; f < FRAMES; f++) {
    const frame = await page.evaluate((batch) => {
      const Game = window.Game;
      const world = Game.state.world, systems = Game.state.engine.systems;
      for (let t = 0; t < batch; t++) for (let s = 0; s < systems.length; s++) if (systems[s].tick) systems[s].tick(world);
      // このコマを描画してから取り込む。
      Game.state.renderer.draw(Game.state.camera);
      const civ = Game.state.civ, ent = Game.state.entities;
      let pop = 0, nations = 0, maxTech = 0, golden = 0;
      for (const k of civ.kingdoms) if (k && k.alive) { nations++; pop += k.humanCount; if (k.tech > maxTech) maxTech = k.tech; if (k.goldenAge) golden++; }
      let herb = 0, pred = 0;
      for (let i = 0; i < ent.count; i++) { if (!ent.alive[i]) continue; if (ent.type[i] === 0) herb++; else pred++; }
      const clk = Game.state.clock;
      return {
        url: document.getElementById("game").toDataURL("image/png"),
        year: clk ? clk.year : 0,
        season: clk && clk.season ? clk.season.name : "",
        nations, pop, maxTech: Math.round(maxTech), golden, herb, pred,
      };
    }, perFrame);

    const b64 = frame.url.replace(/^data:image\/png;base64,/, "");
    const name = "frame" + String(f).padStart(2, "0") + ".png";
    fs.writeFileSync(path.join(OUT, name), Buffer.from(b64, "base64"));
    delete frame.url;
    frame.file = name;
    stats.push(frame);
    log(`frame ${f + 1}/${FRAMES}`, `年${frame.year} ${frame.season} 国${frame.nations} 民${frame.pop} 技${frame.maxTech} 獣${frame.herb}/${frame.pred}`);
  }

  // 年代記を取得。
  const events = await page.evaluate(() => {
    const civ = Game.state.civ;
    const ev = (civ.getEvents ? civ.getEvents(80) : civ.events || []);
    return ev.map((e) => ({ year: e.year, text: e.text }));
  });

  await browser.close();
  await new Promise((r) => server.close(r));

  writeOutputs(setup, stats, events);
  writeSummary(setup, stats, events);
  if (pageErrors.length) log("page errors:", pageErrors.join(" | "));
  log("done →", OUT);
}

function writeOutputs(setup, stats, events) {
  fs.writeFileSync(path.join(OUT, "stats.json"), JSON.stringify({ setup, stats, events }, null, 2));

  // 年代記 Markdown。
  let md = "# 年代記（オートプレイ）\n\n";
  md += `世界の種子: \`${setup.seed}\` ／ 広さ ${setup.W}×${setup.H} ／ 建国 ${setup.founded} ／ 野生 草${setup.herb}・肉${setup.pred}\n\n`;
  let lastYear = null;
  for (const e of events) {
    if (e.year !== lastYear) { md += `\n**${e.year}年**\n`; lastYear = e.year; }
    md += `- ${e.text}\n`;
  }
  fs.writeFileSync(path.join(OUT, "chronicle.md"), md);

  // スライドショー（index.html）。コマを順送りして「再生」できる。
  const frames = stats.map((s) => s.file);
  const captions = stats.map((s) => `${s.year}年 ${s.season}・国${s.nations}・民${s.pop}・技${s.maxTech}・獣${s.herb}/${s.pred}`);
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>オートプレイ・タイムラプス</title>
<style>
  body{margin:0;background:#0b0e14;color:#cfd8e3;font:14px/1.5 system-ui,sans-serif;text-align:center}
  h1{font-size:18px;margin:14px}
  #stage{max-width:96vw;margin:0 auto}
  img{max-width:96vw;image-rendering:pixelated;border:1px solid #233;border-radius:6px;background:#000}
  #cap{margin:8px;color:#9fb3c8}
  .ctl{margin:10px}
  button,input{font:inherit;color:#cfd8e3;background:#1b2230;border:1px solid #2c3a4f;border-radius:6px;padding:6px 12px;cursor:pointer}
  a{color:#7fc7ff}
</style></head><body>
<h1>🌍 オートプレイ・タイムラプス</h1>
<div id="stage"><img id="img" alt="frame"></div>
<div id="cap"></div>
<div class="ctl">
  <button id="play">▶ 再生</button>
  <input id="seek" type="range" min="0" max="${frames.length - 1}" value="0" step="1" style="width:50%">
  <span id="idx"></span>
</div>
<p><a href="chronicle.md">📜 年代記</a> ・ <a href="stats.json">📊 統計</a></p>
<script>
  const frames=${JSON.stringify(frames)},caps=${JSON.stringify(captions)};
  const img=document.getElementById("img"),cap=document.getElementById("cap"),seek=document.getElementById("seek"),idx=document.getElementById("idx");
  let i=0,timer=null;
  function show(n){i=(n+frames.length)%frames.length;img.src=frames[i];cap.textContent=caps[i];seek.value=i;idx.textContent=(i+1)+"/"+frames.length;}
  seek.oninput=()=>show(+seek.value);
  document.getElementById("play").onclick=function(){
    if(timer){clearInterval(timer);timer=null;this.textContent="▶ 再生";return;}
    this.textContent="⏸ 停止";timer=setInterval(()=>show(i+1),650);
  };
  show(0);
</script>
</body></html>`;
  fs.writeFileSync(path.join(OUT, "index.html"), html);
}

function writeSummary(setup, stats, events) {
  const sf = process.env.GITHUB_STEP_SUMMARY;
  const first = stats[0] || {}, last = stats[stats.length - 1] || {};
  let s = "## 🌍 オートプレイ結果\n\n";
  s += `世界の種子 \`${setup.seed}\` ／ ${setup.W}×${setup.H} ／ 初期: 建国${setup.founded}・野生 草${setup.herb}/肉${setup.pred}\n\n`;
  s += "### 推移\n\n";
  s += "| 年 | 季 | 国 | 人口 | 技術 | 黄金 | 草食 | 肉食 |\n|--:|:--|--:|--:|--:|--:|--:|--:|\n";
  for (const r of stats) s += `| ${r.year} | ${r.season} | ${r.nations} | ${r.pop} | ${r.maxTech} | ${r.golden} | ${r.herb} | ${r.pred} |\n`;
  s += `\n**終局**: ${last.year}年 — ${last.nations}国・人口${last.pop}・最高技術${last.maxTech}\n\n`;
  s += "### 📜 年代記（抜粋）\n\n";
  for (const e of events.slice(-40)) s += `- **${e.year}年** ${e.text}\n`;
  s += "\n> タイムラプスの全コマは成果物(artifact)とPagesの `/playthrough/` で見られます。\n";
  if (sf) fs.appendFileSync(sf, s);
  else console.log(s);
}

main().catch((e) => { console.error("[autoplay] FAILED", e); process.exit(1); });
