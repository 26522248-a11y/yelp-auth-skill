# Identity pinning - why one machine gets the widget and another does not

## The widget is not in the page

Every saved login page from the reference machine has zero `data-hcaptcha-widget-id` and zero
`rqdata`:

| File | Size | widget-id | rqdata | api.js?render |
|---|---|---|---|---|
| `login.html` | 234 KB | 0 | 0 | 1 |
| `lp2.html` | 983 KB (hydrated) | 0 | 0 | 1 |
| `mob.html` | 232 KB | 0 | 0 | 1 |
| 20 more | 6-527 KB | 0 | 0 | 0-1 |

Only `https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=on` is present. So the
widget cannot be "missing from the new machine's HTML" - it is **created at runtime by Yelp's own
JavaScript**, by calling `hcaptcha.render()` into a div. `batch-fast.js` then reads
`[data-hcaptcha-widget-id]` off that div.

That means the real question is: *what makes Yelp's JS call render on one machine and stay lazy on
the other?*

## What decides it

Yelp's JS is the same bytes in both cases. What differs is the risk/experiment input the page
gets:

| Signal | Reference machine | Typical new box | Where it comes from |
|---|---|---|---|
| Chrome build + UA-CH | 158.0.8127.37, `Win32`, full version list | whatever Chrome is installed | runner passes none |
| `Accept-Language` | `en-US,en` | OS locale, e.g. `vi-VN,vi` | OS, not the runner |
| Timezone / `Intl` locale | `America/Chicago`, `en-US` | e.g. `Asia/Ho_Chi_Minh` | OS |
| Viewport / screen / cores / memory | 900x700, 2 cores, 4 GB, Basic Render Driver | real hardware | OS |
| Cookies + cached bundle | warm visits from the same path | empty throwaway profile | runner creates a new `%TEMP%` profile every run |

`batch-fast.js` only ever set `--lang=en-US` and `--window-size`. Everything else was inherited
from the machine, so the same runner produces two different browser fingerprints. On the reference
box that fingerprint lands in the variant where Yelp mounts the widget early; on the new box it
lands in the lazy variant.

A sixth factor is server-side: the exit IP (country, ASN, reputation) is part of the bucket. That
one cannot be cloned locally. It is also why the behaviour can change on the same machine after a
proxy pool change.

## Why a self-rendered widget is the wrong outcome

A div the runner creates has no site `rqdata`. Yelp still mints a token (1.8-2.0 k chars) and
returns HTTP 200, but does not compare the password - it emails a login link. That is `link`, not
`validated` and not `success`.

`batch-fast.js` now records `widget.own` and aborts the chunk on `own:*` unless `ALLOW_OWN=1`, so a
bad identity costs one page load instead of 15 POSTs.

## Make machine B behave like machine A

Identity lives in `profiles/identity.json` (captured, committed). The runner loads it automatically
and pins UA, UA-CH, `Accept-Language`, languages, timezone, locale, platform, viewport, screen,
`hardwareConcurrency`, `deviceMemory` and the WebGL vendor/renderer before the page script runs.

On the new machine:

```powershell
# 1. install the exact Chrome build named in profiles\identity.json
.\runner\identity.ps1 -Mode verify       # hard fail on a different Chrome build

# 2. prove the overrides take effect in a real page
.\runner\identity.ps1 -Mode selftest     # must print ok: true

# 3. optional: warm cookies/cache from this machine's own IP path
$env:PROXY_HOST="..."; $env:PROXY_PORT="..."; $env:PROXY_USER="..."; $env:PROXY_PASS="..."
.\runner\identity.ps1 -Mode seed
```

Copy `profiles/base.zip` from the reference machine to the new one, expand it to `profiles/base`,
and run with `-ProfileTemplate .\profiles\base` so every chunk starts from the same warm profile
instead of an empty one. The runner strips `Singleton*`/`LOCK` from the copy.

`run-all.ps1` and `pool.ps1` take `-Identity` and `-ProfileTemplate` and stop if the Chrome build
does not match.

## If identity is matched and the widget is still absent

Then the difference is IP-side, and no local setting fixes it. Options, in order:

1. Move the new machine's proxy to the reference country/ASN class (residential, same country).
2. Keep `ALLOW_OWN=1` and treat `link` as "email exists", not "password valid".
3. Use the submit path for that pool: it forces Yelp to render the widget at submit time, so it is
   immune to this whole class of drift.

Do not fake the timezone to the proxy country without also moving the IP - a `Asia/Ho_Chi_Minh`
clock behind a US exit is its own mismatch.

## What cannot be copied

- **Cookies across machines**: Chrome cookies are DPAPI-encrypted per machine+user. The copied
  profile keeps cache, `Local Storage`, `Service Worker` and `Code Cache`; cookies are re-issued on
  the next visit. Run `-Mode seed` on each machine when cookies matter.
- **IP bucket**: see above.
- **Screen/GPU strings of a physical box** when the new one has a real GPU. The pins cover the JS
  level; `Basic Render Driver` in `identity.json` is a spoofed value, not a hardware requirement.

## Verify, do not assume

Both checks are objective and take seconds:

```powershell
.\runner\identity.ps1 -Mode diff -A profiles\identity.json -B other.json
node -e "console.log(require('./runner/identity').diff('profiles/identity.json','profiles/identity.json').length)"
```

Zero rows = the browser is the same. If rows remain, the widget difference is not identity and the
next stop is the failure playbook in `SKILL.md` plus the submit path.
