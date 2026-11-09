import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadBillPdf, pdfCandidates } from '../src/endesa.js';

const PDF = Buffer.from('%PDF-1.4 fake pdf body');
const LINK = 'https://click.digital.endesaclientes.com/?qs=1';
const html = (body, title = 'Factura') => `<html><head><title>${title}</title></head><body>${body}</body></html>`;

/** Fake Endesa: landing page -> validation answer -> whatever `routes` serve. */
function fakeEndesa(validationAnswer, routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (url === LINK) {
      const r = new Response('var encDocumento = "D"; var encFactura = "F";');
      Object.defineProperty(r, 'url', { value: 'https://cloud.digital.endesaclientes.com/validacion-doc-aviso?f=1' });
      return r;
    }
    if (url.endsWith('/ajax-validacion-doc-aviso')) return new Response(validationAnswer);
    const route = routes[url];
    if (!route) return new Response(html('not found', 'Error'), { status: 200, headers: { 'content-type': 'text/html' } });
    const r = new Response(route.body, { headers: { 'content-type': route.type ?? 'text/html' } });
    Object.defineProperty(r, 'url', { value: url });
    return r;
  };
  return { fetchImpl, calls };
}

test('direct PDF', async () => {
  const { fetchImpl } = fakeEndesa('https://docs.endesaclientes.com/f?id=1&t=2', { 'https://docs.endesaclientes.com/f?id=1&t=2': { body: PDF, type: 'application/pdf' } });
  assert.deepEqual(await downloadBillPdf(LINK, 'Z0000000T', { fetchImpl }), PDF);
});

test('HTML-escaped URL from the validation endpoint is unescaped', async () => {
  const { fetchImpl, calls } = fakeEndesa('"https://docs.endesaclientes.com/f?id=1&amp;t=2"', { 'https://docs.endesaclientes.com/f?id=1&t=2': { body: PDF, type: 'application/pdf' } });
  assert.deepEqual(await downloadBillPdf(LINK, 'Z0000000T', { fetchImpl }), PDF);
  assert.ok(calls.includes('https://docs.endesaclientes.com/f?id=1&t=2'));
});

test('viewer page with an iframe (relative URL) is followed', async () => {
  const { fetchImpl } = fakeEndesa('https://docs.endesaclientes.com/visor?id=1', {
    'https://docs.endesaclientes.com/visor?id=1': { body: html('<iframe src="/pdf/get?id=1"></iframe>') },
    'https://docs.endesaclientes.com/pdf/get?id=1': { body: PDF, type: 'application/pdf' },
  });
  assert.deepEqual(await downloadBillPdf(LINK, 'Z0000000T', { fetchImpl }), PDF);
});

test('PDF embedded as base64 in the page', async () => {
  const b64 = Buffer.concat([PDF, Buffer.alloc(200, 32)]).toString('base64');
  const { fetchImpl } = fakeEndesa('https://docs.endesaclientes.com/visor?id=2', {
    'https://docs.endesaclientes.com/visor?id=2': { body: html(`<embed src="data:application/pdf;base64,${b64}">`) },
  });
  const buf = await downloadBillPdf(LINK, 'Z0000000T', { fetchImpl });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
});

test('failure explains what came back', async () => {
  const { fetchImpl } = fakeEndesa('https://docs.endesaclientes.com/visor?id=3&secret=x', {
    'https://docs.endesaclientes.com/visor?id=3&secret=x': { body: html('<p>Sesión caducada</p>', 'Endesa - Error') },
  });
  await assert.rejects(downloadBillPdf(LINK, 'Z0000000T', { fetchImpl }), (e) => {
    assert.match(e.message, /HTTP 200, text\/html.*docs\.endesaclientes\.com\/visor, title "Endesa - Error", text ".*Sesión caducada/);
    assert.doesNotMatch(e.message, /secret/, 'query string (tokens) never in the message');
    return true;
  });
});

test('pdfCandidates finds iframe, JS redirect and .pdf links', () => {
  const c = pdfCandidates(`<iframe src="/a?x=1&amp;y=2"></iframe><script>window.location.href = "https://e.com/b";</script><a href="/c/file.pdf">x</a>`, 'https://e.com/v');
  assert.deepEqual(c, ['https://e.com/a?x=1&y=2', 'https://e.com/b', 'https://e.com/c/file.pdf']);
});

test('loader page (descargarFacturaAD): rebuilds the JS-built servlet URL and keeps the session cookie', async () => {
  const loader = 'https://www.endesaclientes.com/descargarFacturaAD.html?x=1';
  const page = html(`Datos erróneos, no se ha podido descargar la factura. Cargando ...
    <script>
      var jsonDownloadPdf = '';
      var billNumber='P26CON046489044';
      var holderCompanyCode='0021';
      var aux = "null";
      var billUrl = '';
      if (billNumber.length>0 && holderCompanyCode>0) {
        billUrl = '/sites/Satellite/DownloadDocumentServlet?pagename=SiteEntry_IB_ES/Bill_Search/View_Pdf&jsonDownloadPdf='+'{"billNumber":"P26CON046489044"}'+'&AD=Y'+'&emissionDate='+emissionDate;
      }
      window.location.href=$(this).attr("href");
    </script>`, 'DescargarFacturaAD');
  let servletCookie = null;
  const fetchImpl = async (url, opts = {}) => {
    if (url === LINK) return new Response('var encDocumento = "D"; var encFactura = "F";');
    if (url.endsWith('/ajax-validacion-doc-aviso')) return new Response(loader);
    if (url === loader) {
      const r = new Response(page, { headers: { 'content-type': 'text/html', 'set-cookie': 'JSESSIONID=abc; Path=/' } });
      Object.defineProperty(r, 'url', { value: loader });
      return r;
    }
    if (url.startsWith('https://www.endesaclientes.com/sites/Satellite/DownloadDocumentServlet?')) {
      servletCookie = opts.headers?.Cookie;
      assert.match(url, /jsonDownloadPdf=\{%22billNumber%22:%22P26CON046489044%22\}&AD=Y&emissionDate=\d{8}$/);
      return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
    }
    return new Response(html('nope'), { headers: { 'content-type': 'text/html' } });
  };
  assert.deepEqual(await downloadBillPdf(LINK, 'Z0000000T', { fetchImpl }), PDF);
  assert.match(servletCookie, /JSESSIONID=abc/);
});

test('emission date logic mirrors the page', async () => {
  const { emissionDateFrom } = await import('../src/endesa.js');
  assert.equal(emissionDateFrom("x'eml-20261106rest"), '20261106');
  assert.equal(emissionDateFrom('retosmds:AAAAAAAA20261106'), '20261106');
  assert.match(emissionDateFrom('null'), /^\d{8}$/);
});
