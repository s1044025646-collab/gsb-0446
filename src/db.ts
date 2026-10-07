import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RULE_VERSION } from './constants.js';

export interface DbRow {
  id: number;
  import_id: number;
  line_no: number;
  raw: string;
  source: string;
  date_utc: string | null;
  sentence_type: 'GGA' | 'RMC' | null;
  time_text: string | null;
  second_key: string | null;
  valid_fix: number | null;
  lat: number | null;
  lon: number | null;
  quality: number | null;
  speed_knots: number | null;
  speed_mps: number | null;
  status: string | null;
  fraction: string | null;
  parse_ok: number;
  error_code: string | null;
  error_message: string | null;
  dedup_count: number;
}

export function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      default_date_utc TEXT NOT NULL,
      request_id TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(source, request_id)
    );
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES imports(id),
      source TEXT NOT NULL,
      date_utc TEXT,
      line_no INTEGER NOT NULL,
      raw TEXT NOT NULL,
      parse_ok INTEGER NOT NULL,
      error_code TEXT,
      error_message TEXT,
      sentence_type TEXT,
      time_text TEXT,
      hour INTEGER,
      minute INTEGER,
      second INTEGER,
      fraction TEXT,
      second_key TEXT,
      valid_fix INTEGER,
      lat REAL,
      lon REAL,
      quality INTEGER,
      speed_knots REAL,
      speed_mps REAL,
      status TEXT,
      dedup_count INTEGER NOT NULL DEFAULT 1,
      UNIQUE(import_id, raw)
    );
    CREATE INDEX IF NOT EXISTS idx_records_group
      ON records(source, date_utc, second_key, sentence_type);
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      tolerance_deg REAL NOT NULL,
      rule_version TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      source_filter TEXT,
      date_filter TEXT
    );
  `);
  return db;
}

export { RULE_VERSION };
