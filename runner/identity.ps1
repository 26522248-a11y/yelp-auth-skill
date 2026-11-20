param(
  [Parameter(Mandatory=$true)][ValidateSet('capture','verify','diff','selftest','seed','pack')][string]$Mode,
  [string]$A = "",
  [string]$B = "",
  [int]$Seconds = 75
)

# Browser identity is the reason two machines get different Yelp variants: one shows the
# site hCaptcha widget, the other only lets the runner self-render. This script makes the
# identity explicit and diffable instead of inherited from whatever the box happens to be.
#
#   .\runner\identity.ps1 -Mode capture
#   .\runner\identity.ps1 -Mode verify
#   .\runner\identity.ps1 -Mode diff -A profiles\identity.json -B old.json
#   .\runner\identity.ps1 -Mode selftest
#   .\runner\identity.ps1 -Mode seed            # warm profile, needs PROXY_HOST/PORT/USER/PASS
#   .\runner\identity.ps1 -Mode pack            # profiles\base -> profiles\base.zip
#
# Reference values live in profiles\identity.json. batch-fast.js loads that file
# automatically; IDENTITY=<file> points it somewhere else.

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found in PATH" }
$idFile = if ($A) { $A } else { Join-Path $repo "profiles\identity.json" }

function Get-Chrome {
  if ($env:CHROME) { return $env:CHROME }
  $p = "C:\Program Files\Google\Chrome\Application\chrome.exe"
  if (-not (Test-Path $p)) { throw "chrome.exe not found; set CHROME" }
  return $p
}

switch ($Mode) {
  'capture' {
    & $node (Join-Path $PSScriptRoot "identity.js") capture $idFile
    Write-Output ("reference identity written to {0}" -f $idFile)
  }
  'verify' {
    if (-not (Test-Path $idFile)) { throw "no reference identity: $idFile" }
    & $node (Join-Path $PSScriptRoot "identity.js") verify $idFile
    if ($LASTEXITCODE -ne 0) {
      Write-Output "MISMATCH: install the exact Chrome build in the reference file before running."
      exit 1
    }
    Write-Output "identity OK"
  }
  'diff' {
    if (-not $A -or -not $B) { throw "diff needs -A and -B" }
    & $node (Join-Path $PSScriptRoot "identity.js") diff $A $B
    exit $LASTEXITCODE
  }
  'selftest' {
    & $node (Join-Path $PSScriptRoot "identity.js") selftest $idFile
    exit $LASTEXITCODE
  }
  'seed' {
    # Build a warm profile from this machine's own IP path. Copy it to the other machine
    # so both start with the same cookies, storage and cached bundle.
    $base = Join-Path $repo "profiles\base"
    New-Item -ItemType Directory -Force -Path $base | Out-Null
    $cargs = @(
      "--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled",
      "--window-size=900,700", "--lang=en-US", "--user-data-dir=$base",
      "https://www.yelp.com/login/"
    )
    if ($env:PROXY_HOST) {
      $u = if ($env:PROXY_USER) { "$($env:PROXY_USER):$($env:PROXY_PASS)@" } else { "" }
      $cargs = @("--proxy-server=http://$u$($env:PROXY_HOST):$($env:PROXY_PORT)") + $cargs
    }
    $c = Start-Process (Get-Chrome) -ArgumentList $cargs -PassThru
    Write-Output ("seeding profile for {0}s - leave the page alone" -f $Seconds)
    Start-Sleep -Seconds $Seconds
    if (-not $c.HasExited) { $c.CloseMainWindow() | Out-Null; Start-Sleep 3 }
    if (-not $c.HasExited) { $c.Kill() }
    Write-Output ("profile ready: {0} - pack it and copy to the other machine" -f $base)
  }
  'pack' {
    $base = Join-Path $repo "profiles\base"
    if (-not (Test-Path $base)) { throw "no seed profile; run -Mode seed first" }
    $zip = Join-Path $repo "profiles\base.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $base "*") -DestinationPath $zip -CompressionLevel Optimal
    $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
    Write-Output ("packed {0} MB -> {1}" -f $mb, $zip)
  }
}

