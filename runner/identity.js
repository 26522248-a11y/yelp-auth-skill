// Identity pinning for the Yelp runner.
//
// Why this exists: whether Yelp mounts its own hCaptcha widget (site token, with
// rqdata) or leaves the runner to self-render one (no rqdata, token gets a magic
// link instead of a password verdict) is decided from browser identity, not from
// the machine being "good" or "bad". Everything the page can see has to match the
// reference machine: Chrome build, UA + client hints, languages, timezone, clock
// locale, viewport, screen, cores, memory, GL strings.
//
// modes:
//   node identity.js capture  [out.json]
//   node identity.js verify   [in.json]
//   node identity.js diff a.json b.json
//   node identity.js selftest [in.json]      apply then print what the page sees

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SITEKEY = '6660d4df-1884-4ac6-a933-e5f3bd460946';
const DEFAULTS = {
  viewport: { width: 900, height: 700, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 },
  acceptLanguage: 'en-US,en;q=0.9',
  languages: ['en-US', 'en'],
  timezone: 'America/Chicago',
  locale: 'en-US',
  platform: 'Win32',
  hardwareConcurrency: 2,
  deviceMemory: 8,
  webglVendor: 'Google Inc. (Microsoft)',
  webglRenderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withPage(fn, opts) {
  const udd = path.join(os.tmpdir(), 'id-' + Date.now());
  const port = 9400 + Math.floor(Math.random() * 300);
  const chrome = spawn(CHROME, [
    '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
    '--window-size=1000,800', '--lang=en-US', '--user-data-dir=' + udd, '--remote-debugging-port=' + port,
    ...(opts && opts.args ? opts.args : []), 'about:blank'
  ], { stdio: 'ignore' });
  try {
    let ver = null;
    for (let i = 0; i < 40; i++) { await sleep(500); try { ver = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json(); break; } catch (e) {} }
    if (!ver) throw new Error('cdp not ready');
    const t = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    let id = 0; const pend = new Map();
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const send = (method, params, sid) => new Promise(res => { const mid = ++id; pend.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId: sid })); });
    const a = await send('Target.attachToTarget', { targetId: t.id, flatten: true });
    const sid = a.result.sessionId;
    await send('Page.enable', {}, sid);
    const srv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html><title>id</title>'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    await send('Page.navigate', { url: 'http://127.0.0.1:' + srv.address().port + '/' }, sid);
    await sleep(700);
    const ev = async (e, awaitP) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: !!awaitP }, sid); return r.result && r.result.result ? r.result.result.value : null; };
    try { return await fn({ send, sid, ev, ver, chrome }); }
    finally { try { srv.close(); } catch (e) {} try { ws.close(); } catch (e) {} }
  } finally {
    try { chrome.kill(); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  }
}

function load(file) {
  const id = JSON.parse(fs.readFileSync(file || path.join(__dirname, '..', 'profiles', 'identity.json'), 'utf8'));
  return Object.assign({}, DEFAULTS, id, { viewport: Object.assign({}, DEFAULTS.viewport, id.viewport || {}) });
}

// Applied to every document before the page script runs.
function preloadScript(id) {
  return `(() => {
  const def = (o, k, v) => { try { Object.defineProperty(o, k, { get: () => v, configurable: true }); } catch (e) {} };
  def(navigator, 'platform', ${JSON.stringify(id.platform)});
  def(navigator, 'hardwareConcurrency', ${JSON.stringify(id.hardwareConcurrency)});
  def(navigator, 'deviceMemory', ${JSON.stringify(id.deviceMemory)});
  def(navigator, 'languages', Object.freeze(${JSON.stringify(id.languages)}));
  def(navigator, 'language', ${JSON.stringify(id.languages[0])});
  const gp = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return ${JSON.stringify(id.webglVendor)};
    if (p === 37446) return ${JSON.stringify(id.webglRenderer)};
    return gp.call(this, p);
  };
  const gp2 = WebGL2RenderingContext && WebGL2RenderingContext.prototype.getParameter;
  if (gp2) WebGL2RenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return ${JSON.stringify(id.webglVendor)};
    if (p === 37446) return ${JSON.stringify(id.webglRenderer)};
    return gp2.call(this, p);
  };
})();`;
}

