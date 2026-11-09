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
      return { reason: 'La petición no pasó por Cloudflare Access (no hay token). Revisa que exista una aplicación de Access para este dominio sin path, con política Allow.' };
    }
    if (!jwks || !cfAud) {
      return { reason: 'Faltan CF_ACCESS_TEAM_DOMAIN o CF_ACCESS_AUD en la configuración de la app.' };
    }
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: `https://${cfTeamDomain}`, audience: cfAud });
      if (!payload.email) return { reason: 'El token de Cloudflare Access no contiene email.' };
      return { email: String(payload.email).toLowerCase() };
    } catch (e) {
      console.warn(`[auth] Cloudflare Access token rejected: ${e.code ?? ''} ${e.message}`);
      return { reason: `Token de Cloudflare Access no válido (${e.code ?? e.message}). Revisa CF_ACCESS_TEAM_DOMAIN y que CF_ACCESS_AUD sea el AUD de la aplicación principal.` };
    }
  }

  const viewer = async (req, res, next) => {
    const { email, reason } = await identify(req);
    if (!email) return res.status(403).send(`Acceso denegado: ${reason}`);
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
