/**
 * Invest With Clarity - SQLite Database Module
 * Uses Node.js native DatabaseSync for rock-solid local storage.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { runMigrations } = require('./migrations');

let dbInstance = null;

function initDatabase(dbFilePath = null) {
  if (dbInstance) {
    return dbInstance;
  }

  const resolvedPath = dbFilePath || path.resolve(__dirname, '../../automation.db');
  dbInstance = new DatabaseSync(resolvedPath);

  // Enable WAL mode & foreign keys for performance and integrity
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  try {
    dbInstance.exec('PRAGMA journal_mode = WAL;');
  } catch (e) {
    // In-memory or restricted filesystems might ignore WAL
  }

  // Load and execute schema
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    dbInstance.exec(schemaSql);
  }

  // Bring databases created by earlier versions up to the current shape
  runMigrations(dbInstance);

  return dbInstance;
}

function getDb() {
  if (!dbInstance) {
    initDatabase();
  }
  return dbInstance;
}

function queryAll(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

function queryOne(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.get(...params);
}

function execute(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.run(...params);
}

// System Settings Helpers
function getSetting(key, defaultValue = null) {
  const row = queryOne('SELECT value FROM system_settings WHERE key = ?', [key]);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  execute(
    `INSERT INTO system_settings (key, value, updated_at) 
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, String(value)]
  );
}

function isEmergencyStopActive() {
  return getSetting('emergency_stop', 'false') === 'true';
}

function isAutomationPaused() {
  return getSetting('automation_paused', 'false') === 'true';
}

module.exports = {
  initDatabase,
  getDb,
  queryAll,
  queryOne,
  execute,
  getSetting,
  setSetting,
  isEmergencyStopActive,
  isAutomationPaused
};
