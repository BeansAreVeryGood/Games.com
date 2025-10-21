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
    // perform the request but do not auto-follow redirects so we can rewrite Location
    const resp = await fetch(target, {
      headers: { 'user-agent': req.headers['user-agent'] || 'hapara-proxy' },
      redirect: 'manual'
    });

    // Build proxy base (use this host so rewritten links point back to this proxy)
    const proxyBase = `${req.protocol}://${req.get('host')}`;

    // If upstream redirected, rewrite Location to proxy -> preserves flow through proxy
    const upstreamLocation = resp.headers.get('location');
    if (upstreamLocation && resp.status >= 300 && resp.status < 400) {
      // resolve relative Location against target
      const abs = new URL(upstreamLocation, target).toString();
      const proxied = proxyBase + '/proxy?url=' + encodeURIComponent(abs);
      res.setHeader('Location', proxied);
      return res.status(resp.status).end();
    }

    // copy most headers but strip framing/CSP
    const rawHeaders = resp.headers.raw ? resp.headers.raw() : {};
    removeBlockingHeaders(rawHeaders, res);

    // handle Set-Cookie specially: strip Domain and Secure for local http testing and
    // drop SameSite=None if it would require Secure — this is a local-dev convenience
    const upstreamCookies = rawHeaders['set-cookie'] || [];
    if (upstreamCookies.length) {
      const rewritten = upstreamCookies.map(c => {
        let s = c.replace(/;\s*Domain=[^;]+/gi, '');
        s = s.replace(/;\s*Secure/gi, ''); // remove Secure for local http dev
        // remove SameSite=None which would require Secure in modern browsers
        s = s.replace(/;\s*SameSite=None/gi, '');
        return s;
      });
      res.setHeader('Set-Cookie', rewritten);
    }

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();

    // If HTML, rewrite absolute URLs in href/src/action and meta refresh to route via proxy.
    if (isHtmlContent(contentType)) {
      let text = await resp.text();

      // Replace absolute http(s) URLs in href/src/action attributes with proxied equivalents
      // Note: simple regex-based rewrite; covers most straightforward cases.
      text = text.replace(/(href|src|action)=("|\')https?:\/\/([^"\']+)("|\')/gi, (m, attr, q1, url, q2) => {
        const full = 'https://' + url;
        const abs = /^(https?:\/\/)/i.test(url) ? (url.match(/^https?:\/\//i) ? url : ('https://' + url)) : ('https://' + url);
        // reconstruct proxied URL
        const proxied = proxyBase + '/proxy?url=' + encodeURIComponent(abs);
        return `${attr}=${q1}${proxied}${q2}`;
      });

      // also rewrite occurrences starting with http:// or https:// inside JS or other attributes
      text = text.replace(/https?:\/\/[A-Za-z0-9\-\._~:\/\?#\[\]@!$&'()*+,;=%]+/gi, (m) => {
        // avoid rewriting already proxied links
        if (m.startsWith(proxyBase + '/proxy?url=')) return m;
        return proxyBase + '/proxy?url=' + encodeURIComponent(m);
      });

      // send rewritten HTML
      res.setHeader('Content-Type', contentType);
      return res.status(resp.status).send(text);
    }

    // binary / other content: forward as buffer
    const buffer = await resp.buffer();
    res.send(buffer);
  } catch (err) {
    console.error('proxy error', err && err.stack || err);
    res.status(502).send('proxy error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('proxy listening on', port));