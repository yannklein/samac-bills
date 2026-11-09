import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { makeAuth } from './auth.js';
import { makeService, HttpError } from './service.js';
import { parseEndesaBill, KIND_LABELS } from './parseEndesaBill.js';
import { pdfText } from './pdf.js';
import { downloadBillPdf, EndesaError } from './endesa.js';
import { formatEur, parseAmount, parseDecimal } from './money.js';
import { parseReading } from './parseReading.js';
import { makeWhatsApp } from './whatsapp.js';
import { makeInbound } from './inbound.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const STATUS_LABELS = {
  awaiting_reading: 'Waiting for neighbor photo',
  awaiting_confirmation: 'Waiting for confirmation',
  ready: 'Calculated, not sent',
  sent: 'Sent',
  superseded: 'Replaced',
  error: 'Error',
};

const imageExt = (mime = '') => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[mime] ?? 'jpg');
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = parseDecimal(String(v));
  return Number.isFinite(n) ? n : null;
};
/** Meter readings: "12,445" / "12.445" are thousands separators. */
const readingNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return v === undefined || v === null || String(v).trim() === '' ? null : parseReading(String(v));
};

export function configFromEnv(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  return {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR || '/data',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
    adminEmail: env.ADMIN_EMAIL || 'yann.klein@me.com',
    apiToken: env.API_TOKEN || '',
    endesaNie: env.ENDESA_NIE || '',
    cfTeamDomain: env.CF_ACCESS_TEAM_DOMAIN || '',
    cfAud: env.CF_ACCESS_AUD || '',
    n8nSendWebhookUrl: env.N8N_SEND_WEBHOOK_URL || '',
    n8nWebhookToken: env.N8N_WEBHOOK_TOKEN || '',
    waPhoneNumberId: env.WA_PHONE_NUMBER_ID || '',
    graphVersion: env.GRAPH_API_VERSION || 'v27.0',
    waTemplateLang: env.WA_TEMPLATE_LANG || 'en',
    devUserEmail: prod ? '' : env.DEV_USER_EMAIL || '',
  };
}

