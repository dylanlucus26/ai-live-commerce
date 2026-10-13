#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# Verify actual macOS application bundles, not just electron-builder exit status.
apps=(release/*/mac/*.app release/*/mac-arm64/*.app release/*/mac-x64/*.app)
if (( ${#apps[@]} < 2 )); then
  echo "Expected both x64 and arm64 .app bundles under release/*/mac*." >&2
  exit 1
fi
for app in "${apps[@]}"; do
  echo "Checking app: $app"
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
  /usr/bin/codesign -dv --verbose=2 "$app" 2>&1 | grep -E 'Identifier=|Signature=|Format=' || true
done

# Verify the signature survives packaging inside downloaded DMG archives.
dmgs=(release/*/*_macos_arm64.dmg release/*/*_macos_x64.dmg)
if (( ${#dmgs[@]} != 2 )); then
  echo "Expected 2 DMGs (x64 + arm64), got ${#dmgs[@]}." >&2
  exit 1
fi
for dmg in "${dmgs[@]}"; do
  mount_path=$(mktemp -d)
  echo "Mounting: $dmg"
  /usr/bin/hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mount_path" "$dmg"
  bundle="$mount_path/AI Live Commerce.app"
  if [[ ! -d "$bundle" ]]; then
    /usr/bin/hdiutil detach -quiet "$mount_path" || true
    echo "DMG did not contain the expected application bundle." >&2
    exit 1
  fi
  if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "$bundle"; then
    /usr/bin/hdiutil detach -quiet "$mount_path" || true
    echo "Invalid code signature inside: $dmg" >&2
    exit 1
  fi
  /usr/bin/hdiutil detach -quiet "$mount_path"
  rmdir "$mount_path"
done
echo "Both macOS architectures and distributed DMGs passed signature-integrity checks."
echo "NOTE: ad-hoc signatures are NOT notarized or Apple Developer ID trusted."
