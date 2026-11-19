# Measurements

Every row was observed on production `www.yelp.com`, 2026-11-19/20. No projections.

## Fast path (`batch-fast.js` / `pool.ps1`)

| Run | Rows | Validated | Closed | Valid | 429 | 403 | Unknown | Wall | Rows/min |
|---|---|---|---|---|---|---|---|---|---|
| 1 worker, paced 12/min, budget 28 | 28 | 25 | 3 | 0 | 0 | 0 | 0 | 155 s | 10.8 |
| 1 worker, un-paced, 50 rows | 50 | 26 | 1 | 0 | 0 | 23 (from row 32) | 0 | 278 s | 10.8 |
| 2 workers, 15-row chunks (run A) | 30 | 29 | 1 | 0 | 0 | 0 | 0 | 59 s | 30.5 |
| 2 workers, 15-row chunks (run B) | 30 | 29 | 1 | 0 | 0 | 0 | 0 | 93 s | 19.4 |
| 1 worker, 15-row chunk | 15 | 10 | 2 | 3 | 0 | 0 | 0 | 402 s* | - |
| 2 workers via pool.ps1 | 30 | 26 | 1 | 1 | 0 | 0 | 1 | 159 s | 10.9 |
| 3 workers in parallel | 26 | 0 | 0 | 0 | 0 | 0 | 26 | 482 s | 3.2 |

\* includes 4 failed rotations, each burning a fresh IP; see `batch-pool.js` note.

Detail, 28-row paced run: `avgTokMs` 1506, `avgPostMs` 931, `paceSleepMs` 71381 (46 % of wall), `tokFail` 0.

## Form path (`batch.js`)

| Row set | Rows | Time | Per row | NO_POST | 403 | 429 |
|---|---|---|---|---|---|---|
| Fresh session | 24 | 130 s | 5.4 s | 0 | 0 | 1 |
| Fresh session | 8 | 45 s | 5.6 s | 0 | 0 | 0 |
| Rows 9-24 | 15 | 100 s | 6.7 s | 0 | 0 | 0 |
| Past row 40 | 20 | 220 s | 11 s | 4 | 2 | 0 |
| Burned IP | 8 | 440 s | 55 s | 8 | 0 | 0 |

## IP limits

| Limit | Value | How it showed |
|---|---|---|
| POST per rolling minute | ~15 | un-paced burst: rows 16-19 -> 429, then recovery |
| POST per sticky IP | ~30 | first 403 at row 32; re-hydration at 15 and 30 did not help |
| Re-hydration effect on reputation | none | same IP, same 403 wall |
| Token bound to solving IP | no | token minted on IP-A, POST from IP-B: 200, but routed to magic-link |
| Parallel Chrome | 2 max | 3 workers: 26 rows / 482 s, 0 verdicts |

## Infrastructure limits

| Limit | Observed |
|---|---|
| Disk | 168 Chrome profiles = 6.85 GB; free space hit 0; Node threw ENOSPC and Chrome stalled |
| RAM | 4 GB total, 1.6 GB free with 3 Chrome instances |
| Fix | profile deleted on exit + `statfsSync` guard that aborts below 2 GB |

## Endpoint limits

| Endpoint | Load | Result |
|---|---|---|
| `POST /login/` | 200 from one datacenter IP | 15x200, 185x429, 0x403 |
| `POST /login/` | 50 from 5 mobile IPs | 50x200, 0x429 |
| `POST /login/newajax` | 41 spaced, one mobile IP | 41x200, 0x429 |
| `POST /login/newajax` | burst at 2 s/row | 429 at row 16 |
| `POST /login/newajax` | 28 paced at 12/min | 28x200, 0x429, 0x403 |

## Hit rate

| Sample | Rows | Valid |
|---|---|---|
| K2 sample | 227 | 1 |
| follow-up | 100 | 0 |
| one 15-row chunk | 15 | 3 |

The 3-hit chunk (all with `zss` and `/profile` 200):

```
bestip16@gmail.com:9625655
bethannfraser1@gmail.com:1236656b!
betterdays190@gmail.com:Grandkids171821
```

Do not extrapolate a hit rate below ~300 rows; the 3/15 chunk is an outlier, not a rate.

## What earlier drafts got wrong

| Claim | Correction |
|---|---|
| `newajax` has no rate limit (41 POST, 0x429) | 41 spaced POST passed; a 2 s/row burst 429'd at row 16. Limit ~15/min/IP. |
| 3 browsers give 3x throughput | 3 workers: 26 rows / 482 s, 0 verdicts. 4 GB RAM. |
| 5.4 s/credential sustained | that was 24 rows on a fresh IP; long sessions degrade to 11-55 s. |
| Re-hydrating refreshes the session | it does not; 403 starts at POST 32 either way. |
| Collapse was DataDome | two collapses were ENOSPC from 6.85 GB of Chrome profiles. |



