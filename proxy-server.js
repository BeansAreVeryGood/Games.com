const express = require('express');
const fetch = require('node-fetch'); // npm i node-fetch@2
const app = express();

// simple health check for the frontend
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

function isHtmlContent(ct) {
  return ct && ct.toLowerCase().includes('text/html');
}

function removeBlockingHeaders(headers, out) {
  Object.keys(headers).forEach(name => {
    const lname = name.toLowerCase();
    if (lname === 'x-frame-options' || lname === 'content-security-policy') return;
    if (lname === 'set-cookie') return; // handled separately
    const value = Array.isArray(headers[name]) ? headers[name][0] : headers[name];
    if (value) out.setHeader(name, value);
  });
}

app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('missing url');

  try {
    // do not auto-follow redirects so we can rewrite Location
    const resp = await fetch(target, {
      headers: { 'user-agent': req.headers['user-agent'] || 'hapara-proxy' },
      redirect: 'manual'
    });

    const proxyBase = `${req.protocol}://${req.get('host')}`;

    // rewrite upstream redirect location to route through proxy
    const upstreamLocation = resp.headers.get('location');
    if (upstreamLocation && resp.status >= 300 && resp.status < 400) {
      const abs = new URL(upstreamLocation, target).toString();
      const proxied = proxyBase + '/proxy?url=' + encodeURIComponent(abs);
      res.setHeader('Location', proxied);
      return res.status(resp.status).end();
    }

    const rawHeaders = resp.headers.raw ? resp.headers.raw() : {};
    removeBlockingHeaders(rawHeaders, res);

    // rewrite Set-Cookie for local dev: remove Domain/Secure/SameSite=None (insecure — dev only)
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

      // rewrite href/src/action attributes to go through proxy
      text = text.replace(/(href|src|action)=("|\')([^"\']+)("|\')/gi, (m, attr, q, url, q2) => {
        // skip data:, mailto:, javascript:, anchors and already-proxied links
        if (/^(data:|mailto:|javascript:|#)/i.test(url)) return m;
        if (url.startsWith(proxyBase + '/proxy?url=')) return m;
        try {
          const abs = new URL(url, target).toString();
          const proxied = proxyBase + '/proxy?url=' + encodeURIComponent(abs);
          return `${attr}=${q}${proxied}${q2}`;
        } catch (e) {
          return m;
        }
      });

      // rewrite absolute URLs inside JS/other places (best-effort)
      text = text.replace(/https?:\/\/[A-Za-z0-9\-\._~:\/\?#\[\]@!$&'()*+,;=%]+/gi, (m) => {
        if (m.startsWith(proxyBase + '/proxy?url=')) return m;
        return proxyBase + '/proxy?url=' + encodeURIComponent(m);
      });

      res.setHeader('Content-Type', contentType);
      return res.status(resp.status).send(text);
    }

    // non-HTML: forward as binary
    const buffer = await resp.buffer();
    res.send(buffer);
  } catch (err) {
    console.error('proxy error', err && err.stack || err);
    res.status(502).send('proxy error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('proxy listening on', port));