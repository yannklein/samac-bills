// Download an Endesa bill PDF from the "DESCARGAR FACTURA" link of the notification email.
// No login needed: the landing page only asks for the contract holder's NIE/NIF.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const VALIDATE_URL = 'https://cloud.digital.endesaclientes.com/ajax-validacion-doc-aviso';

export class EndesaError extends Error {}

/** Find the href of the "DESCARGAR FACTURA" anchor in the email HTML. */
export function extractDownloadLink(html) {
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const [, href, inner] of String(html).matchAll(re)) {
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/DESCARGAR FACTURA/i.test(text)) return href.replace(/&amp;/g, '&');
  }
  return null;
}

/** Extract the two tokens the validation page embeds in its inline script. */
export function extractTokens(html) {
  const doc = html.match(/var\s+encDocumento\s*=\s*"([^"]+)"/)?.[1];
  const fac = html.match(/var\s+encFactura\s*=\s*"([^"]+)"/)?.[1];
  return doc && fac ? { encDocumento: doc, encFactura: fac } : null;
}

function cookieHeader(res, jar) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    jar.set(k.trim(), v);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function downloadBillPdf(link, nie, { fetchImpl = fetch } = {}) {
  if (!nie) throw new EndesaError('ENDESA_NIE is not configured.');
  if (!/^https:\/\/[\w.-]*endesaclientes\.com\//.test(link)) {
    throw new EndesaError('The link is not an endesaclientes.com link.');
  }
  const jar = new Map();

  const page = await fetchImpl(link, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!page.ok) throw new EndesaError(`The download page answered ${page.status} (expired link?).`);
  const html = await page.text();
  const tokens = extractTokens(html);
  if (!tokens) throw new EndesaError('Tokens not found on the download page (expired link or page changed?).');

  const body = 'data=' + encodeURIComponent(JSON.stringify({ Documento: nie, ...tokens }));
  const res = await fetchImpl(VALIDATE_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: page.url,
      Origin: 'https://cloud.digital.endesaclientes.com',
      Cookie: cookieHeader(page, jar),
    },
    body,
  });
  const pdfUrl = cleanUrl(await res.text());
  if (!res.ok || !pdfUrl.startsWith('https://')) {
    throw new EndesaError(`Endesa rejected the document (wrong NIE or expired link): ${pdfUrl.slice(0, 120)}`);
  }
  return fetchPdf(pdfUrl, { referer: page.url, cookie: cookieHeader(res, jar), fetchImpl });
}

/** The validation endpoint may return the URL JSON-quoted or HTML/JS-escaped. */
export function cleanUrl(text) {
  return String(text).trim().replace(/^"|"$/g, '')
    .replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
}

const isPdf = (buf) => buf.subarray(0, 5).toString() === '%PDF-';

/** Merge Set-Cookie headers of a response into a "k=v; k2=v2" cookie string. */
function mergeCookies(cookie, res) {
  const jar = new Map((cookie || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => [c.split('=')[0], c.slice(c.indexOf('=') + 1)]));
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

const unescapeJs = (s) => s.replace(/\\(['"\\/])/g, '$1');

/** String variables the server rendered into the page: var x = '...'; */
function pageVars(html) {
  const vars = {};
  for (const m of html.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*;/g)) {
    if (!(m[1] in vars)) vars[m[1]] = unescapeJs(m[2] ?? m[3] ?? '');
  }
  return vars;
}

/** Same logic as the page: issue date from param "v" (aux), else today (Madrid). */
export function emissionDateFrom(aux, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).replace(/-/g, '');
  if (aux == null || aux === 'null') return today;
  const v = aux.replace("'", '-');
  const eml = v.split('eml-')[1];
  if (eml !== undefined) return eml.substring(0, 8);
  const retos = v.split('retosmds:')[1];
  if (retos !== undefined) return retos.substring(8, 16);
  return today;
}

/** Evaluate a JS expression made only of string literals, known variables and "+". Null if anything else. */
export function evalConcat(expr, vars) {
  let out = '';
  let rest = expr.trim();
  const re = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*))\s*(\+|$)/;
  while (rest) {
    const m = rest.match(re);
    if (!m) return null;
    if (m[3] !== undefined) {
      if (!(m[3] in vars)) return null;
      out += vars[m[3]];
    } else {
      out += unescapeJs(m[1] ?? m[2]);
    }
    rest = rest.slice(m[0].length);
    if (!m[4]) break;
  }
  return rest.trim() ? null : out;
}

