// Usage: DATA_DIR=/data node scripts/seed.js people.json [--reset]
// people.json: see people.example.json. Upserts people and (optionally) adds the seed meter reading.
// --reset deletes ALL bills, readings, splits, payments, stored files (PDFs/photos) and people first,
// so the people list becomes exactly the file (e.g. no neighbor = Yann relays the meter photo).
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node scripts/seed.js people.json [--reset]');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(file, 'utf8'));
const dataDir = process.env.DATA_DIR || '/data';
const db = openDb(dataDir);

if (reset) {
  const counts = db.transaction(() => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM bills').get().n;
    db.exec('DELETE FROM payments; DELETE FROM splits; DELETE FROM readings; DELETE FROM bills; DELETE FROM people;');
    return n;
  })();
  rmSync(path.join(dataDir, 'files'), { recursive: true, force: true });
  console.log(`reset: deleted ${counts} bill(s), all readings, splits, payments, stored files and people`);
}

const up = db.prepare(`INSERT INTO people (role, name, wa_phone, email) VALUES (@role, @name, @wa_phone, @email)
  ON CONFLICT(role) DO UPDATE SET name = excluded.name, wa_phone = excluded.wa_phone, email = excluded.email`);
for (const p of cfg.people ?? []) {
  up.run({ email: null, ...p, wa_phone: p.wa_phone ? String(p.wa_phone).replace(/\D/g, '') : null });
  console.log(`person ${p.role}: ${p.name}`);
}
if (cfg.seed_reading != null) {
  db.prepare(`INSERT INTO readings (bill_id, reading_kwh, source, status) VALUES (NULL, ?, 'seed', 'seed')`).run(Number(cfg.seed_reading));
  console.log(`seed reading: ${cfg.seed_reading}`);
}
