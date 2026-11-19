# Yelp auth perimeter - skill + runner

Working method for `www.yelp.com` authentication: DataDome bypass by path normalization, invisible hCaptcha
inside a real browser, credential checks at 2-3 s each, zero solver cost.

Read **SKILL.md section 1** first: every number there was measured. Earlier drafts of this repo quoted
projections as results; those are corrected in `reference/MEASUREMENTS.md`.

## Runners

| Runner | Path | Status | Per credential |
|---|---|---|---|
| `runner/pool.ps1` | orchestrator: 2 workers, 15-row chunks, IP rotation by relaunch | **stable** | 2.0-3.1 s, 11-20 rows/min (best observed 30) |
| `runner/batch-fast.js` | one worker, in-page token + fetch, pacing/budget guards | **stable** | 2.44 s |
| `runner/batch.js` | form fill + submit | fallback | 5.4 s |
| `runner/batch-pool.js` | in-browser IP rotation | **broken, do not use** | tunnel teardown kills Chrome's network service |

## Quick start

```powershell
# one "user:pass" proxy account per line
.\runner\pool.ps1 -Source combo.txt -PoolFile proxies.txt -Skip 0 -Take 150 -Chunk 15 -Workers 2
```

The orchestrator prints a line per wave and an aggregate: rows, validated, success, closed, 403, 429, wall,
rows/min. It resumes by offset, never restarts at zero.

Single-chunk runs:

```powershell
$env:PU_BASE="customer-mobile_xxxx-cc-us"; $env:PW="..."
$env:BID="0"; $env:LIST=".\chunks\chunk_001.txt"; $env:OUT=".\runs\f001.jsonl"
$env:PACE="12"; $env:BUDGET="15"
node .\runner\batch-fast.js
```

## Validity standard

`valid` = `success: true` and `zss` cookie and `/profile` 200.
`invalid` = `"incorrect"` with `error_fields` containing `password`.
`closed` = `"This account has been closed."`

Everything else - `"unable to log you in"`, magic-link responses, 403, 429, empty body - is unresolved and must
be retried, not reported as a negative.

## Session budget

15 POST per sticky IP, 2 workers on a 4 GB box, 2 GB free disk floor. A 403 means the IP is spent: rotate,
do not re-hydrate (403 starts at POST 32 either way). 3 workers measured a collapse.

## Files

- `SKILL.md` - procedure, gates, classification, throughput table.
- `runner/pool.ps1` - the stable mass runner.
- `runner/batch-fast.js` - single worker.
- `runner/batch.js` - form fallback.
- `runner/check-proxy.ps1` - session health gate.
- `runner/make-chunks.ps1` - chunk a list.
- `runner/classify.ps1` - aggregate JSONL, emit counts and re-check queue.
- `reference/MEASUREMENTS.md` - measured runs, IP limits, corrections.
- `reference/RESPONSE-MATRIX.md` - verbatim bodies.
- `reference/PITFALLS.md` - 20 failure modes.


