import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  role TEXT PRIMARY KEY CHECK (role IN ('yann','adriana','marcela','neighbor')),
  name TEXT NOT NULL,
  wa_phone TEXT,
  email TEXT
);
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY,
  utility TEXT NOT NULL DEFAULT 'luz',
  invoice_no TEXT NOT NULL UNIQUE,
  period_from TEXT, period_to TEXT, days INTEGER, issued_at TEXT,
  total_cents INTEGER NOT NULL,
  kwh_total REAL NOT NULL,
  items_json TEXT NOT NULL,
  pdf_path TEXT,
  source TEXT NOT NULL CHECK (source IN ('auto','manual')),
  status TEXT NOT NULL CHECK (status IN ('awaiting_reading','awaiting_confirmation','ready','sent','superseded','error')),
  status_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Neighbor meter readings. bill_id NULL = seed (last known reading before the app existed).
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER REFERENCES bills(id),
  reading_kwh REAL, -- NULL only for a candidate photo the model could not read
  photo_path TEXT,
  source TEXT NOT NULL CHECK (source IN ('seed','vision','typed','override','manual')),
  status TEXT NOT NULL CHECK (status IN ('seed','candidate','confirmed','replaced')),
  confidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS splits (
  bill_id INTEGER PRIMARY KEY REFERENCES bills(id),
  previous_reading_kwh REAL,
  reading_kwh REAL,
  neighbor_kwh REAL NOT NULL,
  home_kwh REAL NOT NULL,
  breakdown_json TEXT NOT NULL,
  neighbor_cents INTEGER NOT NULL,
  home_cents INTEGER NOT NULL,
  marcela_cents INTEGER NOT NULL,
  yann_adriana_cents INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  payer TEXT NOT NULL CHECK (payer IN ('neighbor','marcela')),
  amount_cents INTEGER NOT NULL,
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bill_id, payer)
);
`;

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'samac.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