export function createApp(config, { fetchImpl = fetch } = {}) {
  const db = openDb(config.dataDir);
  const svc = makeService({ db, dataDir: config.dataDir, publicUrl: config.publicUrl });
  const auth = makeAuth(config);
  const wa = makeWhatsApp({ phoneNumberId: config.waPhoneNumberId, graphVersion: config.graphVersion, lang: config.waTemplateLang });
  const inbound = makeInbound({ svc, wa, publicUrl: config.publicUrl, endesaNie: config.endesaNie, fetchImpl });
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(here, '..', 'views'));
  app.set('trust proxy', true);
  app.locals.formatEur = formatEur;
  app.locals.STATUS_LABELS = STATUS_LABELS;
  app.locals.KIND_LABELS = KIND_LABELS;
  app.locals.fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
  app.locals.fmtKwh = (n) => (n == null ? '—' : `${Math.round(n * 1000) / 1000} kWh`);

  app.use(express.urlencoded({ extended: false }));
  // /api accepts meter photos as base64 inside JSON (from n8n)
  app.use('/api', express.json({ limit: '25mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  // Public page required by Meta to publish the WhatsApp app (Cloudflare Access bypass on /privacy)
  app.get('/privacy', (req, res) => res.render('privacy', { contact: config.adminEmail }));

  // ---------- API for n8n (Bearer token, internal network) ----------
  const api = express.Router();
  api.use(auth.api);

  api.post('/endesa/fetch', async (req, res) => {
    const { link } = req.body ?? {};
    if (!link) throw new HttpError(400, 'Missing "link".');
    let pdf;
    try {
      pdf = await downloadBillPdf(link, config.endesaNie, { fetchImpl });
    } catch (e) {
      if (e instanceof EndesaError) throw new HttpError(422, e.message);
      throw e;
    }
    const parsed = parseEndesaBill(await pdfText(pdf));
    if (parsed.errors.length) {
      const pdfPath = svc.saveFile(pdf, 'pdf', 'bill-error');
      throw new HttpError(422, parsed.errors.join(' '), { pdf_path: pdfPath });
    }
    const { bill, superseded } = svc.createBill({ parsed, pdfBuffer: pdf, source: 'auto' });
    res.status(201).json({ ...svc.message(bill.id), superseded, total: formatEur(bill.total_cents), kwh_total: bill.kwh_total });
  });

  // n8n: new Endesa email (HTML body) -> always 200 with an outbox to send
  api.post('/endesa/email', async (req, res) => {
    res.json(await inbound.handleEndesaEmail({ html: req.body?.html ?? req.body?.textHtml ?? '' }));
  });

  // n8n: normalized incoming WhatsApp message (+ meter photo and vision reading) -> outbox
  api.post('/wa/inbound', upload.single('photo'), (req, res) => {
    const b = req.body ?? {};
    res.json(inbound.handleWhatsApp({
      from: b.from, type: b.type, text: b.text, button_id: b.button_id,
      reading: readingNum(b.reading), confidence: b.confidence,
      recipient: b.recipient, error: b.error,
      photoBuffer: req.file?.buffer ?? (b.photo_base64 ? Buffer.from(b.photo_base64, 'base64') : undefined),
      photoExt: imageExt(req.file?.mimetype ?? b.photo_mime),
    }));
  });

  api.get('/bills/open', (req, res) => {
    const bill = svc.openBill();
    if (!bill) return res.status(404).json({ error: 'No hay factura abierta.' });
    res.json({ ...svc.message(bill.id), kwh_total: bill.kwh_total });
  });

  api.post('/bills/:id/candidate', upload.single('photo'), (req, res) => {
    const reading = readingNum(req.body.reading);
    res.json(svc.addCandidate(Number(req.params.id), {
      reading,
      photoBuffer: req.file?.buffer,
      photoExt: imageExt(req.file?.mimetype),
      confidence: req.body.confidence,
      source: req.body.source || 'vision',
    }));
  });

  api.post('/bills/:id/confirm', (req, res) => {
    const b = req.body ?? {};
    res.json(svc.confirm(Number(req.params.id), {
      reading: readingNum(b.reading),
      neighborKwh: num(b.neighbor_kwh),
      source: b.source || 'typed',
      expectReading: readingNum(b.expect_reading),
      override: b.override === true || b.override === 'true',
    }));
  });

  api.post('/bills/:id/sent', (req, res) => res.json(svc.markSent(Number(req.params.id))));
  api.get('/bills/:id/message', (req, res) => res.json(svc.message(Number(req.params.id))));
  api.get('/people', (req, res) => res.json(svc.people()));
  app.use('/api', api);

  // ---------- Web UI (Cloudflare Access) ----------
  const web = express.Router();
  web.use(auth.viewer);
  web.use((req, res, next) => {
    // Only Yann + the people registered in the app may view (defence in depth behind Access).
    const emails = Object.values(svc.people()).map((p) => p.email?.toLowerCase()).filter(Boolean);
    if (req.user.isAdmin || !emails.length || emails.includes(req.user.email)) return next();
    res.status(403).send('Your email is not authorized.');
  });
  web.use('/files', express.static(svc.filesDir, { dotfiles: 'deny', index: false }));
  // Pure modules shared with the browser for the live preview
  web.get('/js/:mod.js', (req, res, next) => {
    if (!['splitLuz', 'money', 'parseReading'].includes(req.params.mod)) return next();
    res.type('application/javascript').sendFile(path.join(here, `${req.params.mod}.js`));
  });

  web.get('/', (req, res) => {
    res.render('index', { bills: svc.listBills(), msg: req.query.msg });
  });

  web.get('/bills/new', auth.admin, (req, res) => {
    res.render('new', { lastReading: svc.latestReadingForNew() });
  });

  // Step 1 of manual entry: upload PDF -> parsed fields (JSON, used by the form's JS)
  web.post('/bills/parse', auth.admin, upload.single('pdf'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Upload the bill PDF.');
    let parsed;
    try {
      parsed = parseEndesaBill(await pdfText(req.file.buffer));
    } catch {
      parsed = parseEndesaBill('');
      parsed.errors = ['Could not read the PDF. Fill in the fields by hand.'];
    }
    const pdfPath = svc.saveFile(req.file.buffer, 'pdf', `bill-${parsed.invoiceNo ?? 'manual'}`);
    res.json({ parsed, pdf_path: pdfPath });
  });

  web.post('/bills', auth.admin, upload.single('photo'), (req, res) => {
    const b = req.body;
    const items = JSON.parse(b.items_json || '[]').map((i) => ({
      key: i.key || 'other', label: String(i.label), kind: i.kind,
      amountCents: typeof i.amountCents === 'number' ? i.amountCents : parseAmount(i.amount),
      ...(i.kwh != null ? { kwh: Number(i.kwh) } : {}),
    }));
    const parsed = {
      invoiceNo: b.invoice_no?.trim(), periodFrom: b.period_from, periodTo: b.period_to,
      days: Number(b.days) || null, issuedAt: b.issued_at || null,
      totalCents: parseAmount(b.total), kwhTotal: num(b.kwh_total), items,
    };
    const pdfPath = /^\d{4}-\d{2}\/[\w.-]+\.pdf$/.test(b.pdf_path || '') ? b.pdf_path : null;
    const { bill } = svc.createBill({ parsed, items, pdfPath, source: 'manual' });
    const reading = readingNum(b.reading);
    const neighborKwh = num(b.neighbor_kwh);
    // No reading yet -> the bill stays "awaiting_reading" and the WhatsApp flow can still complete it.
    if (reading != null || neighborKwh != null) {
      const photoPath = req.file ? svc.saveFile(req.file.buffer, imageExt(req.file.mimetype), `meter-${bill.invoice_no}`) : undefined;
      svc.confirm(bill.id, { reading: neighborKwh != null ? null : reading, neighborKwh, source: 'manual', override: true, photoPath });
    }
    res.redirect(`/bills/${bill.id}`);
  });

  web.get('/bills/:id', (req, res) => {
    res.render('bill', { ...svc.billDetail(Number(req.params.id)), msg: req.query.msg, n8nConfigured: !!config.n8nSendWebhookUrl });
  });

  web.post('/bills/:id/reading', auth.admin, upload.single('photo'), (req, res) => {
    const id = Number(req.params.id);
    const reading = readingNum(req.body.reading);
    const neighborKwh = num(req.body.neighbor_kwh);
    const photoPath = req.file ? svc.saveFile(req.file.buffer, imageExt(req.file.mimetype), 'meter') : undefined;
    svc.confirm(id, { reading: neighborKwh != null ? null : reading, neighborKwh, source: 'manual', override: true, photoPath });
    res.redirect(`/bills/${id}?msg=${encodeURIComponent('Split recalculated.')}`);
  });

  web.post('/bills/:id/send', auth.admin, async (req, res) => {
    const id = Number(req.params.id);
    if (!svc.message(id).split_vars) throw new HttpError(409, 'Calculate the split first.');
    if (!config.n8nSendWebhookUrl) throw new HttpError(500, 'N8N_SEND_WEBHOOK_URL is not configured.');
    const r = await fetchImpl(config.n8nSendWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Samac-Token': config.n8nWebhookToken },
      body: JSON.stringify({ bill_id: id, outbox: inbound.splitOutbox(id) }),
    });
    if (r.ok) svc.markSent(id);
    const msg = r.ok ? 'Sent on WhatsApp.' : `n8n answered ${r.status}: nothing was sent.`;
    res.redirect(`/bills/${id}?msg=${encodeURIComponent(msg)}`);
  });

  web.post('/bills/:id/paid', auth.admin, (req, res) => {
    const payer = req.body.payer;
    if (!['neighbor', 'marcela'].includes(payer)) throw new HttpError(400, 'Invalid payer.');
    svc.togglePaid(Number(req.params.id), payer);
    res.redirect(req.get('referer')?.includes('/bills/') ? `/bills/${req.params.id}` : '/');
  });

  app.use(express.static(path.join(here, '..', 'public'), { index: false }));
  app.use(web);

  // ---------- Errors ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error(err);
    const body = { error: err.message, ...(err.extra ?? {}) };
    if (req.path.startsWith('/api') || req.accepts(['html', 'json']) === 'json') return res.status(status).json(body);
    res.status(status).render('error', { status, message: err.message });
  });

  return { app, db, svc };
}
