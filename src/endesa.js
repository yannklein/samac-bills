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
  const headers = { 'User-Agent': UA, Referer: referer, Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8', ...(cookie ? { Cookie: cookie } : {}) };
  const res = await fetchImpl(url, { headers, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.ok && isPdf(buf)) return buf;

  const text = buf.toString('utf8');
  // PDF embedded as base64 (data: URI or JSON field)
  const b64 = text.match(/JVBERi0[A-Za-z0-9+/=\\\r\n]{100,}/)?.[0];
  if (b64) {
    const decoded = Buffer.from(b64.replace(/\\[rn]|\\|[\r\n]/g, ''), 'base64');
    if (isPdf(decoded)) return decoded;
  }
  // Viewer page: follow the most likely embedded PDF location(s)
  for (const candidate of pdfCandidates(text, res.url || url).slice(0, 4)) {
    const r = await fetchImpl(candidate, { headers: { ...headers, Referer: res.url || url }, redirect: 'follow' });
    const b = Buffer.from(await r.arrayBuffer());
    if (r.ok && isPdf(b)) return b;
  }
  throw new EndesaError(`The download did not return a PDF (${describe(res, text)}).`);
}
