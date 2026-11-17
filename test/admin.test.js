import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { parseEndesaBill } from '../src/parseEndesaBill.js';

const sample = readFileSync(new URL('./fixtures/endesa_oct_2026_detalle.txt', import.meta.url), 'utf8');
let dir, server, base, ctx;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'samac-admin-'));
  ctx = createApp({
    dataDir: dir, publicUrl: 'https://bills.example', adminEmail: 'yann@example.com', apiToken: 't',
    endesaNie: '', devUserEmail: 'yann@example.com', cfTeamDomain: '', cfAud: '', n8nSendWebhookUrl: '', n8nWebhookToken: '',
  });
  const ins = ctx.db.prepare('INSERT INTO people (role, name, wa_phone, email) VALUES (?, ?, ?, ?)');
  ins.run('yann', 'Yann', '34600000001', 'yann@example.com');
  ins.run('marcela', 'Marcela', '34600000003', 'marcela@example.com');
  ctx.db.prepare(`INSERT INTO readings (bill_id, reading_kwh, source, status) VALUES (NULL, 1000, 'seed', 'seed')`).run();
  await new Promise((r) => { server = ctx.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

const form = (url, data, as) => fetch(`${base}${url}${as ? `?as=${as}` : ''}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(data).toString(),
});
const newBill = (invoiceNo, periodTo) => {
  const parsed = { ...parseEndesaBill(sample), invoiceNo, periodTo };
  return ctx.svc.createBill({ parsed, pdfBuffer: Buffer.from('%PDF-1.4 x'), source: 'auto' }).bill;
};

test('admin pages are Yann-only', async () => {
  assert.equal((await fetch(`${base}/admin`)).status, 200);
  assert.equal((await fetch(`${base}/admin?as=marcela@example.com`)).status, 403);
  assert.equal((await form('/admin/people', { role: 'marcela', name: 'Hacked' }, 'marcela@example.com')).status, 403);
});

test('people: add, edit, validate, remove (never Yann)', async () => {
  let r = await form('/admin/people', { role: 'neighbor', name: 'Pepe', wa_phone: '+34 611 22 33 44', email: 'Pepe@Example.com' });
  assert.equal(r.status, 302);
  assert.deepEqual(ctx.svc.people().neighbor, { role: 'neighbor', name: 'Pepe', wa_phone: '34611223344', email: 'pepe@example.com' });
  r = await form('/admin/people', { role: 'neighbor', name: 'Pepe', wa_phone: '123' });
  assert.equal(r.status, 422);
  assert.equal((await form('/admin/people/yann/delete', {})).status, 422);
  assert.equal((await form('/admin/people/neighbor/delete', {})).status, 302);
  assert.equal(ctx.svc.people().neighbor, undefined);
  const page = await (await fetch(`${base}/admin`)).text();
  assert.match(page, /Neighbor[\s\S]*not set/);
});

test('edit bill: lines and total change, split recalculated and still adds up', async () => {
  const bill = newBill('EDIT1', '2026-11-01');
  ctx.svc.confirm(bill.id, { reading: 1100, source: 'manual', override: true });
  ctx.svc.markSent(bill.id);
  const items = ctx.svc.getBill(bill.id).items;
  const data = new URLSearchParams({
    invoice_no: 'EDIT1', period_from: '2026-10-07', period_to: '2026-11-01', days: '26', issued_at: '2026-11-06',
    kwh_total: '233.251', total: '80.48',
  });
  for (const it of items) {
    data.append('line_label', it.label);
    data.append('line_key', it.key);
    data.append('line_kind', it.kind);
    data.append('line_amount', (it.amountCents / 100).toFixed(2));
  }
  data.append('line_label', 'Extra service'); data.append('line_key', ''); data.append('line_kind', 'fixed'); data.append('line_amount', '10.00');
  data.append('line_label', ''); data.append('line_key', ''); data.append('line_kind', 'fixed'); data.append('line_amount', ''); // blank row ignored
  const r = await fetch(`${base}/bills/${bill.id}/edit`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data.toString() });
  assert.equal(r.status, 302, await r.text());
  const d = ctx.svc.billDetail(bill.id);
  assert.equal(d.bill.total_cents, 8048);
  assert.equal(d.bill.status, 'ready', 'amounts changed: must be re-sent');
  assert.equal(d.split.neighbor_cents + d.split.home_cents, 8048);
  assert.equal(d.split.neighbor_kwh, 100, 'reading kept');
  assert.equal(d.split.sent_at, null);

  // Lines that don't add up are refused
  data.set('total', '99.99');
  const bad = await fetch(`${base}/bills/${bill.id}/edit`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data.toString() });
  assert.equal(bad.status, 422);
  assert.equal(ctx.svc.getBill(bill.id).total_cents, 8048);
});

test('changing the previous reading recalculates unsent bills only', async () => {
  ctx.db.exec('DELETE FROM payments; DELETE FROM splits; DELETE FROM readings WHERE bill_id IS NOT NULL; DELETE FROM bills;');
  const sent = newBill('SEED-SENT', '2026-09-01');
  ctx.svc.confirm(sent.id, { reading: 1100, source: 'manual', override: true });
  ctx.svc.markSent(sent.id);
  const r = await form('/admin/seed', { reading: '1.050' });
  assert.equal(r.status, 302);
  assert.match(decodeURIComponent(r.headers.get('location')), /already sent: SEED-SENT/);
  assert.equal(ctx.svc.billDetail(sent.id).split.neighbor_kwh, 100, 'sent bill untouched');

  ctx.db.exec('DELETE FROM payments; DELETE FROM splits; DELETE FROM readings WHERE bill_id IS NOT NULL; DELETE FROM bills;');
  const open = newBill('SEED-OPEN', '2026-10-01');
  ctx.svc.confirm(open.id, { reading: 1100, source: 'manual', override: true });
  const r2 = await form('/admin/seed', { reading: '1050' });
  assert.match(decodeURIComponent(r2.headers.get('location')), /Recalculated: SEED-OPEN/);
  assert.equal(ctx.svc.billDetail(open.id).split.neighbor_kwh, 50);
});

test('mark as sent and delete a bill (with its files)', async () => {
  const bill = newBill('DEL1', '2026-12-01');
  ctx.svc.confirm(bill.id, { neighborKwh: 10, source: 'manual', override: true });
  assert.equal((await form(`/bills/${bill.id}/mark-sent`, {})).status, 302);
  assert.equal(ctx.svc.getBill(bill.id).status, 'sent');
  const pdf = path.join(ctx.svc.filesDir, ctx.svc.getBill(bill.id).pdf_path);
  assert.ok(existsSync(pdf));
  assert.equal((await form(`/bills/${bill.id}/delete`, {})).status, 302);
  assert.throws(() => ctx.svc.getBill(bill.id), /not found/);
  assert.equal(existsSync(pdf), false);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM readings WHERE bill_id = ?').get(bill.id).n, 0);
});

test('backup downloads a SQLite database', async () => {
  const r = await fetch(`${base}/admin/backup`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="?samac-bills-[\d-]+\.db"?/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await fetch(`${base}/admin/backup?as=marcela@example.com`)).status, 403);
});

test('edit page and bill page render admin controls', async () => {
  const bill = newBill('VIEW1', '2027-01-01');
  const edit = await (await fetch(`${base}/bills/${bill.id}/edit`)).text();
  assert.match(edit, /Edit bill VIEW1/);
  assert.match(edit, /name="line_amount"/);
  const page = await (await fetch(`${base}/bills/${bill.id}`)).text();
  assert.match(page, /Edit bill details and lines/);
  assert.match(page, /Delete this bill/);
  const asMarcela = await (await fetch(`${base}/bills/${bill.id}?as=marcela@example.com`)).text();
  assert.doesNotMatch(asMarcela, /Delete this bill/);
});

test('neighbor view: own share and home total only, read-only', async () => {
  ctx.db.prepare(`INSERT INTO people (role, name, wa_phone, email) VALUES ('neighbor', 'Pepe', NULL, 'pepe@example.com')
    ON CONFLICT(role) DO UPDATE SET email = excluded.email, wa_phone = NULL`).run();
  const bill = newBill('NEIGH1', '2027-02-01');
  ctx.svc.confirm(bill.id, { neighborKwh: 100, source: 'manual', override: true });
  const d = ctx.svc.billDetail(bill.id).split;
  const eur = (c) => `€${(c / 100).toFixed(2)}`;
  const as = '?as=pepe@example.com';

  const page = await (await fetch(`${base}/bills/${bill.id}${as}`)).text();
  assert.match(page, new RegExp(eur(d.neighbor_cents).replace('.', '\\.')));
  assert.match(page, /Hi Pepe/);
  assert.match(page, /You pay Yann/);
  assert.match(page, /Marcela, Adriana and Yann(&#39;|')s apartment/);
  assert.match(page, /How your share was calculated/);
  assert.match(page, /Your meter readings/);
  assert.doesNotMatch(page, /Neighbor/, 'no generic "Neighbor" wording on David\'s own page');
  for (const hidden of [eur(d.marcela_cents), eur(d.yann_adriana_cents), '1/3 of home', '2/3 of home', 'Mark as paid', 'Edit bill', 'Delete this bill']) {
    assert.ok(!page.includes(hidden), `neighbor page must not contain "${hidden}"`);
  }

  const list = await (await fetch(`${base}/${as}`)).text();
  assert.ok(!list.includes('Yann &amp; Adriana'), 'no Yann & Adriana column');
  assert.ok(!list.includes(eur(d.marcela_cents)), 'no Marcela amounts');
  assert.ok(!list.includes('New bill'), 'no admin button');
  assert.match(list, /Your electricity bills/);
  assert.match(list, /Your share/);

  // Everything that changes data is refused
  for (const [url, data] of [[`/bills/${bill.id}/paid`, { payer: 'neighbor' }], [`/bills/${bill.id}/reading`, { neighbor_kwh: '1' }],
    [`/bills/${bill.id}/edit`, {}], [`/bills/${bill.id}/delete`, {}], [`/bills/${bill.id}/mark-sent`, {}], [`/bills/${bill.id}/send`, {}],
    ['/admin/people', { role: 'neighbor', name: 'x' }], ['/admin/seed', { reading: '1' }]]) {
    assert.equal((await form(url, data, 'pepe@example.com')).status, 403, url);
  }
  for (const url of ['/admin', `/bills/${bill.id}/edit`, '/bills/new', '/admin/backup']) {
    assert.equal((await fetch(`${base}${url}${as}`)).status, 403, url);
  }

  // Marcela still sees the full split
  const marcela = await (await fetch(`${base}/bills/${bill.id}?as=marcela@example.com`)).text();
  assert.ok(marcela.includes(eur(d.marcela_cents)));
});

test('Spanish: browser default, saved per user with the switch, David sees his page in Spanish', async () => {
  ctx.db.prepare(`INSERT INTO people (role, name, wa_phone, email) VALUES ('neighbor', 'David', NULL, 'david@example.com')
    ON CONFLICT(role) DO UPDATE SET name = 'David', email = 'david@example.com', wa_phone = NULL`).run();
  ctx.db.prepare(`DELETE FROM prefs`).run();
  const bill = newBill('ES1', '2027-03-01');
  ctx.svc.confirm(bill.id, { neighborKwh: 100, source: 'manual', override: true });
  const as = '?as=david@example.com';

  // Spanish browser -> Spanish, without any saved preference
  let page = await (await fetch(`${base}/bills/${bill.id}${as}`, { headers: { 'Accept-Language': 'es-ES,es;q=0.9' } })).text();
  assert.match(page, /<html lang="es">/);
  assert.match(page, /Hola David/);
  assert.match(page, /Pagas a Yann/);
  assert.match(page, /32,28 €/);
  assert.match(page, /Piso de Marcela, Adriana y Yann/);
  assert.match(page, /Cómo se ha calculado tu parte/);
  assert.match(page, /Fijo \(50\/50\)/);
  for (const english of ['You pay', 'Your meter', 'Evidence', 'Breakdown', '€32.28']) assert.ok(!page.includes(english), `no "${english}"`);

  // David switches to English: saved for him, whatever the browser says
  const r = await form('/prefs/lang', { lang: 'en', back: `/bills/${bill.id}?msg=x` }, 'david@example.com');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/bills/${bill.id}`, 'goes back to the page, without the old flash message');
  page = await (await fetch(`${base}/bills/${bill.id}${as}`, { headers: { 'Accept-Language': 'es-ES' } })).text();
  assert.match(page, /You pay Yann/);
  assert.match(page, /€32\.28/);

  // ...and only for him: Yann with a Spanish browser still gets Spanish
  const yann = await (await fetch(`${base}/bills/${bill.id}`, { headers: { 'Accept-Language': 'es' } })).text();
  assert.match(yann, /Desglose/);

  // Open redirects are refused
  const evil = await form('/prefs/lang', { lang: 'en', back: '//evil.example.com' }, 'david@example.com');
  assert.equal(evil.headers.get('location'), '/');

  // Spanish list, admin page and edit page render without missing keys
  const list = await (await fetch(`${base}/${as}`)).text(); // David is back on English now
  assert.match(list, /Your electricity bills/);
  await form('/prefs/lang', { lang: 'es', back: '/' });
  for (const url of ['/', '/admin', `/bills/${bill.id}/edit`, '/bills/new', `/bills/${bill.id}`]) {
    const html = (await (await fetch(`${base}${url}`)).text()).replace(/<script[\s\S]*?<\/script>/g, '');
    assert.doesNotMatch(html, /\b(?:bill|list|admin|form|new|edit|kind|status|nstatus|msg|role)\.[a-zA-Z]+\b(?![^<]*>)/, `untranslated key on ${url}`);
  }
  const privacy = await (await fetch(`${base}/privacy?lang=es`)).text();
  assert.match(privacy, /Borrado de datos/);
});

