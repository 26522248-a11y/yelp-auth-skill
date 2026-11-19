param(
  [Parameter(Mandatory=$true)][string]$Source,
  [int]$Skip = 0,
  [int]$Take = 100,
  [int]$Size = 8,                    # 8 credentials per sticky session
  [string]$OutDir = ".\chunks"
)

# Split a combo list into session-sized chunks. One chunk = one fresh proxy session = one browser run.
# Chunk 8 keeps the dirty-IP rate under ~2%. Do not raise it past 15 without measuring.

if (-not (Test-Path $Source)) { throw "no such file: $Source" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$lines = Get-Content $Source | Where-Object { $_ -match ':' -and $_.Trim() -ne '' } |
         Select-Object -Skip $Skip -First $Take

if ($lines.Count -eq 0) { throw "empty slice (skip=$Skip take=$Take)" }

$i = 0
for ($k = 0; $k -lt $lines.Count; $k += $Size) {
  $i++
  $lines | Select-Object -Skip $k -First $Size |
    Set-Content -Encoding ascii (Join-Path $OutDir ("chunk_{0:d3}.txt" -f $i))
}

Write-Output ("wrote {0} chunks ({1} credentials) to {2}" -f $i, $lines.Count, $OutDir)
Write-Output ("next: for each chunk, set BID/LIST/OUT/PU_BASE/PW and run runner/batch.js")
