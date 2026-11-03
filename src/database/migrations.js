/**
 * Invest With Clarity - Additive Schema Migrations
 * schema.sql only runs CREATE TABLE IF NOT EXISTS, so a database created by an
 * earlier version never picks up new columns. These migrations add them in place
 * without touching existing rows' data.
 */

function columnExists(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

function addColumn(db, table, column, definition) {
  if (columnExists(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[Migration] Added ${table}.${column}`);
  return true;
}

function runMigrations(db) {
  // Campaign lifecycle columns
  const addedStatus = addColumn(db, 'campaigns', 'status', "TEXT DEFAULT 'ACTIVE'");
  addColumn(db, 'campaigns', 'last_error', 'TEXT');
  addColumn(db, 'campaigns', 'last_activity_at', 'DATETIME');

  // Backfill status from the legacy is_active flag on first upgrade only.
  if (addedStatus) {
    db.exec(`UPDATE campaigns SET status = CASE WHEN is_active = 1 THEN 'ACTIVE' ELSE 'PAUSED' END`);
    console.log('[Migration] Backfilled campaign status from is_active');
  }

  // Any row that predates the column default, or was written by a raw INSERT,
  // still needs a status so the dashboard never shows a blank state.
  db.exec(`UPDATE campaigns SET status = CASE WHEN is_active = 1 THEN 'ACTIVE' ELSE 'PAUSED' END
           WHERE status IS NULL OR status = ''`);

  // Post cache columns that arrived after the table
  addColumn(db, 'instagram_posts', 'is_manual', 'INTEGER DEFAULT 0');

  // Delivery outcome detail on each comment. Without these a comment that failed
  // once could never be retried and the creator could not see WHY it failed.
  addColumn(db, 'processed_comments', 'error_category', 'TEXT');
  addColumn(db, 'processed_comments', 'attempts', 'INTEGER DEFAULT 0');
  addColumn(db, 'processed_comments', 'last_attempt_at', 'DATETIME');

  // A delivered private reply lands in the person's Message Requests folder.
  // Until they accept it, Meta opens no 24-hour window and no follow-up can be
  // sent. That waiting state is a normal, successful outcome, not a failure,
  // so it gets its own column instead of being read as "stuck".
  addColumn(db, 'user_threads', 'dm_state', 'TEXT');
  addColumn(db, 'user_threads', 'dm_state_at', 'DATETIME');

  // Existing threads: anyone who has written to us has accepted the request.
  db.exec(`UPDATE user_threads
              SET dm_state = CASE WHEN last_inbound_time IS NOT NULL THEN 'accepted'
                                  ELSE 'pending_acceptance' END,
                  dm_state_at = COALESCE(last_inbound_time, updated_at)
            WHERE dm_state IS NULL`);

  addColumn(db, 'outbound_messages', 'error_category', 'TEXT');

  // instagram_posts.comments_count is Instagram's own total: it includes replies
  // to comments AND our own account's replies. Comparing it against the comments
  // the automation handled therefore reports a shortfall that does not exist.
  // These hold what the API actually exposes, recorded by a comment sync.
  // How a campaign delivers what it promised.
  //
  //   two_step  - first DM asks the person to reply; the report is sent after
  //               they do. This is the better experience AND the one that can
  //               gate on following, but every follow-up send needs an open
  //               messaging window, which needs the app subscribed to the
  //               account's `messages` webhook.
  //   one_shot  - everything goes in the first DM. A private reply to a comment
  //               needs no window at all, so this works with no Meta setup
  //               beyond what is already granted.
  //
  // Defaulting to one_shot would silently change existing campaigns, so the
  // default stays two_step and the dashboard recommends switching when it
  // detects that follow-ups cannot send.
  addColumn(db, 'campaigns', 'delivery_mode', "TEXT DEFAULT 'two_step'");
  db.exec("UPDATE campaigns SET delivery_mode = 'two_step' WHERE delivery_mode IS NULL OR delivery_mode = ''");

  addColumn(db, 'instagram_posts', 'api_comment_count', 'INTEGER');
  addColumn(db, 'instagram_posts', 'eligible_comment_count', 'INTEGER');
  addColumn(db, 'instagram_posts', 'last_comment_sync_at', 'DATETIME');

  // Indexes on columns this file adds must be created here, not in schema.sql,
  // because schema.sql runs before these ALTER TABLE statements.
  db.exec('CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_processed_comments_private_status ON processed_comments(private_reply_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_user_threads_dm_state ON user_threads(dm_state)');
}

module.exports = { runMigrations, columnExists, addColumn };
