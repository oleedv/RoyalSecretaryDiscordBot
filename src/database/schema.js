import { query } from './connection.js';
import logger from '../logger.js';

const log = logger.child({ module: 'schema' });

export async function initSchema() {
  log.info('Initializing database schema...');

  await query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uuid CHAR(36) NOT NULL UNIQUE,
      channel_id VARCHAR(20) NOT NULL,
      user_id VARCHAR(20) NOT NULL,
      status ENUM('open', 'closing', 'closed') DEFAULT 'open',
      tier ENUM('normal', 'community_officer', 'admin_officer') DEFAULT 'normal',
      reason TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP NULL,
      closed_by VARCHAR(20) NULL
    )
  `);

  // Ticket table migrations
  // MODIFY COLUMN has no IF NOT EXISTS in MariaDB — .catch() keeps re-runs safe
  await query(`ALTER TABLE tickets MODIFY COLUMN status ENUM('open', 'closing', 'closed') DEFAULT 'open'`).catch(e => log.warn({ err: e.message }, 'tickets.status MODIFY skipped'));
  await query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reason TEXT NULL`);
  await query(`ALTER TABLE tickets MODIFY COLUMN tier ENUM('normal','community_officer','admin_officer','comp_team','whitelist') DEFAULT 'normal'`).catch(e => log.warn({ err: e.message }, 'tickets.tier MODIFY skipped'));
  await query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS anonymous_mode TINYINT(1) DEFAULT 0`);
  await query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS info_message_id VARCHAR(20)`);

  await query(`
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      author_id VARCHAR(20) NOT NULL,
      author_tag VARCHAR(100) NOT NULL,
      content TEXT,
      attachments JSON,
      is_staff TINYINT(1) DEFAULT 0,
      source_message_id VARCHAR(20),
      channel_message_id VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id)
    )
  `);

  // Migrations for existing tables
  await query(`ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS source_message_id VARCHAR(20)`);
  await query(`ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS channel_message_id VARCHAR(20)`);

  await query(`
    CREATE TABLE IF NOT EXISTS ticket_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      event_type ENUM('created', 'escalated', 'closed', 'reopened') NOT NULL,
      actor_id VARCHAR(20) NOT NULL,
      detail VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id)
    )
  `);

  await query(`ALTER TABLE ticket_events MODIFY COLUMN event_type ENUM('created', 'escalated', 'closed', 'reopened') NOT NULL`).catch(e => log.warn({ err: e.message }, 'ticket_events.event_type MODIFY skipped'));

  await query(`
    CREATE TABLE IF NOT EXISTS ticket_timeouts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(20) NOT NULL,
      timed_out_by VARCHAR(20) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_timeout_user (user_id),
      INDEX idx_timeout_expires (expires_at)
    )
  `);

  // ── Legacy ticket tables (read-only, data exists on production from old bot) ──

  await query(`
    CREATE TABLE IF NOT EXISTS legacy_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uuid CHAR(36) NOT NULL UNIQUE,
      thread_number INT NULL,
      user_id VARCHAR(20) NOT NULL,
      username VARCHAR(100) NOT NULL,
      nickname VARCHAR(255) NULL,
      previous_threads INT NULL,
      started_at TIMESTAMP NOT NULL,
      closed_at TIMESTAMP NULL,
      INDEX idx_legacy_user (user_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS legacy_ticket_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      type ENUM('bot','from_user','to_user','bot_to_user','chat','command') NOT NULL,
      author VARCHAR(100) NULL,
      content TEXT NULL,
      created_at TIMESTAMP NOT NULL,
      FOREIGN KEY (ticket_id) REFERENCES legacy_tickets(id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS prospects (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uuid CHAR(36) NOT NULL UNIQUE,
      channel_id VARCHAR(20) NOT NULL,
      forum_thread_id VARCHAR(20),
      user_id VARCHAR(20) NOT NULL,
      status ENUM('open', 'closed', 'accepted', 'denied') DEFAULT 'open',
      alias VARCHAR(32) NOT NULL,
      nationality VARCHAR(100) NOT NULL,
      date_of_birth VARCHAR(10) NOT NULL,
      squad_hours INT NOT NULL,
      preferred_roles VARCHAR(200) NOT NULL,
      prev_clan VARCHAR(200) NOT NULL,
      why_rb TEXT NOT NULL,
      active_hours VARCHAR(200) NOT NULL,
      competitive VARCHAR(200) NOT NULL,
      steam_id VARCHAR(100) NOT NULL,
      mentor_id VARCHAR(20),
      vote_posted_at TIMESTAMP NULL,
      vote_message_id VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP NULL,
      closed_by VARCHAR(20)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS prospect_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      prospect_id INT NOT NULL,
      author_id VARCHAR(20) NOT NULL,
      author_tag VARCHAR(100) NOT NULL,
      content TEXT,
      attachments JSON,
      is_staff TINYINT(1) DEFAULT 0,
      source_message_id VARCHAR(20),
      channel_message_id VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (prospect_id) REFERENCES prospects(id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS prospect_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      prospect_id INT NOT NULL,
      event_type ENUM('created', 'vote_started', 'accepted', 'denied', 'closed', 'paused', 'unpaused', 'extended') NOT NULL,
      actor_id VARCHAR(20) NOT NULL,
      detail VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (prospect_id) REFERENCES prospects(id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS prospect_votes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      prospect_id INT NOT NULL,
      voter_id VARCHAR(20) NOT NULL,
      voter_tag VARCHAR(100),
      vote ENUM('yes', 'no', 'unsure') NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_vote (prospect_id, voter_id),
      FOREIGN KEY (prospect_id) REFERENCES prospects(id)
    )
  `);

  // Prospect table migrations
  await query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS extra_days INT DEFAULT 0`);
  await query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS paused_at TIMESTAMP NULL`);
  await query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS period_started_at TIMESTAMP NULL`);
  await query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS ai_evaluation TEXT NULL`);
  await query(`ALTER TABLE prospect_events MODIFY COLUMN event_type ENUM('created', 'vote_started', 'accepted', 'denied', 'closed', 'paused', 'unpaused', 'extended', 'unclaimed') NOT NULL`).catch(e => log.warn({ err: e.message }, 'prospect_events.event_type MODIFY skipped'));
  await query(`ALTER TABLE prospect_votes ADD COLUMN IF NOT EXISTS reason TEXT NULL`);

  // ── Seeding tables ──

  await query(`
    CREATE TABLE IF NOT EXISTS seeding_config (
      id INT PRIMARY KEY DEFAULT 1,
      enabled TINYINT(1) DEFAULT 0,
      channel_id VARCHAR(20),
      role_id VARCHAR(20),
      seed_threshold INT DEFAULT 40,
      reset_threshold INT DEFAULT 20,
      daily_time VARCHAR(5) DEFAULT '16:00',
      timezone VARCHAR(50) DEFAULT 'UTC',
      server_name VARCHAR(100),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CHECK (id = 1)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS seeding_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP NULL,
      duration_minutes INT NULL,
      start_players INT DEFAULT 0,
      peak_players INT DEFAULT 0,
      end_players INT DEFAULT 0,
      map_name VARCHAR(100),
      layer_name VARCHAR(200),
      status ENUM('active', 'completed', 'reset', 'expired') DEFAULT 'active',
      call_message_id VARCHAR(20),
      completion_message_id VARCHAR(20)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS seeding_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message_id VARCHAR(20) NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      message_type ENUM('call', 'completion', 'update') NOT NULL,
      session_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES seeding_sessions(id) ON DELETE SET NULL
    )
  `);

  // Seeding migrations
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS daily_time VARCHAR(5) DEFAULT '16:00'`);
  // Migrate daily_hour to daily_time then drop the legacy column
  try {
    await query(`UPDATE seeding_config SET daily_time = CONCAT(LPAD(daily_hour, 2, '0'), ':00') WHERE daily_hour IS NOT NULL AND (daily_time IS NULL OR daily_time = '16:00')`);
    await query(`ALTER TABLE seeding_config DROP COLUMN IF EXISTS daily_hour`);
  } catch { /* daily_hour column may not exist on fresh installs */ }
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS last_daily_call_date DATE NULL`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS panel_message_id VARCHAR(20) NULL`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS last_reset_date DATE NULL`);

  // ── Admin / console tables ──

  await query(`
    CREATE TABLE IF NOT EXISTS bot_messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      message_id VARCHAR(20) NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      channel_name VARCHAR(100),
      guild_id VARCHAR(20),
      author_id VARCHAR(20) NOT NULL,
      author_tag VARCHAR(100) NOT NULL,
      content TEXT,
      attachments JSON,
      is_dm TINYINT(1) DEFAULT 0,
      direction ENUM('incoming', 'outgoing') DEFAULT 'incoming',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_author (author_id),
      INDEX idx_channel (channel_id),
      INDEX idx_created (created_at)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bot_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      level SMALLINT NOT NULL,
      level_label VARCHAR(10) NOT NULL,
      module VARCHAR(50),
      message TEXT NOT NULL,
      data JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_level (level),
      INDEX idx_module (module),
      INDEX idx_created (created_at)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bot_status (
      id INT PRIMARY KEY DEFAULT 1,
      status ENUM('online', 'offline', 'starting') DEFAULT 'offline',
      uptime_seconds INT DEFAULT 0,
      guild_count INT DEFAULT 0,
      member_count INT DEFAULT 0,
      latency_ms INT DEFAULT 0,
      db_connected TINYINT(1) DEFAULT 0,
      squadjs_connected TINYINT(1) DEFAULT 0,
      seeding_scheduler_active TINYINT(1) DEFAULT 0,
      prospect_scheduler_active TINYINT(1) DEFAULT 0,
      last_heartbeat TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      started_at TIMESTAMP NULL,
      CHECK (id = 1)
    )
  `);

  // ── Action queue (web → bot) ──

  await query(`
    CREATE TABLE IF NOT EXISTS pending_actions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      action_type VARCHAR(50) NOT NULL,
      target_type VARCHAR(20) NOT NULL,
      target_id INT NOT NULL,
      payload JSON,
      actor_id VARCHAR(20) NOT NULL,
      status ENUM('pending','processing','completed','failed') DEFAULT 'pending',
      error_detail VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP NULL,
      INDEX idx_pending (status, created_at)
    )
  `);

  // Prospect event migration — add mentor_reassigned
  // MODIFY COLUMN has no IF NOT EXISTS in MariaDB — .catch() keeps re-runs safe
  await query(`ALTER TABLE prospect_events MODIFY COLUMN event_type ENUM('created','vote_started','accepted','denied','closed','paused','unpaused','extended','unclaimed','mentor_reassigned') NOT NULL`).catch(e => log.warn({ err: e.message }, 'prospect_events.event_type MODIFY skipped'));

  // Widen actor_id to accommodate Prisma CUIDs (25 chars) from web app
  await query(`ALTER TABLE pending_actions MODIFY COLUMN actor_id VARCHAR(30) NOT NULL`).catch(e => log.warn({ err: e.message }, 'pending_actions.actor_id MODIFY skipped'));
  await query(`ALTER TABLE ticket_events MODIFY COLUMN actor_id VARCHAR(30) NOT NULL`).catch(e => log.warn({ err: e.message }, 'ticket_events.actor_id MODIFY skipped'));
  await query(`ALTER TABLE prospect_events MODIFY COLUMN actor_id VARCHAR(30) NOT NULL`).catch(e => log.warn({ err: e.message }, 'prospect_events.actor_id MODIFY skipped'));

  // ── BattleMetrics player ID cache (permanent mapping) ──

  await query(`
    CREATE TABLE IF NOT EXISTS bm_players (
      steam_id VARCHAR(20) NOT NULL PRIMARY KEY,
      bm_player_id VARCHAR(20) NOT NULL,
      bm_player_name VARCHAR(100),
      cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Performance indexes ──

  await query(`CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets (user_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tickets_channel_status ON tickets (channel_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_prospects_user_status ON prospects (user_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_prospects_channel_status ON prospects (channel_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ticket_messages_source ON ticket_messages (source_message_id)`);

  // ── Activity tracking tables ──

  await query(`
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(20) NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      channel_name VARCHAR(100),
      joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      left_at TIMESTAMP NULL,
      duration_seconds INT NULL,
      muted_seconds INT DEFAULT 0,
      deafened_seconds INT DEFAULT 0,
      streaming_seconds INT DEFAULT 0,
      video_seconds INT DEFAULT 0,
      INDEX idx_vs_user_joined (user_id, joined_at),
      INDEX idx_vs_joined (joined_at)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS message_activity_daily (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(20) NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      channel_name VARCHAR(100),
      message_date DATE NOT NULL,
      message_count INT DEFAULT 0,
      UNIQUE KEY uq_mad_user_channel_date (user_id, channel_id, message_date),
      INDEX idx_mad_user_date (user_id, message_date)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_reactions_daily (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(20) NOT NULL,
      reaction_date DATE NOT NULL,
      reaction_count INT DEFAULT 0,
      UNIQUE KEY uq_urd_user_date (user_id, reaction_date),
      INDEX idx_urd_user_date (user_id, reaction_date)
    )
  `);

  // ── RoyalVoice tables ──

  await query(`
    CREATE TABLE IF NOT EXISTS temp_voice_config (
      id INT PRIMARY KEY DEFAULT 1,
      trigger_channel_id VARCHAR(20),
      category_id VARCHAR(20),
      log_channel_id VARCHAR(20),
      max_channels_per_user INT DEFAULT 3,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CHECK (id = 1)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS temp_channels (
      id INT AUTO_INCREMENT PRIMARY KEY,
      channel_id VARCHAR(20) NOT NULL UNIQUE,
      owner_id VARCHAR(20) NOT NULL,
      guild_id VARCHAR(20) NOT NULL,
      panel_message_id VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tc_owner (owner_id),
      INDEX idx_tc_guild (guild_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS temp_voice_presets (
      user_id VARCHAR(20) NOT NULL,
      guild_id VARCHAR(20) NOT NULL,
      channel_name VARCHAR(100) NULL,
      bitrate INT NULL,
      region VARCHAR(20) NULL,
      user_limit INT NULL,
      is_locked TINYINT(1) DEFAULT 0,
      is_invisible TINYINT(1) DEFAULT 0,
      is_chat_closed TINYINT(1) DEFAULT 0,
      is_dnd TINYINT(1) DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, guild_id)
    )
  `);

  // ── AI ticket suggestions (30-day retention, keyed by bot's response message id) ──

  await query(`
    CREATE TABLE IF NOT EXISTS ai_suggestions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message_id VARCHAR(20) NOT NULL UNIQUE,
      channel_id VARCHAR(20) NOT NULL,
      ticket_id INT NULL,
      suggestion JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ai_sugg_created (created_at)
    )
  `);

  log.info('Database schema initialized');
}
