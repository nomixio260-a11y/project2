#!/usr/bin/env bash
# 静的サーバを起動し、ngrok で一時的に外部公開する。
#   NGROK_AUTHTOKEN=xxxx ./tools/share.sh [PORT]
#
# ngrok の無料 authtoken が必要: https://dashboard.ngrok.com
# 公開URLは「サーバ/コンテナが起動している間のみ」有効な一時URLです。
# 恒久公開は GitHub Pages を使ってください（README 参照）。
set -euo pipefail

PORT="${1:-8000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${NGROK_AUTHTOKEN:-}" ]; then
  echo "ERROR: NGROK_AUTHTOKEN が未設定です。" >&2
  echo "  https://dashboard.ngrok.com で無料トークンを取得し、" >&2
  echo "  NGROK_AUTHTOKEN=xxxx ./tools/share.sh で実行してください。" >&2
  exit 1
fi

# ngrok バイナリの解決（PATH もしくは tools/ngrok）。
NGROK="$(command -v ngrok || true)"
[ -z "$NGROK" ] && [ -x "$ROOT/tools/ngrok" ] && NGROK="$ROOT/tools/ngrok"
if [ -z "$NGROK" ]; then
  echo "ERROR: ngrok が見つかりません。https://ngrok.com/download から入手してください。" >&2
  exit 1
fi

# 静的サーバを起動。
echo "Starting static server on :$PORT ..."
PORT="$PORT" node "$ROOT/tools/serve.js" &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT
sleep 1

# ngrok を起動（TLS over 443）。
"$NGROK" config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null 2>&1 || true
echo "Opening public tunnel via ngrok ..."
exec "$NGROK" http "$PORT" --log=stdout
