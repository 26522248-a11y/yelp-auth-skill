param(
  [Parameter(Mandatory=$true)][string]$PoolFile,
  [string]$Source = "",
  [string]$Control = "",
  [int]$Rows = 6,
  [int]$MaxUnknown = 1,
  [string]$Identity = "",
  [string]$ProfileTemplate = ""
)

# Post-change smoke test: prove the page still hydrates, the widget is the site's own (not a
# self-render), and /login/newajax still compares passwords. A run where every row is a magic
# link is a FAIL even though the HTTP calls all returned 200.
#
# -Control is a credential already verified as success: it must come back `success` + a
# zss cookie >= 20 chars + /profile 200, or the run is not measuring a real login.
#
# Uses its own run root, so state.txt of the real run is untouched.

$ErrorActionPreference = "Stop"
$root = Join-Path (Join-Path $PSScriptRoot "..") "runs\smoke"
if (-not $Source) { $Source = Join-Path (Join-Path $PSScriptRoot "..") "examples\combo.sample.txt" }
if (-not (Test-Path $Source)) { throw "source not found: $Source" }

$poolScript = Join-Path $PSScriptRoot "pool.ps1"
$outDir = Join-Path $root (Get-Date -Format "yyyyMMdd-HHmmss")
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Control goes first so a broken flow is visible even if every other row is fake.
$lines = @()
if ($Control) { $lines += $Control }
$lines += @(Get-Content $Source | Where-Object { $_ -match ':' } | Select-Object -First $(if ($Control) { $Rows - 1 } else { $Rows }))
if ($lines.Count -eq 0) { throw "empty smoke list" }
$smokeSrc = Join-Path $outDir "smoke.txt"
Set-Content -Path $smokeSrc -Value $lines -Encoding ascii
$total = $lines.Count

$poolArgs = @{
  Source = $smokeSrc; PoolFile = $PoolFile; Skip = 0; Take = $total; Chunk = $total
  Workers = 1; Pace = 14; OutDir = $outDir
  Identity = $Identity; ProfileTemplate = $ProfileTemplate
}
$log = & $poolScript @poolArgs 2>&1
$log | Select-Object -Last 3

$line = $log | Where-Object { $_ -like "TOTAL*" } | Select-Object -Last 1
$rowsDone = 0; $val = 0; $suc = 0; $link = 0; $r403 = 0; $r429 = 0; $r407 = 0; $unknown = 0; $own = 0
if ($line -match 'rows=(\d+)') { $rowsDone = [int]$matches[1] }
if ($line -match 'validated=(\d+)') { $val = [int]$matches[1] }
if ($line -match 'success=(\d+)') { $suc = [int]$matches[1] }
if ($line -match 'link=(\d+)') { $link = [int]$matches[1] }
if ($line -match '403=(\d+)') { $r403 = [int]$matches[1] }
if ($line -match '429=(\d+)') { $r429 = [int]$matches[1] }
if ($line -match '407=(\d+)') { $r407 = [int]$matches[1] }
if ($line -match 'unknown=(\d+)') { $unknown = [int]$matches[1] }

foreach ($jf in (Get-ChildItem $outDir -Filter *.jsonl -ErrorAction SilentlyContinue)) {
  Get-Content $jf.FullName -ErrorAction SilentlyContinue | ForEach-Object {
    try { $o = $_ | ConvertFrom-Json } catch { return }
    if ($o.event -eq 'widget' -and $o.own) { $own++ }
  }
}

$fail = @()
if ($rowsDone -lt $total) { $fail += "rows=$rowsDone/$total" }
if ($own -gt 0) { $fail += "own-widget (token has no rqdata)" }
if ($link -gt 0) { $fail += "link=$link (password not compared)" }
if ($val -lt 1 -and -not $Control) { $fail += "validated=0" }
if ($r403 -gt 0) { $fail += "403=$r403" }
if ($r429 -gt 0) { $fail += "429=$r429" }
if ($r407 -gt 0) { $fail += "407=$r407 (quota)" }
if ($unknown -gt $MaxUnknown) { $fail += "unknown=$unknown > $MaxUnknown" }

if ($Control) {
  $ctlEmail = $Control.Split(':')[0]
  $hit = $null
  foreach ($jf in (Get-ChildItem $outDir -Filter *.jsonl -ErrorAction SilentlyContinue)) {
    Get-Content $jf.FullName -ErrorAction SilentlyContinue | ForEach-Object {
      try { $o = $_ | ConvertFrom-Json } catch { return }
      if ($o.email -eq $ctlEmail) { $hit = $o }
    }
  }
  if (-not $hit) { $fail += "control produced no record" }
  elseif (-not $hit.success) { $fail += "control not success" }
  elseif ($hit.profileStatus -ne 200) { $fail += "control /profile=$($hit.profileStatus)" }
  elseif ([int]$hit.zssLen -lt 20) { $fail += "control zssLen=$($hit.zssLen)" }
}

if ($fail.Count -gt 0) { Write-Output ("SMOKE FAIL: " + ($fail -join ", ")); exit 1 }
Write-Output ("SMOKE PASS rows={0} validated={1} success={2} link=0 403=0 429=0 407=0 unknown={3} control={4}" -f $rowsDone, $val, $suc, $unknown, $(if ($Control) { 'verified' } else { 'none' }))
exit 0
