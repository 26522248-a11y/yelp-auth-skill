# Measurements

All timings from production `www.yelp.com`, headful Chrome 141+, US mobile residential proxy, 2026-11-19.
These are the numbers the defaults in `SKILL.md` are derived from.

## Path bypass determinism

| Path | Requests | 403 | 200 | 404 |
|---|---|---|---|---|
| `/login` | 1000 | **1000** | 0 | 0 |
| `/login/` | 1000 | 0 | **1000** | 0 |
| `/login;` | 250 | 0 | 250 | 0 |
| `/login/%2e` | 250 | 0 | 250 | 0 |
| `/login/%2E` | 250 | 0 | 250 | 0 |
| `/login/.` | 250 | 0 | 0 | 250 |

Bypass is independent of IP reputation: identical results from datacenter and from a clean US mobile address
(`/login` 403 from mobile too).

## Endpoint capacity

| Test | Result |
|---|---|
| `POST /login/` from one datacenter IP | 15×200, 185×429, 0×403 |
| `POST /login/` from 5 mobile IPs | 50×200, 0×429, 0×403 |
| `POST /login/newajax` from one mobile IP | 41×200, 0×429, 0×403 |

Classic endpoint limits at ~15/IP. `newajax` showed no limit at 41.

## Credential validation

| Metric | Value |
|---|---|
| Convergence reached (server compared password) | 113/113 attempts on healthy sessions |
| Captcha dialogs raised | 0 |
| Solver spend | $0 |
| `zss` cookie issued on correct password | yes, 30 chars, `Domain=.yelp.com` |
| `/profile` after success | 200 |

## Rate by proxy condition

| Condition | s/credential | `NO_POST` |
|---|---|---|
| Fresh session, first 8 rows | 5.4 (p50) | 0 % |
| Same session, rows 9–40 | 6–9 | <2 % |
| Same session, rows 40+ | 12–20 | 20–40 % |
| Burned IP | 55–75 | 100 % |

## Browser count

| Slots | Behaviour |
|---|---|
| 1 | 5.4 s/credential |
| 3 | 6–8 s/credential aggregate, stable |
| 6 | hydrate starvation on 2–4 slots, ~40 % `NO_POST` |

## Chunk economics

8 credentials per chunk: 13 chunks per 100 rows, ~30 s Chrome/DataDome overhead per chunk, ~75 s of work per
chunk. ~10–12 min per 100 rows on one slot. Smaller chunks (4) cost 20 % more overhead but cut `NO_POST` to
near zero on a marginal IP pool; use 4 when `check-proxy.ps1` shows a mixed pool.

## Sampling noise

Blind hit rates on used combo lists: 1 valid per 227 rows and 0 valid per 100 rows in consecutive samples.
Do not extrapolate a hit rate from fewer than ~300 rows.
