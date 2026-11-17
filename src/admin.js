// Admin operations behind the web "Admin" pages (Yann only): people, seed reading,
// editing / deleting bills, backups. Every change that touches amounts recalculates the split.
import { readFileSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { splitLuz } from './splitLuz.js';
import { HttpError } from './service.js';

export const ROLES = ['yann', 'adriana', 'marcela', 'neighbor'];
export const ROLE_LABELS = { yann: 'Yann', adriana: 'Adriana', marcela: 'Marcela', neighbor: 'Neighbor' };

export function makeAdmin({ db, svc, dataDir }) {
  function listPeople() {
    const rows = db.prepare('SELECT * FROM people').all();
    return ROLES.map((role) => rows.find((r) => r.role === role) ?? { role, missing: true });
  }

  function savePerson({ role, name, wa_phone, email }) {
    if (!ROLES.includes(role)) throw new HttpError(400, `Unknown role "${role}".`);
    const cleanName = String(name ?? '').trim();
    if (!cleanName) throw new HttpError(422, 'Name is required.');
    const phone = String(wa_phone ?? '').replace(/\D/g, '');
    if (phone && (phone.length < 8 || phone.length > 15)) {
      throw new HttpError(422, `WhatsApp number "${wa_phone}" looks wrong: use the full number with country code, e.g. 34612345678.`);
    }
    const mail = String(email ?? '').trim().toLowerCase();
    if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new HttpError(422, `Email "${email}" looks wrong.`);
    db.prepare(`INSERT INTO people (role, name, wa_phone, email) VALUES (?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET name = excluded.name, wa_phone = excluded.wa_phone, email = excluded.email`)
      .run(role, cleanName, phone || null, mail || null);
  }

  function deletePerson(role) {
    if (role === 'yann') throw new HttpError(422, 'Yann cannot be removed: all notices go to him.');
    db.prepare('DELETE FROM people WHERE role = ?').run(role);
  }

  const currentSeed = () => db.prepare(`SELECT * FROM readings WHERE status = 'seed' ORDER BY id DESC LIMIT 1`).get() ?? null;

  /**
   * Recalculate a bill's split from its line items. Neighbor kWh comes from `neighborKwh`, else from the
   * confirmed meter reading minus the previous reading, else the kWh already stored.
   * Amounts may change, so the bill goes back to "ready" (to be re-sent) and paid marks are cleared.
   */
  function recompute(billId, { neighborKwh } = {}) {
    const bill = svc.getBill(billId);
    const split = db.prepare('SELECT * FROM splits WHERE bill_id = ?').get(bill.id);
    if (!split) return false;
    const confirmed = db.prepare(`SELECT * FROM readings WHERE bill_id = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 1`).get(bill.id);
    const prev = svc.previousReading(bill);
    let kwh = neighborKwh;
    if (kwh == null && confirmed?.reading_kwh != null && prev?.reading_kwh != null) {
      kwh = Math.round((confirmed.reading_kwh - prev.reading_kwh) * 1000) / 1000;
    }
    if (kwh == null) kwh = split.neighbor_kwh;
    let s;
    try {
      s = splitLuz(bill.items, { kwhTotal: bill.kwh_total, neighborKwh: kwh, totalCents: bill.total_cents });
    } catch (e) {
      throw new HttpError(422, `${bill.invoice_no}: ${e.message}`);
    }
    db.transaction(() => {
      db.prepare(`UPDATE splits SET previous_reading_kwh = ?, neighbor_kwh = ?, home_kwh = ?, breakdown_json = ?,
          neighbor_cents = ?, home_cents = ?, marcela_cents = ?, yann_adriana_cents = ?, computed_at = datetime('now'), sent_at = NULL
        WHERE bill_id = ?`)
        .run(prev?.reading_kwh ?? null, kwh, s.homeKwh, JSON.stringify(s), s.neighborCents, s.homeCents, s.marcelaCents, s.yannAdrianaCents, bill.id);
      db.prepare(`UPDATE bills SET status = 'ready', status_note = NULL WHERE id = ?`).run(bill.id);
      db.prepare('DELETE FROM payments WHERE bill_id = ?').run(bill.id);
    })();
    return true;
  }

  /** New seed (previous) reading. Unsent bills whose previous reading is the seed are recalculated. */
  function setSeed(value) {
    if (!Number.isFinite(value) || value < 0) throw new HttpError(422, 'Enter a valid meter reading.');
    db.prepare(`INSERT INTO readings (bill_id, reading_kwh, source, status) VALUES (NULL, ?, 'seed', 'seed')`).run(value);
    const recalculated = [];
    const skippedSent = [];
    for (const b of db.prepare(`SELECT b.id, b.invoice_no, b.status FROM bills b JOIN splits s ON s.bill_id = b.id`).all()) {
      if (svc.previousReading(svc.getBill(b.id))?.status !== 'seed') continue;
      if (b.status === 'sent') skippedSent.push(b.invoice_no);
      else if (recompute(b.id)) recalculated.push(b.invoice_no);
    }
    return { recalculated, skippedSent };
  }

  function updateBill(billId, f) {
    const bill = svc.getBill(billId);
    const invoiceNo = String(f.invoice_no ?? '').trim();
    if (!invoiceNo) throw new HttpError(422, 'Missing invoice number.');
    if (!f.period_from || !f.period_to) throw new HttpError(422, 'Missing billing period.');
    if (!(f.total_cents > 0) || !(f.kwh_total > 0)) throw new HttpError(422, 'Total and kWh must be greater than 0.');
    if (!f.items?.length) throw new HttpError(422, 'A bill needs at least one line.');
    const bad = f.items.filter((i) => !['fixed', 'variable', 'tax'].includes(i.kind) || !Number.isFinite(i.amountCents) || !i.label);
    if (bad.length) throw new HttpError(422, `Check these lines (label, split type and amount): ${bad.map((i) => i.label || '(no label)').join(', ')}`);
    const sum = f.items.reduce((s, i) => s + i.amountCents, 0);
    if (Math.abs(sum - f.total_cents) > 1) {
      throw new HttpError(422, `Lines add up to €${(sum / 100).toFixed(2)}, but the total is €${(f.total_cents / 100).toFixed(2)}.`);
    }
    if (db.prepare('SELECT 1 FROM bills WHERE invoice_no = ? AND id != ?').get(invoiceNo, bill.id)) {
      throw new HttpError(409, `Another bill already has invoice number ${invoiceNo}.`);
    }
    db.prepare(`UPDATE bills SET invoice_no = ?, period_from = ?, period_to = ?, days = ?, issued_at = ?,
        total_cents = ?, kwh_total = ?, items_json = ? WHERE id = ?`)
      .run(invoiceNo, f.period_from, f.period_to, f.days || null, f.issued_at || null, f.total_cents, f.kwh_total, JSON.stringify(f.items), bill.id);
    return { recalculated: recompute(bill.id) };
  }

  /** Delete a bill with its readings, split, payments and evidence files. */
  function deleteBill(billId) {
    const bill = svc.getBill(billId);
    const files = [bill.pdf_path, ...db.prepare('SELECT photo_path FROM readings WHERE bill_id = ?').all(bill.id).map((r) => r.photo_path)]
      .filter(Boolean);
    db.transaction(() => {
      for (const t of ['payments', 'splits', 'readings']) db.prepare(`DELETE FROM ${t} WHERE bill_id = ?`).run(bill.id);
      db.prepare('DELETE FROM bills WHERE id = ?').run(bill.id);
    })();
    for (const f of new Set(files)) {
      try { unlinkSync(path.join(svc.filesDir, f)); } catch { /* already gone */ }
    }
    return bill.invoice_no;
  }

  /** Consistent copy of the whole database (safe while the app is running). */
  function backup() {
    const file = path.join(dataDir, `.backup-${process.pid}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    try {
      return readFileSync(file);
    } finally {
      rmSync(file, { force: true });
    }
  }

  return { listPeople, savePerson, deletePerson, currentSeed, setSeed, recompute, updateBill, deleteBill, backup };
}
