param(
  [Parameter(Mandatory=$true)][string]$RunDir,
  [string]$OutFile = ".\classification.txt",
  [string]$RecheckFile = ".\recheck.txt",
  [int]$ClosedUsable = 0
)

# Aggregate every JSONL in a run directory into category counts.
# Precedence is intentional: a later better verdict overwrites an earlier weak one.
# Output: counts, one raw sample per category, and a recheck queue for unresolved rows.

$priority = @{ success = 9; validated = 8; closed = 7; link = 6; unable = 5; other = 4; '429' = 3; '403' = 2; 'NO_POST' = 0 }
$map = @{}

foreach ($f in (Get-ChildItem $RunDir -Filter *.jsonl -ErrorAction SilentlyContinue)) {
  Get-Content $f.FullName | ForEach-Object {
    try { $o = $_ | ConvertFrom-Json } catch { return }
    if (-not $o.email) { return }
    $b = [string]$o.body
    # success without zss is not a hit; treat as no-session and keep it out of the valid bucket
    $withSession = ($o.success -eq $true) -and ($o.zss -ne $null) -and (@($o.zss).Count -gt 0 -or $o.profileStatus -eq 200)
    $cat =
      if ($withSession) { 'success' }
      elseif ($o.success -eq $true) { 'nosession' }
      elseif ($o.validated -or $b -like '*or password you ent*') { 'validated' }
      elseif ($b -like '*has been closed*') { 'closed' }
      elseif ($b -like '*require_link*' -or $b -like '*magic_link*' -or $b -like '*login link*') { 'link' }
      elseif ($o.unable -or $b -like '*unable to log you in*') { 'unable' }
      elseif ($o.status -eq 403) { '403' }
      elseif ($o.status -eq 429 -or $b -like '*Too Many Requests*') { '429' }
      elseif ($o.result -eq 'NO_POST' -or -not $o.status) { 'NO_POST' }
      else { 'other' }

    $cur = $map[$o.email]
    if (-not $cur -or $priority[$cat] -gt $priority[$cur.cat]) {
      $map[$o.email] = @{ cat = $cat; body = $b.Substring(0, [Math]::Min(160, $b.Length)); status = $o.status }
    }
  }
}

$lines = @()
foreach ($grp in ($map.GetEnumerator() | Group-Object { $_.Value.cat } | Sort-Object Count -Descending)) {
  $lines += ("{0} = {1}" -f $grp.Name, $grp.Count)
}
$lines += ""
$lines += ("unique = {0}" -f $map.Count)
$lines += ""
foreach ($grp in ($map.GetEnumerator() | Group-Object { $_.Value.cat })) {
  $sample = $grp.Group | Select-Object -First 1
  $lines += ("--- {0} sample: {1} [{2}] {3}" -f $grp.Name, $sample.Key, $sample.Value.status, $sample.Value.body)
}

$recheck = $map.GetEnumerator() | Where-Object { $_.Value.cat -in @('403', '429', 'NO_POST', 'other') } | ForEach-Object { $_.Key }

$lines | Set-Content -Encoding utf8 $OutFile
$recheck | Set-Content -Encoding ascii $RecheckFile

Get-Content $OutFile
Write-Output ""
Write-Output ("recheck queue: {0} rows -> {1}" -f @($recheck).Count, $RecheckFile)
Write-Output "Verified = success + validated + closed. cat 4-7 are not verdicts."
