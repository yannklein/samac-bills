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
  const pdfUrl = (await res.text()).trim();
  if (!res.ok || !pdfUrl.startsWith('https://')) {
    throw new EndesaError(`Endesa rejected the document (wrong NIE or expired link): ${pdfUrl.slice(0, 120)}`);
  }

  const pdf = await fetchImpl(pdfUrl, { headers: { 'User-Agent': UA, Referer: page.url, Cookie: cookieHeader(res, jar) } });
  const buf = Buffer.from(await pdf.arrayBuffer());
  if (!pdf.ok || buf.subarray(0, 5).toString() !== '%PDF-') {
    throw new EndesaError(`The download did not return a PDF (HTTP ${pdf.status}).`);
  }
  return buf;
}
