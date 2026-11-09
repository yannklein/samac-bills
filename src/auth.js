// Viewers come through Cloudflare Access (email one-time code); only ADMIN_EMAIL may edit.
// n8n calls /api/* on the internal network with a Bearer token.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { timingSafeEqual } from 'node:crypto';

export function makeAuth(config) {
  const { cfTeamDomain, cfAud, adminEmail, apiToken, devUserEmail } = config;
  const jwks = cfTeamDomain
    ? createRemoteJWKSet(new URL(`https://${cfTeamDomain}/cdn-cgi/access/certs`))
    : null;

  /** Returns { email } or { reason } explaining why the visitor was refused. */
  async function identify(req) {
    if (devUserEmail) return { email: String(req.query.as || req.get('x-dev-user') || devUserEmail).toLowerCase() };
    const token = req.get('cf-access-jwt-assertion');
    if (!token) {
      return { reason: 'The request did not go through Cloudflare Access (no token). Check there is an Access application for this hostname with an empty path and an Allow policy.' };
    }
    if (!jwks || !cfAud) {
      return { reason: 'CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD is missing in the app configuration.' };
    }
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: `https://${cfTeamDomain}`, audience: cfAud });
      if (!payload.email) return { reason: 'The Cloudflare Access token has no email.' };
      return { email: String(payload.email).toLowerCase() };
    } catch (e) {
      console.warn(`[auth] Cloudflare Access token rejected: ${e.code ?? ''} ${e.message}`);
      return { reason: `Invalid Cloudflare Access token (${e.code ?? e.message}). Check CF_ACCESS_TEAM_DOMAIN, and that CF_ACCESS_AUD is the AUD of the main application.` };
    }
  }

  const viewer = async (req, res, next) => {
    const { email, reason } = await identify(req);
    if (!email) return res.status(403).send(`Access denied: ${reason}`);
    req.user = { email, isAdmin: email === adminEmail.toLowerCase() };
    res.locals.user = req.user;
    next();
  };

  const admin = (req, res, next) => {
    if (!req.user?.isAdmin) return res.status(403).send('Only Yann can do this.');
    next();
  };

  const api = (req, res, next) => {
    const got = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(apiToken || '');
    if (!apiToken || got.length !== want.length || !timingSafeEqual(got, want)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };

  return { viewer, admin, api };
}
