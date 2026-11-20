# Pitfall catalogue

Symptom -> cause -> fix. Each entry cost at least one run.

## 1. Wrong captcha field name

Symptom: every POST returns `"We're unable to log you in right now."` with a fresh 1900-char token.
Cause: the endpoint reads `hcaptcha_response` (underscore). `h-captcha-response` and `g-recaptcha-response`
are ignored, so the request is tokenless and fail-closes.
Fix: send exactly `csrftok`, `email`, `password`, `hcaptcha_response`.

## 2. Global password selector

Symptom: 60-75 s per credential, no POST, or a magic-link body.
Cause: three elements share `id=password` across different forms.
Fix: scope to `#ajax-login`; click `.login-with-password-link` if the password field is hidden.

## 3. Reading via Fetch interception

Symptom: empty bodies almost only on successes.
Cause: success navigates away and `Fetch.getResponseBody` loses the resource.
Fix: `Network.loadingFinished` -> `Network.getResponseBody`.

## 4. Reading the DOM alert

Symptom: a plausible "5/5 success" streak that does not reproduce.
Cause: the AJAX flow does not change `uniqueRequestId`; the alert element keeps the previous text.
Fix: bind every body to its `requestId`.

## 5. Hydration judged by HTTP 200

Symptom: submit does nothing, page length 200-260 kB.
Cause: 200 is the pre-hydration shell.
Fix: require `#ajax-login` and `outerHTML.length > 400000`.

## 6. One session for the whole list

Symptom: 403s climbing, then mass `NO_POST`.
Cause: ~30 POST per IP, then DataDome blocks.
Fix: 15 rows per IP, new session, new Chrome.

## 7. Treating "unable to log you in" as a wrong password

Symptom: a chunk "validates" while nothing was compared.
Cause: captcha fail-closed returns the same body for every input.
Fix: separate counter, retry on a fresh IP.

## 8. Counting an unresolved row as negative

Symptom: hit rate drifts down, real hits disappear.
Fix: `NO_POST`/403/429 go to a re-check queue.

## 9. Restarting a capped run from zero

Symptom: duplicated work, burned IPs, inconsistent counts.
Fix: resume from `state.txt` / `-Skip`.

## 10. Shell metacharacters in passwords

Symptom: `#`, `.`, `~`, `+`, `!` truncated, or proxy auth fails on `+`.
Fix: keep credentials in ASCII files, pass into JS via `JSON.stringify`.

## 11. Three Chrome instances

Symptom: 26 rows / 482 s, 0 verdicts, 20-80 s per row.
Cause: 4 GB RAM; one Chrome starves.
Fix: two workers maximum.

## 12. Trusting the proxy account instead of the session

Symptom: an account that tested 200 burns out after one chunk; a fresh session is 403.
Cause: the account is a pool; the session decides the IP.
Fix: health-gate per session.

## 13. Capsolver

Symptom: `We don't support this service` for `HCaptchaTask*`.
Fix: no solver. The invisible widget solves itself in headful Chrome with
`--disable-blink-features=AutomationControlled`.

## 14. Reporting headers from the 403 page

Symptom: "missing HSTS/CSP" that a triager disproves in one request.
Fix: inspect `/login/` (envoy), not the DataDome 403.

## 15. Treating "incorrect" as definitive

Symptom: the same pair returns `require_link` on another session.
Cause: Yelp routes some accepted credentials into email confirmation.
Fix: bucket link responses as `needs-email`. Only `success` + `zss` + `/profile` 200 is valid.

## 16. Quoting design targets as measurements

Symptom: a report claims a rate that the next run cannot reproduce.
Fix: every number must come from a recorded run in `MEASUREMENTS.md`.

## 17. Assuming `/login/newajax` has no rate limit

Symptom: 429 at row ~16 after an earlier run did 41 POST cleanly.
Cause: the limit is per rolling minute; spaced requests hide it.
Fix: 15 POST per IP.

## 18. Full temp disk

Symptom: 20-80 s per row, blank/stalled page, no 403/429, zero verdicts; Node may throw `ENOSPC`.
Cause: each run leaves a 50-100 MB Chrome profile in `%TEMP%`; 168 of them filled the volume.
Fix: delete `cdp-*` on exit and abort below 2 GB free.

