// Usage: DATA_DIR=/data node scripts/seed.js people.json
// people.json: see people.example.json. Upserts people and (optionally) the seed meter reading.
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/seed.js people.json');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(file, 'utf8'));
const db = openDb(process.env.DATA_DIR || '/data');

const up = db.prepare(`INSERT INTO people (role, name, wa_phone, email) VALUES (@role, @name, @wa_phone, @email)
  ON CONFLICT(role) DO UPDATE SET name = excluded.name, wa_phone = excluded.wa_phone, email = excluded.email`);
for (const p of cfg.people ?? []) {
  up.run({ email: null, wa_phone: null, ...p, wa_phone: p.wa_phone ? String(p.wa_phone).replace(/\D/g, '') : null });
  console.log(`person ${p.role}: ${p.name}`);
}
if (cfg.seed_reading != null) {
  db.prepare(`INSERT INTO readings (bill_id, reading_kwh, source, status) VALUES (NULL, ?, 'seed', 'seed')`).run(Number(cfg.seed_reading));
  console.log(`seed reading: ${cfg.seed_reading}`);
}
