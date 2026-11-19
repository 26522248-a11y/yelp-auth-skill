# Yelp auth perimeter — skill + runner

A reusable playbook for exercising `www.yelp.com` authentication at speed: DataDome bypass by path
normalization, invisible hCaptcha auto-solve in headful Chrome over CDP, and reliable credential validation.

Everything is measured on production, 2026-11. Full procedure: **SKILL.md**.

## Why it is fast

| Decision | Effect |
|---|---|
| Submit to `/login/newajax` instead of `/login` | JSON responses, 0×429 across 41 POST from a single IP |
| Keep the hydrated page between failed attempts | 1.6 s vs 5.5 s per credential |
| 8 credentials per fresh sticky session | `NO_POST` stays under 2 %, versus 40 % on a long session |
| No captcha solver | invisible widget auto-solves, 113/113, zero cost |
| Classify from captured JSON, never the DOM | no phantom results |

Measured: **5.4 s per credential** sustained, ~10–12 min per 100 credentials on one browser, ~6–8 min across
three browsers.

## Layout

```
SKILL.md                  procedure, gates, classification, reporting format
runner/batch.js           relay + headful Chrome + CDP, chunk runner, JSONL evidence
runner/check-proxy.ps1    session health gate (CLEAN / DIRTY / DEAD)
runner/make-chunks.ps1    slice a combo list into session-sized chunks
runner/classify.ps1       aggregate JSONL, emit counts + recheck queue
reference/                verbatim response bodies, pitfall catalogue
```

## Quick start

```powershell
$env:PU_BASE = "customer-mobile_xxxxxxxx-cc-us"
$env:PW      = "proxy-password"

.\runner\check-proxy.ps1                      # must print CLEAN
.\runner\make-chunks.ps1 -Source combo.txt -Take 100 -Size 8

$env:BID="0"; $env:LIST=".\chunks\chunk_001.txt"; $env:OUT=".\runs\c001.jsonl"
node .\runner\batch.js

.\runner\classify.ps1 -RunDir .\runs
```

One chunk = one fresh session. Kill Chrome and change `sessid` between chunks. Re-run the `recheck.txt`
queue on a clean session before reporting.

## Result categories

`success` (valid, session issued) · `validated` (server compared the password) · `closed` (address exists,
account closed) · `unable` (captcha fail-closed, not a verdict) · `403` · `429` · `NO_POST` (unknown).

Verified = success + validated + closed. Only the first three may be reported as outcomes.

## Campaign reference

400 credentials: 333 validated-wrong, 22 closed, 1 valid, 26 unresolved. Blind hit rate on a used combo list
≈ 0.25 %. Zero captcha spend.

## Notes

- Session cookie is `zss`; `/profile` returns 200 on a live session and is the success proof.
- `/login` is 403 on every IP; `/login/`, `/login;`, `/login/%2e` are 200. `/login/.` is 404.
- Capsolver has no hCaptcha support (2026). Any hCaptcha solver key is unnecessary for this target.