## 19. Cross-IP token reuse

Symptom: token accepted but body is `"We had some trouble sending a login link"`.
Cause: minted on one IP, submitted from another.
Fix: mint and submit on the same IP; rotate between chunks.

## 20. In-browser IP rotation

Symptom: after rotating, four consecutive fresh IPs fail to hydrate.
Cause: destroying relay tunnels leaves Chrome's network service unable to reconnect.
Fix: rotate by relaunching Chrome (15-row chunks), not by switching upstream mid-session.

## 21. Reading 407 as a Yelp block

Symptom: every request on an account returns status 407 with `Access denied: traffic limit reached`.
Cause: Oxylabs account quota, not DataDome.
Fix: `check-proxy.ps1` labels it `QUOTA`; drop the account and rotate. Do not retry the same account.

## 22. Reusing a burned account because it once returned 200

Symptom: one worker is fine, the other produces 0 rows every wave; hit rate halves.
Cause: pool rotation selected by index, no per-session health check.
Fix: `pool.ps1` health-gates a fresh session before every chunk and skips non-200 accounts for the run.

## 23. Advancing the offset by the batch size

Symptom: `state.txt` jumps 150 while only 15 rows have records; hundreds of rows never run.
Cause: `run-all.ps1` incremented by `-Take` regardless of output.
Fix: advance by rows actually recorded, queue the shortfall in `missed.txt`, stop after 3 zero-row waves.

## 24. Dropping the password from evidence records

Symptom: `report.ps1` lists `email:` with an empty password for every hit.
Cause: the per-credential JSONL record omitted `pass`; only the summary carried it.
Fix: write `pass` on every record and dedupe hits on the pair, not the email.

## 25. Self-rendered hCaptcha widget

Symptom: token mints in 600-750 ms, correct field name, but every POST returns `"unable to log you in"`.
Cause: a widget rendered by the runner has no site `rqdata`; the token is issued but rejected server-side.
Fix: reuse the page's widget through `[data-hcaptcha-widget-id]`; only fall back to `hcaptcha.render` if it is absent.

## 26. Storing cookie count instead of cookie length

Symptom: `report.ps1` demotes real hits to `nosession` when `/profile` blips.
Cause: the record stored `zss.length` (count, usually 1) while the check expects a 30-char value.
Fix: store `zssLen` (max cookie value length) and gate on >=20, with `/profile` 200 as the second signal.

## 27. Looking for the widget in server HTML

Symptom: 23 saved login pages (6-983 KB, hydrated) have `data-hcaptcha-widget-id` = 0 and `rqdata` = 0,
while a live browser sometimes has the widget.
Cause: Yelp's own JS creates the widget div at runtime. It is never server-rendered.
Fix: judge widget presence only from a live DOM after hydration, never from HTML dumps or the first payload.
See `reference/IDENTITY.md`.

## 28. Letting the machine define the browser identity

Symptom: same runner, same list: `validated` on one box, `link` on another.
Cause: the runner set only `--lang` and `--window-size`; UA, UA-CH, `Accept-Language`, timezone, locale,
cores, memory and GL strings came from the OS. On the second fingerprint Yelp keeps the widget lazy, the
runner self-renders, the token has no site `rqdata`, and the server answers with a magic link.
Fix: pin `profiles/identity.json`, verify the Chrome build, run `identity.ps1 -Mode selftest` before a run.

## 29. Finishing a chunk that only returns links

Symptom: 15/15 rows `link`, 0 `validated`, offset advanced, queue grows.
Cause: the runner carried on after `armWidget()` returned `own:<id>`.
Fix: `batch-fast.js` aborts on `own:*` with `why=own-widget` and keeps the offset; `run-all.ps1` stops with
`FLOW-DEGRADED` when `link >= 80%` of a batch. `ALLOW_OWN=1` overrides.

## 30. Copying a Chrome profile without clearing locks

Symptom: Chrome on the copy shows a blank window or exits; CDP never becomes ready.
Cause: `SingletonLock`, `SingletonCookie`, `SingletonSocket` and `Default/LOCK` still point at the source path.
Fix: delete those four from the copy; `batch-fast.js` does it for `PROFILE_TEMPLATE`.
