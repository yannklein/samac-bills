// Business logic on top of SQLite: bill lifecycle, readings, split, WhatsApp message variables.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { splitLuz } from './splitLuz.js';
import { formatEurPlain } from './money.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const OPEN = ['awaiting_reading', 'awaiting_confirmation'];
const esDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const esKwh = (n) => (n == null ? '' : String(Math.round(n * 1000) / 1000).replace('.', ','));

export function makeService({ db, dataDir, publicUrl = '' }) {
  const filesDir = path.join(dataDir, 'files');

  function saveFile(buffer, ext, prefix) {
    const month = new Date().toISOString().slice(0, 7);
    const rel = path.posix.join(month, `${prefix}-${randomUUID().slice(0, 8)}.${ext}`);
    mkdirSync(path.join(filesDir, month), { recursive: true });
    writeFileSync(path.join(filesDir, rel), buffer);
    return rel;
  }

  const getBill = (id) => {
    const b = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
    if (!b) throw new HttpError(404, `Factura ${id} no encontrada.`);
    return { ...b, items: JSON.parse(b.items_json) };
  };

  const people = () => {
    const rows = db.prepare('SELECT * FROM people').all();
    return Object.fromEntries(rows.map((p) => [p.role, p]));
  };

  /** Most recent confirmed reading of an earlier bill, else the seed reading. */
  function previousReading(bill) {
    return (
      db.prepare(`
        SELECT r.* FROM readings r JOIN bills b ON b.id = r.bill_id
        WHERE r.status = 'confirmed' AND b.id != ? AND b.period_to < ?
        ORDER BY b.period_to DESC, r.id DESC LIMIT 1`).get(bill.id, bill.period_to) ??
      db.prepare(`SELECT * FROM readings WHERE status = 'seed' ORDER BY id DESC LIMIT 1`).get() ??
      null
    );
  }

  function createBill({ parsed, items, pdfBuffer, pdfPath, source }) {
    const finalItems = items ?? parsed.items;
    if (!parsed.invoiceNo) throw new HttpError(422, 'Falta el número de factura.');
    if (!parsed.totalCents || !parsed.kwhTotal) throw new HttpError(422, 'Faltan el total o los kWh.');
    const unknown = finalItems.filter((i) => !['fixed', 'variable', 'tax'].includes(i.kind));
    if (unknown.length) {
      throw new HttpError(422, `Líneas sin clasificar: ${unknown.map((i) => i.label).join(', ')}`);
    }
    const sum = finalItems.reduce((s, i) => s + i.amountCents, 0);
    if (Math.abs(sum - parsed.totalCents) > 1) {
      throw new HttpError(422, `Las líneas (${formatEurPlain(sum)} €) no suman el total (${formatEurPlain(parsed.totalCents)} €).`);
    }
    if (db.prepare('SELECT 1 FROM bills WHERE invoice_no = ?').get(parsed.invoiceNo)) {
      throw new HttpError(409, `La factura ${parsed.invoiceNo} ya existe.`);
    }
    const storedPdf = pdfPath ?? (pdfBuffer ? saveFile(pdfBuffer, 'pdf', `factura-${parsed.invoiceNo}`) : null);

    let superseded = [];
    const id = db.transaction(() => {
      superseded = db.prepare(`SELECT id, invoice_no FROM bills WHERE status IN ('awaiting_reading','awaiting_confirmation')`).all();
      db.prepare(`UPDATE bills SET status = 'superseded', status_note = ? WHERE status IN ('awaiting_reading','awaiting_confirmation')`)
        .run(`Sustituida por ${parsed.invoiceNo}`);
      return db.prepare(`
        INSERT INTO bills (invoice_no, period_from, period_to, days, issued_at, total_cents, kwh_total, items_json, pdf_path, source, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_reading')`)
        .run(parsed.invoiceNo, parsed.periodFrom, parsed.periodTo, parsed.days, parsed.issuedAt,
          parsed.totalCents, parsed.kwhTotal, JSON.stringify(finalItems), storedPdf, source).lastInsertRowid;
    })();
    return { bill: getBill(id), superseded };
  }

  /** Role ('yann' | 'adriana' | 'marcela' | 'neighbor') of a WhatsApp number, or null. */
  function roleByPhone(phone) {
    const digits = String(phone ?? '').replace(/\D/g, '');
    if (!digits) return null;
    return db.prepare('SELECT role FROM people WHERE wa_phone = ?').get(digits)?.role ?? null;
  }

  function latestBill() {
    return db.prepare(`SELECT * FROM bills WHERE status != 'superseded' ORDER BY period_to DESC, id DESC LIMIT 1`).get() ?? null;
  }

  function openBill() {
    return db.prepare(`SELECT * FROM bills WHERE status IN ('awaiting_reading','awaiting_confirmation') ORDER BY period_to DESC, id DESC LIMIT 1`).get() ?? null;
  }

  function addCandidate(billId, { reading, photoBuffer, photoExt = 'jpg', confidence, source = 'vision', force = false }) {
    const bill = getBill(billId);
    if (!force && !OPEN.includes(bill.status)) throw new HttpError(409, `La factura ${bill.invoice_no} no está esperando lectura (estado: ${bill.status}).`);
    if (reading != null && !Number.isFinite(reading)) throw new HttpError(422, 'Lectura no válida.');
    const photo = photoBuffer ? saveFile(photoBuffer, photoExt, `contador-${bill.invoice_no}`) : null;
    db.transaction(() => {
      db.prepare(`INSERT INTO readings (bill_id, reading_kwh, photo_path, source, status, confidence) VALUES (?, ?, ?, ?, 'candidate', ?)`)
        .run(bill.id, reading, photo, source, confidence ?? null);
      if (OPEN.includes(bill.status)) db.prepare(`UPDATE bills SET status = 'awaiting_confirmation' WHERE id = ?`).run(bill.id);
    })();
    const prev = previousReading(bill);
    const delta = prev && reading != null ? Math.round((reading - prev.reading_kwh) * 1000) / 1000 : null;
    const warnings = [];
    if (delta != null && delta < 0) warnings.push(`La lectura (${reading}) es menor que la anterior (${prev.reading_kwh}).`);
    if (delta != null && delta > bill.kwh_total) warnings.push(`El vecino consumiría ${delta} kWh, más que el total de la factura (${bill.kwh_total} kWh).`);
    if (!prev) warnings.push('No hay lectura anterior: Yann debe indicar los kWh del vecino ("kwh 100").');
    if (reading == null) warnings.push('No se pudo leer el contador en la foto.');
    return { bill_id: bill.id, invoice_no: bill.invoice_no, reading, previous_reading: prev?.reading_kwh ?? null, neighbor_kwh: delta, warnings };
  }

  /**
   * Confirm the neighbor's consumption and compute the split.
   * Either `reading` (meter value) or `neighborKwh` (direct) must be given.
   * `override` (Yann / manual) skips state checks and warnings.
   */
  function confirm(billId, { reading, neighborKwh, source = 'typed', expectReading, override = false, photoPath }) {
    const bill = getBill(billId);
    const isOverride = override || source === 'override' || source === 'manual';
    const lastCandidate = db.prepare(`SELECT * FROM readings WHERE bill_id = ? AND status = 'candidate' ORDER BY id DESC LIMIT 1`).get(bill.id);
    if (expectReading != null) {
      if (bill.status !== 'awaiting_confirmation' || !lastCandidate || lastCandidate.reading_kwh !== Number(expectReading)) {
        throw new HttpError(409, 'Este botón ya no es válido (hay una lectura más reciente o ya se confirmó).');
      }
    }
    if (bill.status === 'superseded' && !isOverride) throw new HttpError(409, 'Factura sustituida por otra más reciente.');
    if (!isOverride && !OPEN.includes(bill.status)) {
      throw new HttpError(409, `La factura ${bill.invoice_no} ya está calculada (estado: ${bill.status}).`);
    }

    const prev = previousReading(bill);
    let finalReading = reading != null ? Number(reading) : null;
    let kwh = neighborKwh != null ? Number(neighborKwh) : null;
    if (kwh == null) {
      if (finalReading == null) throw new HttpError(422, 'Indica la lectura o los kWh del vecino.');
      if (!prev) throw new HttpError(422, 'No hay lectura anterior: indica los kWh del vecino directamente.');
      kwh = Math.round((finalReading - prev.reading_kwh) * 1000) / 1000;
    } else if (finalReading == null && prev) {
      finalReading = Math.round((prev.reading_kwh + kwh) * 1000) / 1000;
    }

    let split;
    try {
      split = splitLuz(bill.items, { kwhTotal: bill.kwh_total, neighborKwh: kwh, totalCents: bill.total_cents });
    } catch (e) {
      throw new HttpError(422, e.message);
    }
    if (split.warnings.length && !isOverride) {
      throw new HttpError(422, split.warnings.join(' '), { needs_override: true, warnings: split.warnings });
    }

    db.transaction(() => {
      db.prepare(`UPDATE readings SET status = 'replaced' WHERE bill_id = ? AND status = 'confirmed'`).run(bill.id);
      if (finalReading != null) {
        const photo = photoPath ?? lastCandidate?.photo_path ?? null;
        db.prepare(`INSERT INTO readings (bill_id, reading_kwh, photo_path, source, status, confirmed_at) VALUES (?, ?, ?, ?, 'confirmed', datetime('now'))`)
          .run(bill.id, finalReading, photo, source);
      }
      db.prepare(`
        INSERT INTO splits (bill_id, previous_reading_kwh, reading_kwh, neighbor_kwh, home_kwh, breakdown_json, neighbor_cents, home_cents, marcela_cents, yann_adriana_cents, computed_at, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
        ON CONFLICT(bill_id) DO UPDATE SET previous_reading_kwh = excluded.previous_reading_kwh, reading_kwh = excluded.reading_kwh,
          neighbor_kwh = excluded.neighbor_kwh, home_kwh = excluded.home_kwh, breakdown_json = excluded.breakdown_json,
          neighbor_cents = excluded.neighbor_cents, home_cents = excluded.home_cents, marcela_cents = excluded.marcela_cents,
          yann_adriana_cents = excluded.yann_adriana_cents, computed_at = excluded.computed_at, sent_at = NULL`)
        .run(bill.id, prev?.reading_kwh ?? null, finalReading, kwh, split.homeKwh, JSON.stringify(split),
          split.neighborCents, split.homeCents, split.marcelaCents, split.yannAdrianaCents);
      db.prepare(`UPDATE bills SET status = 'ready', status_note = NULL WHERE id = ?`).run(bill.id);
      // Amounts changed: previous "paid" marks no longer match
      db.prepare('DELETE FROM payments WHERE bill_id = ?').run(bill.id);
    })();
    return message(bill.id);
  }

  function markSent(billId) {
    const bill = getBill(billId);
    const r = db.prepare(`UPDATE splits SET sent_at = datetime('now') WHERE bill_id = ?`).run(bill.id);
    if (!r.changes) throw new HttpError(409, 'La factura aún no tiene reparto calculado.');
    db.prepare(`UPDATE bills SET status = 'sent' WHERE id = ?`).run(bill.id);
    return { ok: true };
  }

  /** Variables for the WhatsApp templates + recipients. */
  function message(billId) {
    const bill = getBill(billId);
    const split = db.prepare('SELECT * FROM splits WHERE bill_id = ?').get(bill.id);
    const ppl = people();
    const recipients = ['yann', 'adriana', 'marcela', 'neighbor']
      .filter((r) => ppl[r]?.wa_phone)
      .map((r) => ({ role: r, name: ppl[r].name, wa_phone: ppl[r].wa_phone }));
    return {
      bill_id: bill.id,
      invoice_no: bill.invoice_no,
      status: bill.status,
      url: `${publicUrl}/bills/${bill.id}`,
      neighbor: ppl.neighbor ? { name: ppl.neighbor.name, wa_phone: ppl.neighbor.wa_phone } : null,
      yann: ppl.yann ? { name: ppl.yann.name, wa_phone: ppl.yann.wa_phone } : null,
      recipients,
      request_vars: [ppl.neighbor?.name ?? 'vecino', esDate(bill.period_from), esDate(bill.period_to)],
      split_vars: split
        ? [
            bill.invoice_no, esDate(bill.period_from), esDate(bill.period_to), formatEurPlain(bill.total_cents),
            esKwh(split.neighbor_kwh), formatEurPlain(split.neighbor_cents), formatEurPlain(split.marcela_cents),
            formatEurPlain(split.yann_adriana_cents), `${publicUrl}/bills/${bill.id}`,
          ]
        : null,
    };
  }

  function listBills() {
    return db.prepare(`
      SELECT b.*, s.neighbor_kwh, s.neighbor_cents, s.home_cents, s.marcela_cents, s.yann_adriana_cents, s.sent_at,
        (SELECT group_concat(payer) FROM payments p WHERE p.bill_id = b.id) AS paid_by
      FROM bills b LEFT JOIN splits s ON s.bill_id = b.id
      ORDER BY b.period_to DESC, b.id DESC`).all();
  }

  function billDetail(id) {
    const bill = getBill(id);
    const split = db.prepare('SELECT * FROM splits WHERE bill_id = ?').get(bill.id);
    return {
      bill,
      split: split ? { ...split, breakdown: JSON.parse(split.breakdown_json) } : null,
      readings: db.prepare('SELECT * FROM readings WHERE bill_id = ? ORDER BY id DESC').all(bill.id),
      previous: previousReading(bill),
      payments: db.prepare('SELECT * FROM payments WHERE bill_id = ?').all(bill.id),
      people: people(),
    };
  }

  function togglePaid(billId, payer) {
    const split = db.prepare('SELECT * FROM splits WHERE bill_id = ?').get(billId);
    if (!split) throw new HttpError(409, 'Sin reparto calculado.');
    const exists = db.prepare('SELECT 1 FROM payments WHERE bill_id = ? AND payer = ?').get(billId, payer);
    if (exists) db.prepare('DELETE FROM payments WHERE bill_id = ? AND payer = ?').run(billId, payer);
    else {
      const amount = payer === 'neighbor' ? split.neighbor_cents : split.marcela_cents;
      db.prepare('INSERT INTO payments (bill_id, payer, amount_cents) VALUES (?, ?, ?)').run(billId, payer, amount);
    }
  }

  function latestReadingForNew() {
    return (
      db.prepare(`SELECT r.reading_kwh FROM readings r JOIN bills b ON b.id = r.bill_id WHERE r.status = 'confirmed' ORDER BY b.period_to DESC, r.id DESC LIMIT 1`).get() ??
      db.prepare(`SELECT reading_kwh FROM readings WHERE status = 'seed' ORDER BY id DESC LIMIT 1`).get() ??
      null
    )?.reading_kwh ?? null;
  }

  return {
    filesDir, saveFile, getBill, people, roleByPhone, latestBill, previousReading, createBill, openBill, addCandidate,
    confirm, markSent, message, listBills, billDetail, togglePaid, latestReadingForNew,
  };
}
