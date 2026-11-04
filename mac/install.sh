#!/bin/bash
# Build "~/Applications/<名称>.app", a launcher for the VibeDoc board of all registered projects that
# Spotlight, Raycast and Alfred can find.
#   mac/install.sh [仓库目录] [--name "VibeDoc"]      a repository given here is registered as well
# The app only records the VibeDoc folder and the node binary; the launch logic stays in VibeDoc
# (mac/launch.sh), so updating VibeDoc needs no reinstall. On first launch macOS asks to let the app
# access the folders holding the repositories (and to control Chrome).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOL="$(cd "$HERE/.." && pwd)"
REPO=""
NAME="VibeDoc"
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:-VibeDoc}"; shift 2 ;;
    *) REPO="$(cd "$1" && pwd)"; shift ;;
  esac
done
NODE="$(command -v node || true)"
APP="$HOME/Applications/$NAME.app"

if [ -z "$NODE" ]; then
  echo "找不到 node，需要 Node.js 23.6 或更高版本" >&2
  exit 1
fi
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>23||(a===23&&b>=6)?0:1)'; then
  echo "node $("$NODE" --version) 太旧，需要 23.6 或更高版本" >&2
  exit 1
fi
if [ -n "$REPO" ]; then
  "$NODE" "$TOOL/vibedoc.ts" add "$REPO" || exit 1
fi
PORT="${PORT:-4870}"

# AppleScript applet rather than a bare shell-script bundle: macOS only asks a real app for
# Documents access, and the server it starts inherits that permission. It stays open (idle
# loop) while the server runs, so the permission holds, and quits once the server stops.
# Paths are returned from handlers, not properties, because applets write changed
# properties back into themselves on quit, which would break the signature.
as_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
TMP="$(mktemp -d)"
cat >"$TMP/main.applescript" <<OSA
on repoPath()
	return "$(as_str "$REPO")"
end repoPath

on nodePath()
	return "$(as_str "$NODE")"
end nodePath

on toolPath()
	return "$(as_str "$TOOL")"
end toolPath

on run
	openBoard()
end run

on reopen
	openBoard()
end reopen

on openBoard()
	try
		do shell script "export VIBEDOC_REPO=" & quoted form of repoPath() & " VIBEDOC_NODE=" & quoted form of nodePath() & " PORT=$PORT; /bin/bash " & quoted form of (toolPath() & "/mac/launch.sh")
	on error errMsg number errNum
		if errMsg contains "Operation not permitted" then
			activate
			display alert "$(as_str "$NAME")" message "没有权限读取项目文件夹。请在「系统设置 → 隐私与安全性 → 文件与文件夹」里允许 $(as_str "$NAME") 访问项目所在的文件夹（如「文稿」），然后重新打开。"
		else if errNum is not 1 then
			activate
			display alert "$(as_str "$NAME")" message errMsg
		end if
		quit
	end try
end openBoard

on idle
	try
		do shell script "curl -fsS --max-time 2 http://127.0.0.1:$PORT/api/health | grep -q vibedoc"
	on error
		quit
	end try
	return 30
end idle
OSA

# Replace an installed copy; a running one is stopped first so the new build takes over.
pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
rm -rf "$APP"
mkdir -p "$(dirname "$APP")"
osacompile -s -o "$APP" "$TMP/main.applescript"

PLIST="$APP/Contents/Info.plist"
BUNDLE_SUFFIX="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//')"
plutil -replace CFBundleIdentifier -string "dev.vibedoc.${BUNDLE_SUFFIX:-app}" "$PLIST"
plutil -replace CFBundleName -string "$NAME" "$PLIST"
plutil -replace CFBundleDisplayName -string "$NAME" "$PLIST"
plutil -replace LSUIElement -bool true "$PLIST"
plutil -replace NSDocumentsFolderUsageDescription -string "读取仓库里的规则与代码，生成看板。" "$PLIST"
plutil -replace NSAppleEventsUsageDescription -string "把已经打开的看板窗口切到前台，避免重复开窗口。" "$PLIST"

# Icon: render the SVG with Quick Look, then build an .icns. Best effort; the app works without it.
if qlmanage -t -s 1024 -o "$TMP" "$HERE/icon.svg" >/dev/null 2>&1 && [ -f "$TMP/icon.svg.png" ]; then
  mkdir -p "$TMP/icon.iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$TMP/icon.svg.png" --out "$TMP/icon.iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$TMP/icon.svg.png" --out "$TMP/icon.iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  if iconutil -c icns "$TMP/icon.iconset" -o "$APP/Contents/Resources/applet.icns"; then
    # Assets.car carries the stock script icon and wins over applet.icns; drop it.
    plutil -remove CFBundleIconName "$PLIST" 2>/dev/null || true
    rm -f "$APP/Contents/Resources/Assets.car"
  fi
fi
rm -rf "$TMP"

# Ad-hoc signature gives macOS a stable identity to remember the Documents permission by.
# Reinstalling changes it, so macOS asks again on the next launch.
codesign --force --deep --sign - "$APP"
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
mdimport "$APP" >/dev/null 2>&1 || true

if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q vibedoc; then
  echo "提示：看板服务正在运行，先在页面上点「停止服务」，再从 App 打开，服务才会用上 App 的权限。"
fi
echo "已安装：$APP"
echo "仓库：$REPO"
echo "Node：$NODE"
