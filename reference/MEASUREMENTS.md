# Measurements

Every row is labelled **measured** or **corrected**. There are no projections in this file; if a number was not observed, it is not here.

## Measured â€” fast path (`batch-fast.js`), 2026-11-20

| Run | Rows | Validated | Closed | 429 | 403 | Unknown | Wall | Per credential |
|---|---|---|---|---|---|---|---|---|
| Un-paced, 50 rows | 50 | 26 | 1 | 0 | 23 (from row 32) | 0 | 278 s | 5.6 s |
| Paced 12/min, budget 28 | 28 | 25 | 3 | **0** | **0** | **0** | 155 s | **2.44 s** |
| Parallel 3 workers Ã— 25 | 15 | 0 | 0 | 0 | 9 | 6 | 291 s | 19 s â€” collapsed |

Paced run detail: `avgTokMs` 1506, `avgPostMs` 931, `paceSleepMs` 71381 (46 % of wall time is intentional
pacing), 0 `tokFail`.

## Measured â€” form path (`batch.js`), 2026-11-19

| Row set | Credentials | Time | Per credential | `NO_POST` | 403 | 429 |
|---|---|---|---|---|---|---|
| Fresh session | 24 | 130 s | **5.4 s** | 0 | 0 | 1 |
| Fresh session | 8 | ~45 s | 5.6 s | 0 | 0 | 0 |
| Same session, rows 9-24 | 15 | 100 s | 6.7 s | 0 | 0 | 0 |
| Session past row 40 | 20 | 220 s | 11 s | 4 | 2 | 0 |
| Burned IP | 8 | 440 s | 55 s | 8 | 0 | 0 |

## IP limits, measured

| Limit | Value | How it showed |
|---|---|---|
| POST per rolling minute | ~15 | un-paced burst: rows 16-19 â†’ 429, then recovery |
| POST per sticky IP | ~30 | first 403 at row 32; re-hydration at 15 and 30 did not help |
| Page re-hydration effect on IP reputation | none | same IP, same 403 wall |
| Parallel Chrome on 4 vCPU | unusable above 1 | 3 workers: 15 rows / 291 s, 9Ã—403, 6 unresolved |

## Endpoint limits

| Endpoint | Load | Result |
|---|---|---|
| `POST /login/` | 200 from one datacenter IP | 15Ã—200, 185Ã—429, 0Ã—403 |
| `POST /login/` | 50 from 5 mobile IPs | 50Ã—200, 0Ã—429, 0Ã—403 |
| `POST /login/newajax` | 41 spaced, one mobile IP | 41Ã—200, 0Ã—429 â€” **do not generalise: a 2 s/row burst hit 429 at row 16** |
| `POST /login/newajax` | 28 paced at 12/min | 28Ã—200, 0Ã—429, 0Ã—403 |

## Combo-list hit rate

| Sample | Rows | Valid |
|---|---|---|
| K2 sample | 227 | 1 |
| follow-up | 100 | 0 |

Do not extrapolate a hit rate below ~300 rows.

## Path determinism (3250 HEAD/GET, 2026-11-19)

| Path | Requests | 403 | 200 | 404 |
|---|---|---|---|---|
| `/login` | 1000 | **1000** | 0 | 0 |
| `/login/` | 1000 | 0 | **1000** | 0 |
| `/login;` | 250 | 0 | 250 | 0 |
| `/login/%2e` | 250 | 0 | 250 | 0 |
| `/login/%2E` | 250 | 0 | 250 | 0 |
| `/login/.` | 250 | 0 | 0 | 250 |

Identical from datacenter and clean US mobile: path-literal rule, not risk scoring.

## Envelope

`
rows_per_pass = clean_IPs * 28
time_per_worker_pass = 28 * 2.44 s + ~30 s startup  ~= 100 s
rate_per_worker = ~10-11 rows/min   (pacing, not CPU, is the binding constraint)
`

One worker on a 4-vCPU box. Three workers measured a collapse (15 rows / 291 s), so do not plan around
parallel Chrome; plan around a pool of clean IPs and sequential chunks.

## What the earlier draft got wrong

| Claim | Correction |
|---|---|
| `newajax` has no rate limit (41 POST, 0×429) | 41 spaced POST did pass; a 2 s/row burst 429'd at row 16. Limit ~15/min/IP. |
| 3 browsers give 3× throughput | measured collapse on 4 vCPU: 15 rows in 291 s. |
| 5.4 s/credential sustained | that was 24 rows on a fresh IP; a long session degrades to 11-55 s. |
| re-hydrating refreshes the session | it does not; 403 begins at POST 32 regardless of re-hydration. |