async function apply(send, sid, idFile) {
  const id = load(idFile);
  await send('Network.setUserAgentOverride', {
    userAgent: id.ua,
    acceptLanguage: id.acceptLanguage,
    platform: id.platform,
    userAgentMetadata: Object.assign({}, id.uaMetadata, { platform: 'Windows', mobile: false })
  }, sid);
  await send('Emulation.setLocaleOverride', { locale: id.locale }, sid);
  await send('Emulation.setTimezoneOverride', { timezoneId: id.timezone }, sid);
  await send('Emulation.setDeviceMetricsOverride', Object.assign({}, id.viewport, { screenWidth: id.viewport.screenWidth, screenHeight: id.viewport.screenHeight }), sid);
  await send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: id.hardwareConcurrency }, sid);
  await send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': id.acceptLanguage } }, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: preloadScript(id) }, sid);
  return id;
}

async function capture(out) {
  const id = await withPage(async ({ send, sid, ev, ver }) => {
    const ua = await ev('navigator.userAgent');
    const brands = await ev('JSON.stringify(navigator.userAgentData ? navigator.userAgentData.brands : null)');
    const hi = await send('Runtime.evaluate', {
      expression: `navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(["platformVersion","architecture","bitness","model","uaFullVersion","fullVersionList"]).then(x=>JSON.stringify(x)) : "null"`,
      awaitPromise: true, returnByValue: true
    }, sid);
    const high = JSON.parse(hi.result.result.value);
    return {
      capturedAt: new Date().toISOString(),
      chromeVersion: ver.Browser.replace(/^Chrome\//, ''),
      ua,
      uaMetadata: {
        brands: JSON.parse(brands) || [],
        fullVersionList: (high && high.fullVersionList) || [],
        platformVersion: (high && high.platformVersion) || '10.0.0',
        architecture: (high && high.architecture) || 'x86',
        bitness: (high && high.bitness) || '64',
        model: ''
      },
      acceptLanguage: await ev('JSON.stringify(navigator.languages)').then(s => (JSON.parse(s) || ['en-US'])[0] + ',en;q=0.9'),
      languages: JSON.parse(await ev('JSON.stringify(navigator.languages)')),
      timezone: await ev('Intl.DateTimeFormat().resolvedOptions().timeZone'),
      locale: await ev('navigator.language'),
      platform: await ev('navigator.platform'),
      hardwareConcurrency: await ev('navigator.hardwareConcurrency'),
      deviceMemory: (await ev('navigator.deviceMemory')) || DEFAULTS.deviceMemory,
      webglVendor: (await ev(`(function(){var c=document.createElement('canvas').getContext('webgl');var d=c.getExtension('WEBGL_debug_renderer_info');return c.getParameter(d.UNMASKED_VENDOR_WEBGL)})()`)) || DEFAULTS.webglVendor,
      webglRenderer: (await ev(`(function(){var c=document.createElement('canvas').getContext('webgl');var d=c.getExtension('WEBGL_debug_renderer_info');return c.getParameter(d.UNMASKED_RENDERER_WEBGL)})()`)) || DEFAULTS.webglRenderer,
      viewport: DEFAULTS.viewport
    };
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(id, null, 2) + '\n');
  return id;
}

function flat(o, p, out) {
  out = out || {};
  for (const k of Object.keys(o)) {
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) flat(o[k], p ? p + '.' + k : k, out);
    else out[p ? p + '.' + k : k] = JSON.stringify(o[k]);
  }
  return out;
}

function diff(a, b) {
  const fa = flat(load(a)), fb = flat(load(b));
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  const rows = keys.filter(k => k !== 'capturedAt' && fa[k] !== fb[k]).map(k => ({ field: k, a: fa[k], b: fb[k] }));
  return rows;
}

async function selftest(inFile) {
  const id = load(inFile);
  const got = await withPage(async ({ send, sid, ev }) => {
    await apply(send, sid, inFile);
    await send('Page.reload', {}, sid);
    await sleep(600);
    return {
      ua: await ev('navigator.userAgent'),
      languages: await ev('JSON.stringify(navigator.languages)'),
      timezone: await ev('Intl.DateTimeFormat().resolvedOptions().timeZone'),
      locale: await ev('navigator.language'),
      platform: await ev('navigator.platform'),
      hc: await ev('navigator.hardwareConcurrency'),
      dm: await ev('navigator.deviceMemory'),
      view: await ev('innerWidth + "x" + innerHeight + "@" + screen.width + "x" + screen.height'),
      webgl: await ev(`(function(){var c=document.createElement('canvas').getContext('webgl');var d=c.getExtension('WEBGL_debug_renderer_info');return c.getParameter(d.UNMASKED_VENDOR_WEBGL)+'|'+c.getParameter(d.UNMASKED_RENDERER_WEBGL)})()`)
    };
  }, {});
  const checks = [
    ['ua', id.ua, got.ua],
    ['languages', JSON.stringify(id.languages), got.languages],
    ['timezone', id.timezone, got.timezone],
    ['locale', id.locale, got.locale],
    ['platform', id.platform, got.platform],
    ['hardwareConcurrency', id.hardwareConcurrency, got.hc],
    ['deviceMemory', id.deviceMemory, got.dm],
    ['viewport', id.viewport.width + 'x' + id.viewport.height + '@' + id.viewport.screenWidth + 'x' + id.viewport.screenHeight, got.view],
    ['webgl', id.webglVendor + '|' + id.webglRenderer, got.webgl]
  ];
  const bad = checks.filter(([k, w, g]) => String(w) !== String(g)).map(([k, w, g]) => ({ field: k, want: w, got: g }));
  console.log(JSON.stringify({ ok: bad.length === 0, bad, got }, null, 2));
  process.exit(bad.length ? 1 : 0);
}

module.exports = { load, apply, capture, diff, preloadScript };

if (require.main === module) (async () => {
  const mode = process.argv[2];
  const arg = process.argv[3];
  if (mode === 'capture') {
    const out = arg || path.join(__dirname, '..', 'profiles', 'identity.json');
    const id = await capture(out);
    console.log(JSON.stringify({ wrote: out, chromeVersion: id.chromeVersion, timezone: id.timezone, languages: id.languages }, null, 2));
  } else if (mode === 'verify') {
    const want = load(arg);
    const actual = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Item '%CHROME%').VersionInfo.ProductVersion".replace('%CHROME%', CHROME)], { encoding: 'utf8' }).trim();
    const critical = [];
    const warn = [];
    if (actual !== want.chromeVersion) critical.push({ field: 'chromeVersion', want: want.chromeVersion, got: actual });
    const culture = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Culture).Name'], { encoding: 'utf8' }).trim();
    if (culture.toLowerCase() !== String(want.locale).toLowerCase()) warn.push({ field: 'windowsLocale', want: want.locale, got: culture });
    console.log(JSON.stringify({ ok: critical.length === 0, critical, warn }, null, 2));
    process.exit(critical.length ? 1 : 0);
  } else if (mode === 'diff') {
    const rows = diff(process.argv[3], process.argv[4]);
    console.log(JSON.stringify({ identical: rows.length === 0, diffs: rows }, null, 2));
    process.exit(rows.length ? 1 : 0);
  } else if (mode === 'selftest') {
    const idFile = process.argv[3] || path.join(__dirname, '..', 'profiles', 'identity.json');
    await selftest(idFile);
  } else {
    console.log('usage: node identity.js capture|verify|diff|selftest');
    process.exit(2);
  }
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(2); });
