/**
 * Public transport-security policy document (#374).
 *
 * Mobile clients fetch this at launch to learn which SPKI pins to trust and
 * whether the deployment enforces TLS, so pin rotation does not require an app
 * release. Deliberately unauthenticated: a client must be able to read it
 * before it has a token, and every value in it is already public.
 */
import { Router } from 'express';
import type { IRouter } from 'express';
import { getPinningPolicy } from '../lib/certificatePinning.js';
import { hstsHeaderValue, isTlsEnforced } from '../lib/transportSecurity.js';

export const securityRouter: IRouter = Router();

securityRouter.get('/transport-policy', (_req, res) => {
  const pinning = getPinningPolicy();

  res.setHeader('Cache-Control', `public, max-age=${pinning.maxAgeSeconds}`);

  res.json({
    tls: {
      required: isTlsEnforced(),
      minimumVersion: 'TLSv1.2',
      hsts: hstsHeaderValue(),
    },
    pinning: {
      enforced: pinning.enforced,
      hosts: pinning.hosts,
      pins: pinning.pins,
      backupPins: pinning.backupPins,
      maxAgeSeconds: pinning.maxAgeSeconds,
      reportUri: pinning.reportUri,
    },
  });
});
