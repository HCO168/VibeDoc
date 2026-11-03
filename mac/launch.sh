#!/bin/bash
# Start the VibeDoc server for a repository if it is not already running, then open it.
# Called by the VibeDoc app (see install.sh); can also be run directly.
#   VIBEDOC_REPO     repository to serve (must contain vibedoc.config.json; default: current directory)
#   VIBEDOC_NODE     node binary (default: node on PATH)
#   PORT             default: `port` in vibedoc.config.json, else 4870
#   VIBEDOC_NO_OPEN  set to 1 to start without opening a window
set -u

TOOL="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "${VIBEDOC_REPO:-$(pwd)}" && pwd)"
NODE="${VIBEDOC_NODE:-$(command -v node || true)}"
if [ -z "${PORT:-}" ] && [ -n "$NODE" ] && [ -f "$REPO/vibedoc.config.json" ]; then
  PORT="$("$NODE" -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port || 4870) } catch { console.log(4870) }' "$REPO/vibedoc.config.json")"
fi
PORT="${PORT:-4870}"
URL="http://127.0.0.1:${PORT}/"
LOG="$HOME/Library/Logs/vibedoc.log"

alert() {
  osascript -e "display alert \"VibeDoc\" message \"$1\"" >/dev/null 2>&1 || echo "VibeDoc: $1" >&2
}
health() {
  curl -fsS --max-time 1 "${URL}api/health" 2>/dev/null
}
# Whether the server answering on this port is VibeDoc serving this repository.
ours() {
  [ -n "$NODE" ] || return 1
  health | "$NODE" -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { const h = JSON.parse(s); process.exit(h.app === "vibedoc" && h.root === process.argv[1] ? 0 : 1); } catch { process.exit(1); } });' "$REPO"
}

STARTED=0
if ! ours; then
  STARTED=1
  if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    alert "找不到 node，需要 Node.js 23.6 或更高版本。"
    exit 1
  fi
  if [ ! -f "$REPO/vibedoc.config.json" ]; then
    alert "$REPO 里没有 vibedoc.config.json，请先在这个仓库运行 vibedoc init。"
    exit 1
  fi
  if curl -fsS --max-time 1 "$URL" >/dev/null 2>&1; then
    alert "端口 $PORT 已被其他程序（或另一个仓库的 VibeDoc）占用，请在 vibedoc.config.json 里换一个 port。"
    exit 1
  fi
  mkdir -p "$(dirname "$LOG")"
  printf '\n[%s] 启动 %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$REPO" >>"$LOG"
  (cd "$REPO" && VIBEDOC_REPO="$REPO" PORT="$PORT" nohup "$NODE" "$TOOL/server.ts" >>"$LOG" 2>&1 &)
  for _ in $(seq 1 75); do
    ours && break
    sleep 0.2
  done
  if ! ours; then
    alert "启动失败，日志见 $LOG"
    exit 1
  fi
fi

[ "${VIBEDOC_NO_OPEN:-0}" = "1" ] && exit 0

# Raise a Chrome window already showing the board, reloading it when this run started a new
# server so it does not keep showing the page an older server served. Needs permission to
# control Chrome; when that is missing or no such window exists, fail so the caller opens a new one.
focus_board() {
  pgrep -xq "Google Chrome" || return 1
  osascript - "${URL%/}" "$STARTED" >/dev/null 2>&1 <<'OSA'
on run argv
	tell application "Google Chrome"
		repeat with w in windows
			if URL of active tab of w starts with item 1 of argv then
				if item 2 of argv is "1" then reload active tab of w
				set index of w to 1
				activate
				return
			end if
		end repeat
	end tell
	error "no board window"
end run
OSA
}

if [ -d "/Applications/Google Chrome.app" ]; then
  focus_board && exit 0
  # App-mode window: no tabs or address bar, so it behaves like a standalone app.
  open -na "Google Chrome" --args --app="$URL"
  # A running Chrome takes the new window without coming forward; bring it to the front.
  open -a "Google Chrome"
else
  open "$URL"
fi
