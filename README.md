# Yelp auth perimeter â€” skill + runner

Working method for `www.yelp.com` authentication: DataDome bypass by path normalization, invisible hCaptcha
handled inside a real browser, credential checks at 1.5-5.5 s each, zero solver cost.

Read **SKILL.md Â§1** first: it separates measured throughput from design targets. The earlier draft of this repo
quoted projections as results, which is exactly the flakiness this version removes.

## Runners

| Runner | Path | Status | Per credential |
|---|---|---|---|
| `runner/batch-fast.js` | one hydrated page, own hCaptcha widget, `fetch` per credential | **measured** | **2.44 s** (28 rows, 0Ã—429, 0Ã—403) |
| `runner/batch.js` | form fill + submit, capture at network layer | measured | 5.4 s |

The fast runner holds `<=12` POST per rolling minute and stops at `28` POST per IP, because measurement showed
429 at row 16 and 403 at row 32. Effective throughput is ~10-11 rows/min per worker; that is pacing, not CPU.

## Quick start

```powershell
$env:PU_BASE = "customer-mobile_xxxxxxxx-cc-us"
$env:PW      = "proxy-password"

.\runner\check-proxy.ps1                      # CLEAN before anything else
.\runner\make-chunks.ps1 -Source combo.txt -Take 100 -Size 8

# fast path: 28 rows per IP, 12 POST/min
$env:BID="0"; $env:LIST=".\chunks\chunk_001.txt"; $env:OUT=".\runs\f001.jsonl"
$env:PACE="12"; $env:BUDGET="28"
node .\runner\batch-fast.js

# fallback path
$env:BID="0"; $env:LIST=".\chunks\chunk_001.txt"; $env:OUT=".\runs\c001.jsonl"
node .\runner\batch.js

.\runner\classify.ps1 -RunDir .\runs
```

## Validity standard

`valid` = `success: true` **and** `zss` cookie **and** `/profile` 200.
`invalid` = `"incorrect"` with `error_fields` containing `password`.
`closed` = `"This account has been closed."`

Everything else â€” `"unable to log you in"`, magic-link responses, 403, 429, empty body â€” is unresolved and must
be retried, not reported as a negative. Yelp sometimes routes an accepted password to an email confirmation
instead of a session; that is `needs-email`, not `invalid`.

## Session budget

28 POST per sticky IP and 12 POST per rolling minute, one worker on a 4-vCPU box. A 403 means the IP is spent: rotate, do not re-hydrate. Re-hydration does not reset IP reputation (403 starts at POST 32 either way). Three Chrome instances on this box measured a collapse.

## Reference

- `reference/MEASUREMENTS.md` â€” fast and form path numbers, IP limits, what the earlier draft got wrong.
- `reference/RESPONSE-MATRIX.md` â€” verbatim bodies for every outcome, path table, headers.
- `reference/PITFALLS.md` â€” 20 failure modes with symptom â†’ fix.



