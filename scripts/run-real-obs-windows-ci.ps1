$ErrorActionPreference = 'Stop'
$logDir = Join-Path (Get-Location) 'test-results/real-obs-windows'
$records = Join-Path $logDir 'recordings'
New-Item -ItemType Directory -Path $records -Force | Out-Null
$env:AI_LIVE_RTMP_RECORD_DIR = $records
$env:AI_LIVE_OBS_TEST_PASSWORD = 'obs-local-ci-only'
if (-not $env:AI_LIVE_OBS_SOAK_SECONDS) { $env:AI_LIVE_OBS_SOAK_SECONDS = '15' }

$obsBin = Join-Path $env:ProgramFiles 'obs-studio/bin/64bit/obs64.exe'
if (-not (Test-Path $obsBin)) { throw 'OBS Studio x64 executable was not installed' }
$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
node scripts/prepare-obs-ci-profile.mjs

$listener = $null
$obs = $null
try {
  $listenerArgs = @('-nostdin','-hide_banner','-loglevel','info','-listen','1','-i','rtmp://127.0.0.1:1935/live/ci-validation-only','-c','copy','-f','flv','-y',(Join-Path $records 'actual-obs.flv'))
  $listener = Start-Process -FilePath $ffmpeg -ArgumentList $listenerArgs -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $logDir 'rtmp-out.log') -RedirectStandardError (Join-Path $logDir 'rtmp-err.log')
  Start-Sleep -Seconds 2
  if ($listener.HasExited) { throw 'FFmpeg local RTMP listener exited during startup' }

  $obsArgs = @('--multi','--disable-updater','--disable-missing-files-check','--profile','AI-Live-CI','--collection','AI-Live-CI','--websocket_port','4455','--websocket_password','obs-local-ci-only','--websocket_ipv4_only')
  $obs = Start-Process -FilePath $obsBin -ArgumentList $obsArgs -PassThru -WorkingDirectory (Split-Path $obsBin) -NoNewWindow -RedirectStandardOutput (Join-Path $logDir 'obs-out.log') -RedirectStandardError (Join-Path $logDir 'obs-err.log')
  Start-Sleep -Seconds 4
  if ($obs.HasExited) { throw 'Real OBS Studio exited before WebSocket could start' }

  pnpm exec tsx scripts/test-real-obs-rtmp.mjs
  if ($LASTEXITCODE -ne 0) { throw "Real OBS / FFmpeg verification failed (exit $LASTEXITCODE)" }
  Write-Host 'PASS: actual Windows OBS -> local FFmpeg RTMP -> FFprobe video/audio'

  # Test the actual distributable Electron executable against real OBS/RTMP.
  pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Windows native package build failed" }
  $binary = Get-ChildItem -Path release -Recurse -Filter 'AI Live Commerce.exe' -File | Where-Object { $_.Directory.Name -eq 'win-unpacked' } | Select-Object -First 1
  if (-not $binary) { throw 'Packaged Windows app executable was not produced' }
  $env:ELECTRON_APP_PATH = $binary.FullName

  # FFmpeg listen=1 receives only one RTMP session. Restart it for GUI testing.
  if ($listener -and -not $listener.HasExited) {
    Stop-Process -Id $listener.Id -Force -ErrorAction SilentlyContinue
    $listener.WaitForExit(10000) | Out-Null
  }
  Start-Sleep -Seconds 2
  $listenerArgs = @('-nostdin','-hide_banner','-loglevel','info','-listen','1',
    '-i','rtmp://127.0.0.1:1935/live/ci-validation-only',
    '-c','copy','-f','flv','-y',(Join-Path $records 'actual-obs-packaged-ui.flv'))
  $listener = Start-Process -FilePath $ffmpeg -ArgumentList $listenerArgs -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $logDir 'rtmp-ui-out.log') -RedirectStandardError (Join-Path $logDir 'rtmp-ui-err.log')
  Start-Sleep -Seconds 2
  if ($listener.HasExited) { throw 'Packaged UI RTMP listener exited before test' }
  pnpm exec tsx scripts/test-real-obs-packaged-ui.mjs
  if ($LASTEXITCODE -ne 0) { throw "Packaged UI -> OBS -> RTMP test failed (exit $LASTEXITCODE)" }
  Write-Host 'PASS: real packaged Electron buttons -> OBS Browser Source -> loopback RTMP A/V'
}
finally {
  if ($obs) { Stop-Process -Id $obs.Id -Force -ErrorAction SilentlyContinue }
  if ($listener) { Stop-Process -Id $listener.Id -Force -ErrorAction SilentlyContinue }
  $obsLogDir = Join-Path $env:APPDATA 'obs-studio/logs'
  if (Test-Path $obsLogDir) {
    $recent = Get-ChildItem -Path $obsLogDir -Filter '*.txt' -File |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($recent) {
      Copy-Item $recent.FullName (Join-Path $logDir 'obs-internal.log') -Force
      Write-Host '=== OBS internal plugin diagnostics ==='
      Get-Content $recent.FullName | Select-String -Pattern 'obs-websocket|websocket|browser|plugin|fatal|error|warning' |
        Select-Object -Last 75
    }
  }
  Get-NetTCPConnection -LocalPort 4455 -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort,State,OwningProcess | Format-Table
  foreach ($name in @('obs-err.log','rtmp-err.log')) {
    $file = Join-Path $logDir $name
    if (Test-Path $file) { Write-Host "=== $name ==="; Get-Content $file -Tail 65 }
  }
}
