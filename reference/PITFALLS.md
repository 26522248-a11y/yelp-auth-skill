# Pitfall catalogue

Each entry is a failure that actually occurred, with the symptom and the fix. If a symptom matches, apply the
fix without investigating further.

## P1 - Global `input[name=password]` selector

Symptom: 60-75 s per credential, `NO_POST`, or a magic-link response even though a password was supplied.
Cause: three elements share `id=password` in different forms (`ajax-login`, `magic-link-login`, a hidden one).
`document.querySelector` grabs the first and submits the wrong form.
Fix: scope to `#ajax-login`; if the password input is not inside it, click `.login-with-password-link` first.

## P2 - Reading responses with `Fetch` interception

Symptom: empty bodies almost exclusively on successful logins.
Cause: success navigates to `/` and `Fetch.getResponseBody` loses the resource when the frame swaps.
Fix: capture on `Network.loadingFinished` -> `Network.getResponseBody`.

## P3 - Reading the alert from the DOM

Symptom: a plausible streak of "5/5 success" that does not survive re-testing.
Cause: the AJAX flow does not change `uniqueRequestId`; `.alert-message` keeps the previous text.
Fix: bind every body to its `requestId`.

## P4 - Assuming the login page opens in password mode

Symptom: `fire()` returns 0, or `"We had some trouble sending a login link"`.
Cause: default view is email + magic link.
Fix: click `.login-with-password-link` and re-query.

## P5 - Direct `el.value = x`

Symptom: magic-link response, empty `password` in `postData`.
Cause: React controlled inputs ignore direct assignment.
Fix: native setter plus `input` and `change` events.

## P6 - Hydration judged by HTTP 200

Symptom: `fire()` returns 0, page length 200-260 kB.
Cause: 200 arrives on the pre-hydration shell.
Fix: require `#ajax-login` and `outerHTML.length > 400000`. Hydrated pages are 1.0-1.3 MB.

## P7 - One session for a whole list

Symptom: rising 403s, then mass `NO_POST`.
Cause: session reputation decays after ~30 POST.
Fix: 15 rows per session, new random `sessid`, new Chrome process.

## P8 - Treating `"unable to log you in"` as a wrong password

Symptom: a whole chunk "validated" while nothing was compared.
Cause: captcha fail-closed returns the same body for every input.
Fix: separate counters; retry on a fresh session.

## P9 - Counting `NO_POST` as a negative

Symptom: success rate drifts down, hits disappear.
Fix: every `NO_POST` goes to a re-check queue.

## P10 - Restarting a capped run from zero

Symptom: duplicated work, burned IPs, inconsistent counts.
Fix: resume with `-Skip <last index>`.

## P11 - Shell metacharacters in passwords

Symptom: `#`, `.`, `~`, `+`, `!` silently truncated, or proxy auth fails on `+`.
Fix: keep credentials in ASCII files, pass through `JSON.stringify`.

## P12 - Running three Chrome instances

Symptom: 26 rows in 482 s, zero verdicts.
Cause: 4 GB RAM; one Chrome starves and never hydrates.
Fix: two workers maximum.

## P13 - Trusting the proxy account instead of the session

Symptom: an account that tested 200 burns out after one chunk, then a fresh session is 403.
Cause: the account is a pool; the session decides the IP.
Fix: gate on `check-proxy.ps1` per session.

## P14 - Capsolver for this target

Symptom: `We don't support this service` for `HCaptchaTask*`.
Fix: no solver. The invisible widget solves itself in headful Chrome with
`--disable-blink-features=AutomationControlled`.

## P15 - Reporting headers from the 403 page

Symptom: "missing HSTS/CSP" that a triager disproves in one request.
Fix: inspect headers on `/login/`, not the DataDome 403.

## P16 - Treating "incorrect" as a definitive wrong password

Symptom: a run reports clean negatives, then the same pair returns `require_link` on another session.
Cause: Yelp routes some accepted credentials into an email-confirmation flow.
Fix: bucket `require_link` / `magic_link` / "login link" as `needs-email`. Only `success` + `zss` +
`/profile` 200 is valid.

## P17 - Quoting design targets as measurements

Symptom: a report claims 1.5 s/credential on a runner that was never benchmarked end-to-end.
Fix: every number must come with a measured run in `reference/MEASUREMENTS.md`.

## P18 - Wrong hCaptcha field name

Symptom: every fast-path POST returns `"We're unable to log you in right now."` with a fresh 1900-char token.
Cause: the endpoint expects `hcaptcha_response` (underscore). `h-captcha-response` is ignored, so the request is
tokenless and fail-closes.
Fix: send exactly `csrftok`, `email`, `password`, `hcaptcha_response`. Confirm once by hooking
`XMLHttpRequest` on a real form submit and printing field names.

## P19 - Assuming /login/newajax has no rate limit

Symptom: 429 from row ~16 in a fast run, after another run did 41 POST with none.
Cause: the limit is per rolling minute, not per session. Spaced requests hide it.
Fix: 15 POST per IP, then rotate.

## P20 - Full temp disk

Symptom: rows take 20-80 s, Chrome shows a blank or stalled page, 0 verdicts, no 403/429. Node may throw
`ENOSPC`.
Cause: every run leaves a 50-100 MB Chrome profile in `%TEMP%`; 168 of them filled the volume.
Fix: delete `cdp-*` on exit, and abort at startup when free space is below 2 GB.

## P21 - Cross-IP token reuse

Symptom: token mints fine, POST returns 200, but the body is `"We had some trouble sending a login link"`
instead of a password verdict.
Cause: token minted on IP-A and submitted from IP-B. The token itself is accepted, but the flow switches to
email confirmation.
Fix: mint and submit on the same IP. Rotate between chunks, not inside a chunk.
