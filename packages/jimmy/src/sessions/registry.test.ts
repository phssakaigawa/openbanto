import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "./registry.js";

test("migrateSessionsSchema upgrades an old sessions table before session_key usage", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      engine_session_id TEXT,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      employee TEXT,
      model TEXT,
      status TEXT DEFAULT 'idle',
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_error TEXT
    )
  `);
  db.exec(`
    INSERT INTO sessions (
      id, engine, engine_session_id, source, source_ref, employee, model, status, created_at, last_activity, last_error
    ) VALUES (
      's1', 'claude', NULL, 'slack', 'slack:C123', NULL, NULL, 'idle', '2026-03-10T00:00:00.000Z', '2026-03-10T00:00:00.000Z', NULL
    )
  `);

  migrateSessionsSchema(db);

  const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((col) => col.name));
  assert.equal(names.has("session_key"), true);
  assert.equal(names.has("connector"), true);
  assert.equal(names.has("reply_context"), true);
  assert.equal(names.has("message_id"), true);
  assert.equal(names.has("transport_meta"), true);

  const row = db.prepare("SELECT session_key, connector FROM sessions WHERE id = 's1'").get() as {
    session_key: string | null;
    connector: string | null;
  };
  assert.equal(row.session_key, "slack:C123");
  assert.equal(row.connector, "slack");
});
