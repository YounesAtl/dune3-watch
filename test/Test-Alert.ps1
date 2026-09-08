<#
  Test-Alert.ps1 — end-to-end alert test with a faked Kinepolis feed.

  Starts a local stand-in API that claims Dune 3 is on sale, runs the real
  watcher against it, and sends a REAL push to your phone. Nothing touches the
  live Kinepolis API and nothing touches your real seen.json.

  Usage (from the test folder):

      .\Test-Alert.ps1                 # 70mm at Brussels + other formats
      .\Test-Alert.ps1 -Scenario any   # on sale but NO 70mm anywhere
      .\Test-Alert.ps1 -Scenario none  # no Dune at all - expect silence

  Requires $env:NTFY_TOPIC to be set, or pass -Topic.
#>
param(
  [ValidateSet('70mm', 'any', 'none')]
  [string]$Scenario = '70mm',
  [string]$Topic = $env:NTFY_TOPIC,
  [int]$Port = 8732
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($Topic)) {
  Write-Host "NTFY_TOPIC is not set." -ForegroundColor Red
  Write-Host 'Run:  $env:NTFY_TOPIC = "your-topic"     (or pass -Topic "your-topic")'
  exit 1
}

$watcher = Join-Path $PSScriptRoot '..\kinepolis-watch.mjs'
if (-not (Test-Path $watcher)) {
  Write-Host "Cannot find kinepolis-watch.mjs one level up from $PSScriptRoot" -ForegroundColor Red
  exit 1
}

# A throwaway state file. The real seen.json is never read or written, so a test
# run can't poison it with fake session ids or mark real sessions as already seen.
$stateFile = Join-Path $PSScriptRoot 'test-seen.json'
Remove-Item $stateFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== scenario: $Scenario ===" -ForegroundColor Cyan

$env:SCENARIO = $Scenario
$env:PORT = "$Port"
$server = Start-Process node -ArgumentList 'fake-kinepolis.mjs' -PassThru -NoNewWindow

try {
  # Wait for the fake API to accept connections rather than guessing at a sleep.
  $ready = $false
  foreach ($i in 1..30) {
    Start-Sleep -Milliseconds 300
    try {
      Invoke-WebRequest "http://127.0.0.1:$Port" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $ready = $true; break
    } catch { }
  }
  if (-not $ready) { Write-Host "fake API never came up on port $Port" -ForegroundColor Red; exit 1 }

  Write-Host "fake API up. Running the real watcher against it..." -ForegroundColor DarkGray
  Write-Host ""

  $env:FEED_URL   = "http://127.0.0.1:$Port"
  $env:STATE_FILE = $stateFile
  $env:NTFY_TOPIC = $Topic

  node $watcher
  $code = $LASTEXITCODE

  Write-Host ""
  if ($Scenario -eq 'none') {
    Write-Host "Expected: NO notification at all." -ForegroundColor Yellow
  } else {
    Write-Host "Expected: push notification(s) on your phone now." -ForegroundColor Green
    Write-Host "  70mm at Brussels arrives as URGENT (bypasses Do Not Disturb)." -ForegroundColor DarkGray
    Write-Host "  Other formats arrive as high/default." -ForegroundColor DarkGray
  }
  Write-Host "watcher exit code: $code"
}
finally {
  # Always clean up, even on Ctrl+C or an error.
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  Remove-Item Env:\FEED_URL, Env:\STATE_FILE, Env:\SCENARIO, Env:\PORT -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "fake API stopped. Real seen.json untouched." -ForegroundColor DarkGray
  Write-Host "Run again to re-send: test state is reset each time." -ForegroundColor DarkGray
}
