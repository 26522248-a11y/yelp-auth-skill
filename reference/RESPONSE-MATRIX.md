# Response matrix — verbatim

Captured from `POST https://www.yelp.com/login/newajax`, headful Chrome over a US mobile proxy, 2026-11.
All rows HTTP 200 unless stated.

## 1. Valid credential — session issued

```
set-cookie: zss=-Z7p3hyqeXIXlucrKBE8kOMMIQ_-ag; Domain=.yelp.com; Max-Age=31536000
```
```json
{"errors": [], "error_fields": [], "success": true, "return_url": "https://www.yelp.com/"}
```
Follow-up: `GET /profile` → 200, `<title>Account Settings - Edit Your Profile - Yelp</title>`.

## 2. Wrong password — credential compared

```json
{"errors": ["The email address or password you entered is incorrect. <a class=\"js-password-reset-assist-submit\" href=/forgot>Click here</a> to have a password reset email sent to <span class=\"highlight2\">user@example.com</span>."],
 "error_fields": ["email", "password"], "success": false, "require_link": false, "magic_link": false}
```
The reset-link sentence is appended only when the address exists; `error_fields` is the reliable signal.

## 3. Account exists but is closed

```json
{"errors": ["This account has been closed."], "error_fields": [], "success": false}
```
Not a credential verdict — no password comparison, but it does confirm the address is registered.

## 4. Captcha / risk fail-closed (not a verdict)

```json
{"errors": ["We're unable to log you in right now.  Please try again later."], "error_fields": [], "success": false}
```
Same body for every input, every IP, every cookie when the token is missing. Retry.

## 5. DataDome

`HTTP/1.1 403`, body is the interstitial URL stub:
```json
{"url":"https://geo.captcha-delivery.com/interstitial/?initialCid=AHrlqAAAAAMAd4Y442QrbNoA..."}
```

## 6. App rate limit

`HTTP/1.1 429`
```html
<html><head><title>Too Many Requests</title></head><body><h1>429 Too Many Requests</h1>
```
Headers identify the app tier, not DataDome:
```
server: openresty/1.31.1.1
x-routing-service: routing-main--uswest2-5c69bd8797-hwhnm; site=www
```

## 7. Magic-link fallback (empty password submitted)

```json
{"errors": ["We had some trouble sending a login link to ..."], "success": false, "magic_link": true}
```
Means the client set `email` but not `password` — React ignored a direct `value` assignment.

## Path behaviour, same IP, same minute

| Path | Result |
|---|---|
| `GET /login` | 403 (1000/1000) |
| `GET /login/` | 200 (1000/1000) |
| `GET /login;` | 200 |
| `GET /login/%2e` | 200 |
| `GET /login/%2E` | 200 |
| `GET /login/.` | 404 |

Security headers on the envoy-served `/login/` (not on the DataDome 403): HSTS preload, CSP with
`object-src 'self'; base-uri 'self'`, `x-content-type-options: nosniff`. Do not report "missing headers"
based on the 403 page.
