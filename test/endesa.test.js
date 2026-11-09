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
