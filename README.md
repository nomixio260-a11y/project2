# Fantasy Map Simulator

WorldBox 風のファンタジーマップシミュレーター。プロシージャル生成された大陸マップを、神の力（地形ブラシ）で編集し、**生物・炎の延焼・文明（王国）**が生きたシミュレーションとして動きます。

バニラ JavaScript + HTML5 Canvas 製。**ビルド不要・依存ゼロ**。PC・スマホ・タブレット対応（レスポンシブ + 高DPI）。

## 主な機能

- **バイオーム** — 標高・湿度に加え**温度（緯度＋標高）**で分類。砂漠・サバンナ・湿地・ツンドラ・ジャングルなどを生成し、湿った高地から海へ**川**が流れる。
- **生物・生命** — 草食／肉食動物が徘徊・採食・繁殖・捕食・寿命/餓死。data-oriented なエンティティストア（TypedArray + free-list）。
- **炎の延焼** — 可燃地形に着火すると確率的に延焼し、燃え尽きて焼け地に。水が延焼を止める。アクティブ集合方式で軽量。
- **文明・王国** — 建国すると領土がフロンティアから拡張し、国境で人口比に応じて領土を奪い合う。
- **シミュレーション制御** — 一時停止／再生と速度（0.5〜4倍）。固定タイムステップで描画から分離。

## Web で遊ぶ（GitHub Pages）

`main` または開発ブランチへ push すると、GitHub Actions が自動で GitHub Pages にデプロイします（`.github/workflows/deploy.yml`）。

公開URL（Pages 有効化後）:

```
https://nomixio260-a11y.github.io/project2/
```

**初回のみ**: リポジトリの **Settings → Pages → Build and deployment → Source** を **「GitHub Actions」** に設定してください。以降は push のたびに自動更新されます。

## 一時的に公開する（ライブトンネル）

セッション中だけ手元のサーバを外部公開したい場合は `tools/share.sh` を使います。

```bash
NGROK_AUTHTOKEN=xxxxxxxx ./tools/share.sh   # → https://xxxx.ngrok-free.app
```

ngrok の無料 authtoken（<https://dashboard.ngrok.com> で取得）が必要です。
トンネルは TLS over 443 を使うため制限の厳しいネットワークでも通りやすい一方、
**サーバ／コンテナが起動している間のみ有効な一時URL**です。恒久公開は上記 GitHub Pages を使ってください。

## ローカルで起動

### 1. ただ開くだけ
`index.html` をブラウザにドラッグ＆ドロップ、またはダブルクリックするだけで動きます（`file://` で動作）。

### 2. ローカルサーバ（任意・推奨）
```bash
npm run serve          # → http://localhost:8000/
# または
python3 -m http.server 8000
```

## 操作方法

### PC（マウス / キーボード）
| 操作 | 入力 |
|------|------|
| ツール選択 | ツールバーのボタン / 数字キー 1〜0・K |
| 地形を編集・生物配置・建国 | 左ドラッグ / クリック |
| ブラシサイズ | スライダー / `[` `]` キー |
| 視点移動 (パン) | W A S D / 矢印キー / 中ボタン（または右）ドラッグ |
| ズーム | マウスホイール（カーソル基点） |
| 一時停止 / 速度 | `P` / 速度ボタン（0.5×〜4×） |
| マップ再生成 | 「新しい世界」ボタン |

### スマホ / タブレット（タッチ）
| 操作 | 入力 |
|------|------|
| 地形を編集 | 1本指でなぞる |
| パン + ズーム | 2本指でドラッグ / ピンチ |
| ツール・ブラシ | 下部ツールバー（☰ で開閉） |

## 神の力（ツール）

地形（1〜8）:

- **隆起 / 沈下** — 土地を盛り上げる・沈める
- **水 / 砂 / 草原 / 森 / 山** — 地形を直接描く
- **着火（8）** — 可燃地形に延焼する炎を放つ（不燃地は即焼け地）

生命・文明:

- **草食（9） / 肉食（0）** — 生物をスポーン
- **建国（K）** — その地に王国を興す

シミュレーション制御: **一時停止（P）** と **速度（0.5×〜4×）**。

## アーキテクチャ

`window.Game` 名前空間にモジュールがぶら下がる構成。`index.html` がスクリプトを依存順にロードします（no-build 制約のため ES Modules ではなくクラシック `<script>` を使用）。

```
js/
├── core/      namespace, constants, utils
├── math/      noise (Simplex + fBm)
├── world/     world(データ), tile(分類), worldgen(生成), entities(生物ストア)
├── render/    camera, renderer
├── tools/     brush, godpowers
├── input/     input
├── ui/        toolbar
├── systems/   creatures, fire, civ（engine.systems に登録）
├── engine/    engine（固定タイムステップのゲームループ）
└── main.js    起動
```

各シミュレーションは `engine.systems` に登録され、固定タイムステップの `tick(world)`
（一時停止・速度に従う）と毎フレームの `update(dt, world)`（アニメーション）を持ちます。
レンダラは地形（オフスクリーン）→ 領土オーバーレイ → 炎 → 生物 の順に毎フレーム合成します。

## テスト

```bash
npm test            # ユニットテスト（コアロジック / 依存ゼロ）
npm run test:browser   # 実ブラウザ(Puppeteer)スモークテスト
npm run test:all       # 全テスト
```

- `tests/unit.test.js` — ノイズ・地形生成・座標変換などのロジック検証（DOM不要）
- `tests/browser.test.js` — Puppeteer で実描画・編集・タッチ・レスポンシブを検証

CI（`.github/workflows/test.yml`）で push / PR ごとに自動実行されます。
