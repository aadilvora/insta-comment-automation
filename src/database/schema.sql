-- Invest With Clarity: Instagram Automation Database Schema (SQLite)

-- 1. Campaigns Table
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    post_id TEXT NOT NULL,
    keywords TEXT NOT NULL, -- JSON array of strings, e.g. ["IPO", "REPORT", "JIO"]
    match_type TEXT DEFAULT 'contains', -- 'contains' or 'exact'
    public_reply_enabled INTEGER DEFAULT 1, -- 1 = true, 0 = false
    public_reply_text TEXT NOT NULL,
    initial_private_reply_text TEXT NOT NULL,
    follow_up_enabled INTEGER DEFAULT 1,
    follow_up_text TEXT,
    follower_reminder_text TEXT,
    report_text TEXT,
    is_active INTEGER DEFAULT 1, -- 1 = active, 0 = not sending (kept in sync with status)
    status TEXT DEFAULT 'ACTIVE', -- 'DRAFT', 'ACTIVE', 'PAUSED', 'STOPPED', 'ERROR'
    last_error TEXT,
    last_activity_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaigns_post_id ON campaigns(post_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_is_active ON campaigns(is_active);
-- idx_campaigns_status is created in migrations.js, after the status column exists
-- on databases that were created before that column was introduced.

-- 2. Processed Comments Table (Deduplication & Single-Reply enforcement)
CREATE TABLE IF NOT EXISTS processed_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id TEXT UNIQUE NOT NULL,
    post_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT,
    comment_text TEXT NOT NULL,
    comment_time DATETIME,
    matched_campaign_id INTEGER,
    public_reply_status TEXT DEFAULT 'pending', -- 'pending', 'sent', 'failed', 'disabled'
    public_reply_id TEXT,
    private_reply_status TEXT DEFAULT 'pending', -- 'pending', 'sent', 'failed', 'already_replied'
    private_reply_id TEXT,
    error_reason TEXT,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(matched_campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_comments_comment_id ON processed_comments(comment_id);
CREATE INDEX IF NOT EXISTS idx_processed_comments_user_id ON processed_comments(user_id);

-- 3. User Threads Table (Tracks 24h messaging window and conversation stage)
CREATE TABLE IF NOT EXISTS user_threads (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_inbound_time DATETIME,
    messaging_window_expires_at DATETIME,
    is_following INTEGER DEFAULT NULL, -- 1 = yes, 0 = no, NULL = unverified
    follower_checked_at DATETIME,
    current_campaign_id INTEGER,
    conversation_stage TEXT DEFAULT 'initial', -- 'initial', 'awaiting_reply', 'follow_verified', 'report_delivered', 'opted_out'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(current_campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

-- 4. Outbound Messages Table (Audit trail of every sent message)
CREATE TABLE IF NOT EXISTS outbound_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    comment_id TEXT,
    campaign_id INTEGER,
    message_type TEXT NOT NULL, -- 'public_reply', 'private_reply', 'follow_up', 'report', 'reminder'
    message_content TEXT NOT NULL,
    meta_message_id TEXT,
    status TEXT NOT NULL, -- 'sent', 'failed', 'blocked_by_policy'
    error_message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_comment_id ON outbound_messages(comment_id);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_user_id ON outbound_messages(user_id);

-- 5. Activity Logs Table (System observability & dashboard stream)
CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    campaign_id INTEGER,
    post_id TEXT,
    comment_id TEXT,
    user_id TEXT,
    action TEXT NOT NULL,
    status TEXT NOT NULL, -- 'SUCCESS', 'FAILURE', 'SKIPPED', 'WARNING'
    details TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON activity_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action);

-- 6. System Settings Table
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert Default Settings
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('emergency_stop', 'false');
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('automation_paused', 'false');
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('request_delay_ms', '1500');
-- Poll Instagram for comments as well as listening for webhooks. A webhook is
-- delivered once; if the callback URL is unreachable that comment is lost for
-- good. Polling makes replies work without any public URL at all.
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('comment_polling_enabled', 'true');
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('comment_poll_interval_s', '60');

-- 7. Instagram Posts / Reels Cache
-- Stores media metadata synced from GET /{ig-user-id}/media so each Reel can be
-- rendered as its own card with thumbnail, caption and publish date.
CREATE TABLE IF NOT EXISTS instagram_posts (
    post_id TEXT PRIMARY KEY,
    media_type TEXT,            -- IMAGE, VIDEO, CAROUSEL_ALBUM, REELS
    media_product_type TEXT,    -- FEED, REELS, STORY
    caption TEXT,
    permalink TEXT,
    thumbnail_url TEXT,
    media_url TEXT,
    published_at DATETIME,
    comments_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_manual INTEGER DEFAULT 0 -- 1 = added by hand (no Meta connection yet)
);

CREATE INDEX IF NOT EXISTS idx_instagram_posts_published ON instagram_posts(published_at);

-- 8. Reusable Message Templates
CREATE TABLE IF NOT EXISTS message_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    message_type TEXT NOT NULL, -- 'public_reply', 'private_reply', 'follow_up', 'reminder', 'report'
    body TEXT NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_message_templates_type ON message_templates(message_type);

-- 10. Processed Inbound Messages (deduplication for DM polling)
-- Inbound DMs are read from the conversation edge as well as arriving by
-- webhook. Without this table a poll would re-answer the same message on every
-- cycle, and a first run would reply to the entire DM history.
CREATE TABLE IF NOT EXISTS processed_messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    user_id TEXT,
    message_text TEXT,
    processed INTEGER DEFAULT 0, -- 1 = ran through the automation, 0 = recorded only
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_user ON processed_messages(user_id);

-- 9. Campaign Status History (audit trail of every start/pause/resume/stop)
CREATE TABLE IF NOT EXISTS campaign_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_campaign_status_history_campaign ON campaign_status_history(campaign_id);
