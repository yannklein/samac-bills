// Run SQL against the app database (inside the container: Coolify -> Terminal).
//   node scripts/sql.js "SELECT id, invoice_no, status FROM bills"
//   node scripts/sql.js --full "SELECT * FROM splits"      (don't truncate long values)
//   node scripts/sql.js --backup                            (copy the DB to /data/backup-<timestamp>.db first!)
//   echo "UPDATE ...; UPDATE ...;" | node scripts/sql.js    (several statements from stdin)
import Database from 'better-sqlite3';
import { readFileSync, fstatSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const full = args.includes('--full');
const dataDir = process.env.DATA_DIR || '/data';
const db = new Database(path.join(dataDir, 'samac.db'));
db.pragma('foreign_keys = ON');

if (args.includes('--backup')) {
  const file = path.join(dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${file}'`);
  console.log(`backup written: ${file}`);
  if (args.length === 1) process.exit(0);
}

const fromStdin = () => {
  try {
    const st = fstatSync(0);
    return st.isFIFO() || st.isFile() ? readFileSync(0, 'utf8') : '';
  } catch {
    return '';
  }
};
const sql = (args.find((a) => !a.startsWith('--')) ?? fromStdin()).trim();
if (!sql) {
  console.log('Tables:');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
    console.log(`  ${name}(${db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name).join(', ')})`);
  }
  process.exit(0);
}

const cut = (v) => (!full && typeof v === 'string' && v.length > 60 ? `${v.slice(0, 57)}...` : v);
try {
  const stmt = db.prepare(sql);
  if (stmt.reader) {
    const rows = stmt.all().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cut(v)])));
    console.table(rows);
    console.log(`${rows.length} row(s)`);
  } else {
    console.log(stmt.run());
  }
} catch (e) {
  if (!/more than one statement/i.test(e.message)) throw e;
  db.transaction(() => db.exec(sql))();
  console.log('OK (several statements, run in one transaction)');
}
