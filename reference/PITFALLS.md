# Pitfall catalogue

Each entry is a failure that actually occurred, with the symptom that identifies it and the fix. Ordered by
cost. If a symptom matches, apply the fix without investigating further.

## P1 — Global `input[name=password]` selector

Symptom: 60–75 s per credential, `NO_POST`, or a magic-link response even though a password was supplied.
Cause: the page ships three elements with `id=password` inside different forms (`ajax-login`, `magic-link-login`,
a hidden variant). `document.querySelector` grabs the first, submits the wrong form.
Fix: scope to `#ajax-login`; if the password input is not inside it, click `.login-with-password-link` first.

## P2 — Reading responses with `Fetch` interception

Symptom: empty bodies almost exclusively on the successful logins.
Cause: success navigates to `/` and `Fetch.getResponseBody` loses the resource when the frame swaps.
Fix: capture on `Network.loadingFinished` → `Network.getResponseBody`, before the navigation completes.

## P3 — Reading the alert from the DOM

Symptom: a plausible-looking streak of "5/5 success" that does not survive re-testing.
Cause: the AJAX flow does not change `uniqueRequestId`; `.alert-message` keeps the previous text.
Fix: bind every body to its `requestId` and classify only from that JSON.

## P4 — Assuming the login page opens in password mode

Symptom: `fire()` returns 0, or `"We had some trouble sending a login link"`.
Cause: default view is email + magic link. The password form is revealed by a click.
Fix: `if (!p || f.offsetParent === null) click('.login-with-password-link')` and re-query.

## P5 — Direct `el.value = x`

Symptom: magic-link response, empty `password` in `postData`.
Cause: React controlled inputs ignore direct assignment.
Fix: native setter + `input` + `change` events, as in `runner/batch.js`.

## P6 — Hydration judged by HTTP 200

Symptom: `fire()` returns 0, page length 200–260 kB.
Cause: 200 arrives on the pre-hydration shell; `#ajax-login` is not in the DOM yet.
Fix: require `#ajax-login` **and** `outerHTML.length > 400000`. Hydrated pages are 1.0–1.3 MB.

## P7 — One sticky session for a whole list

Symptom: rising 403s, then mass `NO_POST`; throughput collapses from 5.5 s to 75 s per row.
Cause: session reputation decays monotonically after ~8–40 submissions.
Fix: 8 credentials per session, new random `sessid`, rotate the proxy account, kill Chrome between chunks.

## P8 — Treating `"unable to log you in"` as a wrong password

Symptom: an entire chunk "validated" while nothing was actually compared.
Cause: captcha/risk fail-closed returns the same generic body for every input.
Fix: separate counters; retry those rows on a fresh session.

## P9 — Counting `NO_POST` as a negative

Symptom: success rate drifts down as sessions degrade, hits get lost.
Fix: every `NO_POST` goes to a re-check queue and is re-run before reporting.

## P10 — Restarting a capped run from zero

Symptom: duplicated work, burned IPs, inconsistent counts.
Fix: `timecap` records the index; resume with `-Skip <last index>`.

## P11 — Chaining shell metacharacters in passwords

Symptom: `#`, `.`, `~`, `+`, `!` in passwords silently truncated or expanded (PowerShell treats `#` as a comment
start when unquoted, and `+` inside proxy credentials breaks auth).
Fix: keep credentials in ASCII files, `Set-Content -Encoding ascii`, pass into JS via `JSON.stringify`.

## P12 — More than 3 Chrome instances

Symptom: 40 % `NO_POST` on every slot at once.
Cause: hydration starves on 4 vCPU.
Fix: 3 slots maximum, one proxy account per slot, isolated relay/CDP ports (`8986+BID`, `9306+BID`).

## P13 — Trusting the proxy account instead of the session

Symptom: an account that tested "200" burns out after one chunk, then a fresh session on the same account is 403.
Cause: the account is a pool; the session decides the IP.
Fix: gate on `check-proxy.ps1` per session, not per account. Three `ddok=false` in a row = retire the account
for the next hour.

## P14 — Capsolver for this target

Symptom: `We don't support this service` for `HCaptchaTask*`.
Cause: Capsolver dropped hCaptcha (2026); the two reCAPTCHA keys in `yConfig` are stale.
Fix: no solver. The invisible widget solves itself in headful Chrome with
`--disable-blink-features=AutomationControlled` and a real UA.

## P15 — Reporting headers from the 403 page

Symptom: "missing HSTS/CSP" that a triager can disprove in one request.
Fix: inspect headers on `/login/` (envoy), not on the DataDome 403.

## P16 - Treating "incorrect" as a definitive wrong password

Symptom: a run reports clean negatives, then the same pair returns equire_link / "sent an email with a login
link" on another session.
Cause: Yelp routes some accepted credentials into an email-confirmation flow instead of issuing a session, and
the fail-closed body uses the same "incorrect" wording.
Fix: bucket equire_link / magic_link / "login link" as 
eeds-email, not invalid. Only success: true
plus a zss cookie plus /profile 200 is alid. Keep the two negative buckets separate:
password-rejected vs confirmation-required.

## P17 - Quoting design targets as measurements

Symptom: a report claims 1.5 s/credential on a runner that was never benchmarked end to end; the next run
produces 12 s and the whole finding looks inflated.
Fix: the fast runner has an acceptance gate (SKILL.md section 7). Until it passes, publish form-path numbers only.

## P18 - Wrong hCaptcha field name

Symptom: every fast-path POST returns "We're unable to log you in right now." with a token of ~1900 chars that
was minted a second earlier. Looks like the token is rejected.
Cause: the endpoint expects hcaptcha_response (underscore). h-captcha-response and
g-recaptcha-response are ignored, so the request is treated as tokenless and fail-closes.
Fix: send csrftok, email, password, hcaptcha_response - exactly those four. Confirm once by hooking
XMLHttpRequest on a real form submit and printing the body's field names.

## P19 - Assuming /login/newajax has no rate limit

Symptom: 429 from row ~16 in a fast run, after a previous run did 41 POST with none.
Cause: the limit is per rolling minute, not per session. Spaced requests hide it; a 2 s/row burst exposes it.
Fix: hold <=12 POST/min (paceDelay in batch-fast.js) and stop at 28 POST per IP.

## P20 - Running several Chrome instances on a small box

Symptom: three workers finish 15 rows in 291 s with 9x403 and 6 unresolved; single-worker does 28 rows in 155 s.
Cause: hydration and hCaptcha contention, plus all workers competing for the same proxy pool.
Fix: one worker. Scale with clean IPs and sequential 28-row chunks, not parallel browsers.
