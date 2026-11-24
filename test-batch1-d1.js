// Batch 1 (v3.1) D1 SQL verification (local SQLite = D1 engine).
// 1. Fresh DB from the NEW schema.sql has all v3.1 columns/tables.
// 2. Migration 001 applies cleanly to an OLD-schema DB (pre-v3.1 shares).
// 3. The atomic UPDATE behaves: limited counts to max then 0; unlimited always 1.
// 4. pickup_code UNIQUE index rejects duplicates but allows many NULLs.
// Run: node test-batch1-d1.js

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

let passed = 0, failed = 0;
function step(name, cond, detail) {
  if (cond) passed++; else { failed++; console.error('FAIL:', name, JSON.stringify(detail)); }
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
}

const schemaSql = fs.readFileSync(new URL('./src/schema.sql', import.meta.url), 'utf8');
const migrationSql = fs.readFileSync(new URL('./src/migrations/001_v31_features.sql', import.meta.url), 'utf8');

// --- 1. fresh DB from NEW schema.sql ---
{
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  const cols = db.prepare("SELECT name FROM pragma_table_info('shares')").all().map((r) => r.name);
  step('fresh schema: shares has new cols', ['max_downloads', 'used_downloads', 'pickup_code'].every((c) => cols.includes(c)), cols);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  step('fresh schema: api_tokens + drop_links exist', tables.includes('api_tokens') && tables.includes('drop_links'), tables);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='shares'").all().map((r) => r.name);
  step('fresh schema: pickup unique index exists', idx.includes('idx_shares_pickup_code'), idx);
  db.close();
}

// --- 2. migration applies to an OLD-schema DB ---
{
  const db = new DatabaseSync(':memory:');
  // Minimal OLD schema (pre-v3.1): shares without the new columns, no api_tokens/drop_links.
  db.exec(`
    CREATE TABLE shares (token TEXT PRIMARY KEY, file_id TEXT, folder_id TEXT,
      code TEXT NOT NULL DEFAULT '', burn INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX idx_shares_file ON shares(file_id);
    CREATE TABLE files (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO shares (token, file_id, code, burn, created_at) VALUES ('tok-old','f1','',0,1000)").run();
  db.exec(migrationSql); // must not throw
  const cols = db.prepare("SELECT name FROM pragma_table_info('shares')").all().map((r) => r.name);
  step('migration: new cols added', ['max_downloads', 'used_downloads', 'pickup_code'].every((c) => cols.includes(c)), cols);
  const old = db.prepare('SELECT max_downloads, used_downloads, pickup_code FROM shares WHERE token=?').get('tok-old');
  step('migration: old row defaults (0,0,NULL)', old.max_downloads === 0 && old.used_downloads === 0 && old.pickup_code === null, old);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  step('migration: api_tokens + drop_links created', tables.includes('api_tokens') && tables.includes('drop_links'), tables);
  // idempotency: running the migration a second time must not fail (IF NOT EXISTS guards;
  // the ALTERs would fail on re-run, so a real second run is NOT expected — skip).
  db.close();
}

// --- 3. atomic UPDATE + unique index behaviour ---
{
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  const upd = db.prepare(
    'UPDATE shares SET used_downloads = used_downloads + 1 WHERE token = ? AND (max_downloads = 0 OR used_downloads < max_downloads)');
  const ins = db.prepare(
    "INSERT INTO shares (token, file_id, code, burn, max_downloads, used_downloads, pickup_code, created_at) VALUES (?,?,?,?,?,?,?,?)");
  ins.run('tok-lim', 'f1', '', 0, 2, 0, 'ABC12', 1000);
  ins.run('tok-unlim', 'f2', '', 0, 0, 0, 'XYZ99', 1000);
  const get = (t) => db.prepare('SELECT used_downloads FROM shares WHERE token=?').get(t).used_downloads;
  step('limited: 1st increment changes=1', upd.run('tok-lim').changes === 1 && get('tok-lim') === 1, null);
  step('limited: 2nd increment changes=1', upd.run('tok-lim').changes === 1 && get('tok-lim') === 2, null);
  step('limited: 3rd increment changes=0 (exhausted)', upd.run('tok-lim').changes === 0 && get('tok-lim') === 2, null);
  step('unlimited: increments always succeed', upd.run('tok-unlim').changes === 1 && upd.run('tok-unlim').changes === 1 && get('tok-unlim') === 2, null);
  step('missing token: changes=0', upd.run('tok-nope').changes === 0, null);
  // unique index: duplicate pickup_code rejected, many NULLs allowed
  let dupErr = null;
  try { ins.run('tok-dup', 'f3', '', 0, 0, 0, 'ABC12', 1000); } catch (e) { dupErr = e; }
  step('pickup_code duplicate rejected', !!dupErr && /UNIQUE/i.test(dupErr.message || ''), dupErr && dupErr.message);
  ins.run('tok-null1', 'f4', '', 0, 0, 0, null, 1000);
  ins.run('tok-null2', 'f5', '', 0, 0, 0, null, 1000);
  step('pickup_code many NULLs allowed', true, null);
  // api_tokens: hash unique
  db.prepare("INSERT INTO api_tokens (id, name, token_hash, prefix, scope, last_used_at, created_at) VALUES ('t1','a','h1','rbx_aaaa','upload',NULL,1000)").run();
  let hDup = null;
  try { db.prepare("INSERT INTO api_tokens (id, name, token_hash, prefix, scope, last_used_at, created_at) VALUES ('t2','b','h1','rbx_bbbb','upload',NULL,1000)").run(); } catch (e) { hDup = e; }
  step('api_tokens token_hash unique', !!hDup && /UNIQUE/i.test(hDup.message || ''), hDup && hDup.message);
  db.close();
}

console.log(`\n=== Batch 1 D1 SQL: passed ${passed}, failed ${failed} ===`);
process.exit(failed ? 1 : 0);
