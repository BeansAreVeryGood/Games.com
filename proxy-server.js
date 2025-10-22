const express = require('express');
const fetch = require('node-fetch'); // npm i node-fetch@2
const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));

function isHtmlContent(ct) { return ct && ct.toLowerCase().includes('text/html'); }

function removeBlockingHeaders(headers, out) {
  Object.keys(headers).forEach(name => {
    const lname = name.toLowerCase();
    if (lname === 'x-frame-options' || lname === 'content-security-policy') return;
    if (lname === 'set-cookie') return;
    const value = Array.isArray(headers[name]) ? headers[name][0] : headers[name];
    if (value) out.setHeader(name, value);
  });
}

app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('missing url');

  try {
    const resp = await fetch(target, {
      headers: { 'user-agent': req.headers['user-agent'] || 'hapara-proxy' },
      redirect: 'manual'
    });

    const proxyBase = `${req.protocol}://${req.get('host')}`;

    const upstreamLocation = resp.headers.get('location');
    if (upstreamLocation && resp.status >= 300 && resp.status < 400) {
      const abs = new URL(upstreamLocation, target).toString();
      const proxied = proxyBase + '/proxy?url=' + encodeURIComponent(abs);
      res.setHeader('Location', proxied);
      return res.status(resp.status).end();
    }

    const rawHeaders = resp.headers.raw ? resp.headers.raw() : {};
    removeBlockingHeaders(rawHeaders, res);

    const upstreamCookies = rawHeaders['set-cookie'] || [];
    if (upstreamCookies.length) {
      const rewritten = upstreamCookies.map(c => {
        let s = c.replace(/;\s*Domain=[^;]+/gi, '');
        s = s.replace(/;\s*Secure/gi, '');
        s = s.replace(/;\s*SameSite=None/gi, '');
        return s;
      });
      res.setHeader('Set-Cookie', rewritten);
    }

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();

    if (isHtmlContent(contentType)) {
      let text = await resp.text();

      text = text.replace(/(href|src|action)=("|\')([^"\']+)("|\')/gi, (m, attr, q, url, q2) => {
        if (/^(data:|mailto:|javascript:|#)/i.test(url)) return m;
        if (url.startsWith(proxyBase + '/proxy?url=')) return m;
        try {
          const abs = new URL(url, target).toString();
          const proxied = proxyBase + '/proxy?url=' + encodeURIComponent(abs);
          return `${attr}=${q}${proxied}${q2}`;
        } catch (e) { return m; }
      });

      text = text.replace(/https?:\/\/[A-Za-z0-9\-\._~:\/\?#\[\]@!$&'()*+,;=%]+/gi, (m) => {
        if (m.startsWith(proxyBase + '/proxy?url=')) return m;
        return proxyBase + '/proxy?url=' + encodeURIComponent(m);
      });

      res.setHeader('Content-Type', contentType);
      return res.status(resp.status).send(text);
    }

    const buffer = await resp.buffer();
    res.send(buffer);
  } catch (err) {
    console.error('proxy error', err && err.stack || err);
    res.status(502).send('proxy error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('proxy listening on', port));