// Viewers come through Cloudflare Access (email one-time code); only ADMIN_EMAIL may edit.
// n8n calls /api/* on the internal network with a Bearer token.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { timingSafeEqual } from 'node:crypto';

export function makeAuth(config) {
  const { cfTeamDomain, cfAud, adminEmail, apiToken, devUserEmail } = config;
  const jwks = cfTeamDomain
    ? createRemoteJWKSet(new URL(`https://${cfTeamDomain}/cdn-cgi/access/certs`))
    : null;

  async function userEmail(req) {
    if (devUserEmail) return String(req.query.as || req.get('x-dev-user') || devUserEmail).toLowerCase();
    const token = req.get('cf-access-jwt-assertion');
    if (!token || !jwks) return null;
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: `https://${cfTeamDomain}`, audience: cfAud });
      return payload.email ? String(payload.email).toLowerCase() : null;
    } catch {
      return null;
    }
  }

  const viewer = async (req, res, next) => {
    const email = await userEmail(req);
    if (!email) return res.status(403).send('Acceso denegado (Cloudflare Access).');
    req.user = { email, isAdmin: email === adminEmail.toLowerCase() };
    res.locals.user = req.user;
    next();
  };

  const admin = (req, res, next) => {
    if (!req.user?.isAdmin) return res.status(403).send('Solo Yann puede hacer esto.');
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
