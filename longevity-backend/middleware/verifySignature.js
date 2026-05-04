// middleware/verifySignature.js
//
// HMAC-SHA256 signature verification for inbound webhooks.
// Both Exotel and Interakt sign their requests; we MUST verify before processing.

import crypto from 'crypto';

/**
 * Generic HMAC verifier. Use as Express middleware.
 *
 * @param {object} opts
 * @param {string} opts.secret       The shared secret
 * @param {string} opts.headerName   Header carrying the signature
 * @param {string} [opts.algorithm]  Default 'sha256'
 * @param {(buf: Buffer) => string} [opts.payloadFor] Function to extract canonical payload string
 */
export function hmacVerify({ secret, headerName, algorithm = 'sha256', payloadFor }) {
  return (req, res, next) => {
    const provided = req.get(headerName);
    if (!provided) {
      return res.status(401).json({ error: 'missing signature' });
    }

    // express.raw() must be used on this route so req.body is a Buffer
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const canonical = payloadFor ? payloadFor(raw) : raw;

    const expected = crypto
      .createHmac(algorithm, secret)
      .update(canonical)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    // Re-parse JSON for the route handler now that we've verified
    try { req.body = JSON.parse(raw.toString('utf8')); }
    catch { req.body = raw.toString('utf8'); }

    next();
  };
}

// Pre-configured middlewares for each vendor
export const verifyExotel = hmacVerify({
  secret: process.env.EXOTEL_WEBHOOK_SECRET,
  headerName: 'x-exotel-signature',
});

export const verifyInterakt = hmacVerify({
  secret: process.env.INTERAKT_WEBHOOK_SECRET,
  headerName: 'x-interakt-signature',
});