test('Yann can preview the neighbor view (same page, David\'s language, no admin controls)', async () => {
  ctx.db.prepare(`INSERT INTO people (role, name, wa_phone, email) VALUES ('neighbor', 'David', NULL, 'david@example.com')
    ON CONFLICT(role) DO UPDATE SET name = 'David', email = 'david@example.com'`).run();
  ctx.db.prepare(`DELETE FROM prefs`).run();
  ctx.db.prepare(`INSERT INTO prefs (email, lang) VALUES ('david@example.com', 'es'), ('yann@example.com', 'en')`).run();
  const bill = newBill('PREV1', '2027-04-01');
  ctx.svc.confirm(bill.id, { neighborKwh: 100, source: 'manual', override: true });
  const d = ctx.svc.billDetail(bill.id).split;
  const strip = (h) => h.replace(/<header[\s\S]*?<\/header>/, '').replace(/<div class="preview-banner">[\s\S]*?<\/div>/, '').replace(/\n\s*(?=\n)/g, '');

  // Entry point on Yann's own page
  const own = await (await fetch(`${base}/bills/${bill.id}`)).text();
  assert.match(own, new RegExp(`href="/bills/${bill.id}\\?view=neighbor"`));
  assert.match(own, /See as David/);

  // The preview body is identical to what David himself gets
  const preview = await (await fetch(`${base}/bills/${bill.id}?view=neighbor`)).text();
  const asDavid = await (await fetch(`${base}/bills/${bill.id}?as=david@example.com`)).text();
  assert.match(preview, /Vista previa: esto es exactamente lo que ve David/);
  assert.equal(strip(preview).replace(/\?view=neighbor/g, ''), strip(asDavid));
  for (const hidden of ['12,73 €', '25,47 €', 'Marcar como pagado', 'Editar', 'Borrar', 'href="/admin"']) {
    assert.ok(!preview.includes(hidden), `preview must not contain "${hidden}"`);
  }
  assert.ok(preview.includes('href="/?view=neighbor"'), 'back link stays in preview');

  // Language override inside the preview does not touch anyone's saved preference
  const en = await (await fetch(`${base}/bills/${bill.id}?view=neighbor&lang=en`)).text();
  assert.match(en, /You pay Yann/);
  assert.deepEqual(ctx.db.prepare('SELECT email, lang FROM prefs ORDER BY email').all(),
    [{ email: 'david@example.com', lang: 'es' }, { email: 'yann@example.com', lang: 'en' }]);

  // List preview
  const list = await (await fetch(`${base}/?view=neighbor`)).text();
  assert.match(list, /Tus facturas de luz/);
  assert.ok(list.includes(`/bills/${bill.id}?view=neighbor`));

  // Only Yann can use it: for Marcela the parameter is ignored (her normal full view)
  const marcela = await (await fetch(`${base}/bills/${bill.id}?view=neighbor&as=marcela@example.com`)).text();
  assert.doesNotMatch(marcela, /preview-banner/);
  assert.ok(marcela.includes('12.73') || marcela.includes('12,73'), 'Marcela still sees her full split');
});
