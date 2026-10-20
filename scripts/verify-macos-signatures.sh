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

# hdiutil may return resource-busy (exit 16) while macOS is briefly indexing
# a newly mounted image. Retry only the cleanup step; never skip codesign checks.
detach_verified_dmg() {
  local point="$1"
  local attempt
  for attempt in 1 2 3 4 5; do
    if /usr/bin/hdiutil detach -quiet "$point" 2>/dev/null; then
      return 0
    fi
    echo "DMG detach busy (attempt ${attempt}/5), retrying..." >&2
    sleep "$attempt"
  done
  # We mounted this read-only image ourselves; force is a final cleanup fallback.
  if /usr/bin/hdiutil detach -force "$point"; then
    echo "DMG required force-detach after signature verification." >&2
    return 0
  fi
  echo "Could not unmount verified DMG at: $point" >&2
  return 1
}

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
    detach_verified_dmg "$mount_path" || true
    echo "DMG did not contain the expected application bundle." >&2
    exit 1
  fi
  if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "$bundle"; then
    detach_verified_dmg "$mount_path" || true
    echo "Invalid code signature inside: $dmg" >&2
    exit 1
  fi
  detach_verified_dmg "$mount_path"
  rmdir "$mount_path"
done
echo "Both macOS architectures and distributed DMGs passed signature-integrity checks."
echo "NOTE: ad-hoc signatures are NOT notarized or Apple Developer ID trusted."