/** Endesa's descargarFacturaAD.html builds the PDF URL in JavaScript: rebuild it the same way. */
export function servletUrlFromPage(html, baseUrl, now = new Date()) {
  const m = html.match(/billUrl\s*=\s*([^;]*DownloadDocumentServlet[^;]*);/);
  if (!m) return null;
  const vars = pageVars(html);
  vars.emissionDate = emissionDateFrom(vars.aux, now);
  const rel = evalConcat(m[1], vars);
  if (!rel) return null;
  try {
    return new URL(rel, baseUrl).href;
  } catch {
    return null;
  }
}


/** Candidate PDF locations inside an HTML viewer page, most likely first. */
export function pdfCandidates(html, baseUrl) {
  const found = [];
  const add = (u) => {
    try {
      const abs = new URL(cleanUrl(u), baseUrl).href;
      if (/^https?:/.test(abs) && !found.includes(abs)) found.push(abs);
    } catch { /* not a URL */ }
  };
  for (const m of html.matchAll(/<(?:iframe|embed|object|frame)\b[^>]*?(?:src|data)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/gi)) add(m[1]);
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']*(?:\.pdf|pdf|descarg|download|factura)[^"']*)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/["'](https?:\/\/[^"'\s]+?\.pdf[^"'\s]*)["']/gi)) add(m[1]);
  return found;
}

function describe(res, text) {
  const u = new URL(res.url || 'https://unknown/');
  const title = text.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim();
  const snippet = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `HTTP ${res.status}, ${res.headers.get('content-type') ?? 'no content-type'}, ${u.host}${u.pathname}` +
    (title ? `, title "${title}"` : '') + (snippet ? `, text "${snippet}"` : '');
}

async function fetchPdf(url, { referer, cookie, fetchImpl }) {
  const headers = { 'User-Agent': UA, Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8' };
  const res = await fetchImpl(url, { headers: { ...headers, Referer: referer, ...(cookie ? { Cookie: cookie } : {}) }, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.ok && isPdf(buf)) return buf;

  const text = buf.toString('utf8');
  const pageUrl = res.url || url;
  const jar = mergeCookies(cookie, res);
  // PDF embedded as base64 (data: URI or JSON field)
  const b64 = text.match(/JVBERi0[A-Za-z0-9+/=\\\r\n]{100,}/)?.[0];
  if (b64) {
    const decoded = Buffer.from(b64.replace(/\\[rn]|\\|[\r\n]/g, ''), 'base64');
    if (isPdf(decoded)) return decoded;
  }
  // Loader page: the URL is built in JavaScript (DownloadDocumentServlet), else follow embedded links
  const servlet = servletUrlFromPage(text, pageUrl);
  const candidates = [...(servlet ? [servlet] : []), ...pdfCandidates(text, pageUrl).filter((c) => c !== servlet)];
  const tried = [];
  for (const candidate of candidates.slice(0, 4)) {
    const r = await fetchImpl(candidate, { headers: { ...headers, Referer: pageUrl, ...(jar ? { Cookie: jar } : {}) }, redirect: 'follow' });
    const b = Buffer.from(await r.arrayBuffer());
    if (r.ok && isPdf(b)) return b;
    tried.push(describe(r, b.toString('utf8')));
  }
  const err = new EndesaError(`The download did not return a PDF (${describe(res, text)}${tried.length ? `; then tried: ${tried.join(' | ')}` : ''}).`);
  err.debugHtml = text;
  throw err;
}
