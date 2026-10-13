// electron-builder v26.0.12 skips the implicit ad-hoc identity ("-") on macOS 26.
// Sign the complete app *before* the DMG is created, not after distributing it.
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { existsSync } = require('node:fs')

exports.default = async function adHocSignAfterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename + '.app'
  const appPath = path.join(context.appOutDir, appName)
  const entitlements = path.resolve('build/entitlements.mac.plist')
  if (!existsSync(appPath)) throw new Error('macOS app bundle not found: ' + appPath)
  if (!existsSync(entitlements)) throw new Error('Missing macOS entitlements file')
  const cmd = '/usr/bin/codesign'
  const opts = { stdio: 'inherit', timeout: 90_000 }
  // Temporary local-test signing. No Apple Developer certificate or notarization is claimed.
  execFileSync(cmd, ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath], opts)
  execFileSync(cmd, ['--verify', '--deep', '--strict', '--verbose=2', appPath], opts)
  process.stdout.write('[mac] Verified ad-hoc signature before DMG packaging: ' + appPath + '\n')
}
