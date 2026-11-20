param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$PoolFile,
  [int]$StartAt = 0,
  [int]$Take = 300,
  [int]$Chunk = 15,
  [int]$Workers = 2,
  [int]$Pace = 14,
  [string]$Root = ".\runs"
)

# Runs the whole remaining list in background-safe batches.
# Progress is a JSONL file: one line per batch with rows/validated/success/rate.
# State file lets a restart continue from the right offset.

$ErrorActionPreference = "Continue"
$poolScript = Join-Path $PSScriptRoot "pool.ps1"
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$progress = Join-Path $Root "progress.jsonl"
$stateFile = Join-Path $Root "state.txt"

$total = (Get-Content $Source | Where-Object { $_ -match ':' -and $_.Trim() -ne '' }).Count
$offset = $StartAt
if (Test-Path $stateFile) {
  $saved = [int](Get-Content $stateFile -TotalCount 1)
  if ($saved -gt $offset) { $offset = $saved }
}

Write-Output ("start offset={0} total={1} take={2} chunk={3} workers={4}" -f $offset, $total, $Take, $Chunk, $Workers)

while ($offset -lt $total) {
  # disk guard
  $free = [math]::Round((Get-PSDrive C).Free / 1GB, 2)
  if ($free -lt 2) {
    Get-ChildItem $env:TEMP -Directory -Filter "cdp-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    $free = [math]::Round((Get-PSDrive C).Free / 1GB, 2)
    if ($free -lt 2) { Write-Output ("STOP disk free={0}GB" -f $free); break }
  }

  $outDir = Join-Path $Root ("batch_{0:d5}" -f $offset)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $log = & $poolScript -Source $Source -PoolFile $PoolFile -Skip $offset -Take $Take -Chunk $Chunk -Workers $Workers -Pace $Pace -OutDir $outDir 2>&1
  $sw.Stop()
  $tail = ($log | Select-Object -Last 2) -join " | "
  Write-Output $tail

  $rows = 0; $val = 0; $suc = 0; $closed = 0; $r403 = 0; $r429 = 0
  foreach ($line in ($log | Where-Object { $_ -like "TOTAL*" })) {
    if ($line -match 'rows=(\d+)') { $rows = [int]$matches[1] }
    if ($line -match 'validated=(\d+)') { $val = [int]$matches[1] }
    if ($line -match 'success=(\d+)') { $suc = [int]$matches[1] }
    if ($line -match 'closed=(\d+)') { $closed = [int]$matches[1] }
    if ($line -match '403=(\d+)') { $r403 = [int]$matches[1] }
    if ($line -match '429=(\d+)') { $r429 = [int]$matches[1] }
  }
  $el = [math]::Round($sw.Elapsed.TotalSeconds)
  $rec = [pscustomobject]@{
    offset = $offset; rows = $rows; validated = $val; success = $suc; closed = $closed
    r403 = $r403; r429 = $r429; secs = $el
    rowsPerMin = if ($el -gt 0) { [math]::Round(60.0 * $rows / $el, 1) } else { 0 }
    time = (Get-Date).ToString("s")
  }
  $rec | ConvertTo-Json -Compress | Add-Content -Path $progress -Encoding UTF8

  $offset += $Take
  Set-Content -Path $stateFile -Value $offset -Encoding ascii

  Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-ChildItem $env:TEMP -Directory -Filter "cdp-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

Write-Output ("DONE offset={0} total={1}" -f $offset, $total)
