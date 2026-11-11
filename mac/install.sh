#!/bin/bash
# Build ~/Applications/VibeDoc.app: a native macOS window around the VibeDoc board, found by Spotlight,
# Raycast and Alfred, with no browser involved.
#   mac/install.sh [仓库目录]          a repository given here is registered as well
# The app records this VibeDoc checkout and the node binary; it runs the checkout's server.ts, so pulling
# VibeDoc needs no rebuild (quit and reopen the app). Rebuild after changing mac/VibeDoc.swift or moving
# the checkout or node. Needs Xcode or the Command Line Tools for swiftc.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOL="$(cd "$HERE/.." && pwd)"
NODE="$(command -v node || true)"
APP="$HOME/Applications/VibeDoc.app"

if [ -z "$NODE" ]; then
  echo "找不到 node，需要 Node.js 23.6 或更高版本" >&2
  exit 1
fi
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>23||(a===23&&b>=6)?0:1)'; then
  echo "node $("$NODE" --version) 太旧，需要 23.6 或更高版本" >&2
  exit 1
fi
if ! command -v swiftc >/dev/null; then
  echo "找不到 swiftc：请安装 Xcode 或运行 xcode-select --install" >&2
  exit 1
fi
if [ -n "${1:-}" ]; then
  "$NODE" "$TOOL/vibedoc.ts" add "$1"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "编译 VibeDoc.app…"
swiftc -swift-version 5 -O -target "$(uname -m)-apple-macos13.0" -framework Cocoa -framework WebKit \
  "$HERE/VibeDoc.swift" -o "$TMP/VibeDoc"

# Replace an installed copy (including the older AppleScript launcher); a running one quits first.
osascript -e 'tell application id "dev.vibedoc.app" to quit' >/dev/null 2>&1 || true
pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
sleep 0.5
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$TMP/VibeDoc" "$APP/Contents/MacOS/VibeDoc"

VERSION="$(cd "$TOOL" && git rev-parse --short HEAD 2>/dev/null || echo dev)"
PLIST="$APP/Contents/Info.plist"
cat >"$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>VibeDoc</string>
  <key>CFBundleIdentifier</key><string>dev.vibedoc.app</string>
  <key>CFBundleName</key><string>VibeDoc</string>
  <key>CFBundleDisplayName</key><string>VibeDoc</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>VibeDoc</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSDocumentsFolderUsageDescription</key><string>读取仓库里的规则、文档与代码，生成看板。</string>
  <key>NSDesktopFolderUsageDescription</key><string>读取放在桌面上的项目。</string>
  <key>NSDownloadsFolderUsageDescription</key><string>读取放在下载文件夹里的项目。</string>
  <key>VibeDocHome</key><string>$TOOL</string>
  <key>VibeDocNode</key><string>$NODE</string>
</dict></plist>
PL
printf 'APPL????' >"$APP/Contents/PkgInfo"

# Icon: render the SVG with Quick Look, then build an .icns. Best effort; the app works without it.
if qlmanage -t -s 1024 -o "$TMP" "$HERE/icon.svg" >/dev/null 2>&1 && [ -f "$TMP/icon.svg.png" ]; then
  mkdir -p "$TMP/icon.iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$TMP/icon.svg.png" --out "$TMP/icon.iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$TMP/icon.svg.png" --out "$TMP/icon.iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$TMP/icon.iconset" -o "$APP/Contents/Resources/VibeDoc.icns" || true
fi

# Ad-hoc signature gives macOS a stable identity to remember folder permissions by.
# Reinstalling changes it, so macOS asks again on the next launch.
codesign --force --deep --sign - "$APP"
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
mdimport "$APP" >/dev/null 2>&1 || true

echo "已安装：$APP"
echo "VibeDoc：$TOOL"
echo "Node：$NODE"
if curl -fsS --max-time 1 "http://127.0.0.1:4870/api/health" 2>/dev/null | grep -q vibedoc; then
  echo "提示：已有看板服务在运行，App 会直接连上它；想让服务改由 App 启动（用上 App 的文件夹权限），先停掉它再打开 App。"
fi
