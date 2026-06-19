# Fantasy Map Simulator

WorldBox 風のファンタジーマップシミュレーター。プロシージャル生成された大陸マップを、神の力（地形ブラシ）で自由に編集できるブラウザゲームです。

バニラ JavaScript + HTML5 Canvas 製。**ビルド不要・依存ゼロ**。PC・スマホ・タブレット対応（レスポンシブ + 高DPI）。

## Web で遊ぶ（GitHub Pages）

`main` または開発ブランチへ push すると、GitHub Actions が自動で GitHub Pages にデプロイします（`.github/workflows/deploy.yml`）。

公開URL（Pages 有効化後）:

```
https://nomixio260-a11y.github.io/project2/
```

**初回のみ**: リポジトリの **Settings → Pages → Build and deployment → Source** を **「GitHub Actions」** に設定してください。以降は push のたびに自動更新されます。

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
| ツール選択 | ツールバーのボタン / 数字キー 1〜8 |
| 地形を編集 | 左ドラッグ |
| ブラシサイズ | スライダー / `[` `]` キー |
| 視点移動 (パン) | W A S D / 矢印キー / 中ボタン（または右）ドラッグ |
| ズーム | マウスホイール（カーソル基点） |
| マップ再生成 | 「新しい世界」ボタン |

### スマホ / タブレット（タッチ）
| 操作 | 入力 |
|------|------|
| 地形を編集 | 1本指でなぞる |
| パン + ズーム | 2本指でドラッグ / ピンチ |
| ツール・ブラシ | 下部ツールバー（☰ で開閉） |

## 神の力（ツール）

- **隆起** — 土地を盛り上げる（島が成長）
- **沈下** — 土地を沈める
- **水** — 海・湖にする
- **砂** — 砂地
- **草原** — 草原にする
- **森** — 森を生やす
- **山** — 山を作る
- **破壊（炎）** — 焼け地にする

## アーキテクチャ

`window.Game` 名前空間にモジュールがぶら下がる構成。`index.html` がスクリプトを依存順にロードします（no-build 制約のため ES Modules ではなくクラシック `<script>` を使用）。

```
js/
├── core/      namespace, constants, utils
├── math/      noise (Simplex + fBm)
├── world/     world(データ), tile(分類), worldgen(生成)
├── render/    camera, renderer
├── tools/     brush, godpowers
├── input/     input
├── ui/        toolbar
├── engine/    engine（ゲームループ）
└── main.js    起動
```

将来的に生物・文明・戦争などを `engine.systems` 配列に追加して拡張できる設計です。

## テスト

```bash
npm test            # ユニットテスト（コアロジック / 依存ゼロ）
npm run test:browser   # 実ブラウザ(Puppeteer)スモークテスト
npm run test:all       # 全テスト
```

- `tests/unit.test.js` — ノイズ・地形生成・座標変換などのロジック検証（DOM不要）
- `tests/browser.test.js` — Puppeteer で実描画・編集・タッチ・レスポンシブを検証

CI（`.github/workflows/test.yml`）で push / PR ごとに自動実行されます。
