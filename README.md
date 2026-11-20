# Yelp credential pipeline

Fast and stable credential validation against `www.yelp.com`: DataDome path bypass, invisible hCaptcha inside a real
browser, no solver, 15 rows per IP, 2 workers, per-chunk proxy health gate.

| Metric | Measured |
|---|---|
| Per credential | 2.0-3.1 s |
| Rows per minute | 11-30 |
| 429 / 403 on a clean 15-row chunk | 0 / 0 |
| Hit rate on used combo lists | ~1.2 % |

## Why it is stable

Five failure modes are designed out:

1. **Wrong captcha field** - `hcaptcha_response`, not `h-captcha-response`. The wrong name looks exactly like a
   rejected token.
2. **Wrong IP budget** - 15 POST per IP. 429 starts at ~16/min, 403 at ~32/IP.
3. **Too many browsers** - 2 workers. A third starves on 4 GB RAM and yields 0 verdicts.
4. **Full temp disk** - profile deleted on exit, hard stop below 2 GB free. A full disk looked like DataDome for hours.
5. **Dead accounts reused** - every chunk health-gates a fresh session first; non-200 accounts are skipped and the
   run stops instead of burning the rest of the list.

## Requirements

- Windows 10/11, PowerShell 5.1.
- **Node >= 22** (global `fetch`, `WebSocket`, `statfsSync`).
- Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` or `$env:CHROME`.
  The build must equal `profiles/identity.json` (`identity.ps1 -Mode verify`).
- Oxylabs-style sticky proxy accounts, `customer-mobile_<id>-cc-us:<password>`, one per line.
- 4 GB RAM, >= 2 GB free disk.

`407 traffic limit reached` is the Oxylabs account quota, not a Yelp block. Expect to rotate accounts.

## Run

```powershell
.\runner\identity.ps1 -Mode verify         # exact Chrome build, stops on mismatch
.\runner\identity.ps1 -Mode selftest       # UA/lang/tz/viewport/GL must reach the page
# proxies.txt = user:pass per line; combo.txt = email:password per line
.\runner\check-proxy.ps1 -Accounts (Get-Content .\proxies.txt)
.\runner\smoke.ps1 -PoolFile .\proxies.txt -Control "<verified hit>"
.\runner\run-all.ps1 -Source .\combo.txt -PoolFile .\proxies.txt -Take 150 -Chunk 15 -Workers 2
.\runner\report.ps1  -RunDir .\runs -HitsFile .\hits.txt -OutCsv .\classified.csv
```

Identity is pinned from `profiles/identity.json`. Without it a second machine inherits its own
locale/timezone/UA, Yelp keeps the captcha widget lazy, the token loses `rqdata`, and every row comes
back as a magic link. `run-all.ps1` stops with `FLOW-DEGRADED` instead of advancing the offset in that
case. Copy `profiles/base.zip` + `profiles/identity.json` from the reference machine, then use
`-ProfileTemplate .\profiles\base`. Details: `reference/IDENTITY.md`.

Results: `runs/<batch>/w*.jsonl` (evidence), `runs/progress.jsonl`, `runs/state.txt` (resume), `runs/missed.txt`
(rows from an out-of-order dead chunk, deduplicated). Re-run the queue as a normal source:

```powershell
.\runner\run-all.ps1 -Source .\runs\missed.txt -PoolFile .\proxies.txt -Root .\runs\retry
```

Three consecutive 0-row waves stop the run without moving `state.txt`.

## Validity

`valid` = `success: true` + `zss` cookie (>=20 chars) + `GET /profile` 200. `"incorrect"` with `error_fields` is a
server-compared rejection. `closed` means the email exists but the account is closed. Link/unable/403/407/429 are
unresolved, never "invalid".

## Files

```
SKILL.md                    full method, constants, prerequisites, verification, failure playbook
runner/batch-fast.js        worker (Chrome + relay + CDP + token factory + fetch)
runner/pool.ps1             2-worker orchestrator, 15-row chunks, account health gate
runner/run-all.ps1          resumable full-list runner, missed queue, dead-pool stop
runner/check-proxy.ps1      session health gate
runner/smoke.ps1            6-row post-change acceptance test
runner/report.ps1           verdict aggregation, CSV + hits export
runner/identity.js          capture/apply pinned identity at CDP level
runner/identity.ps1         capture, verify, diff, selftest, seed/pack a golden profile
reference/MEASUREMENTS.md   measured rates and limits
reference/IDENTITY.md       why the widget differs across machines, how to pin it
reference/PITFALLS.md       failure catalogue, 30 modes, symptom -> fix
profiles/identity.json      reference Chrome build, UA, language, timezone, viewport, GL
examples/                   sample list, proxy file, redacted evidence record
```

Sample files use fake credentials; real lists are gitignored.
