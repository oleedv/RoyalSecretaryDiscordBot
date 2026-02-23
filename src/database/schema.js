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
      status ENUM('open', 'closed') DEFAULT 'open',
      tier ENUM('normal', 'community_officer', 'admin_officer') DEFAULT 'normal',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP NULL,
      closed_by VARCHAR(20) NULL
    )
  `);

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
      event_type ENUM('created', 'escalated', 'closed') NOT NULL,
      actor_id VARCHAR(20) NOT NULL,
      detail VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id)
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
  await query(`ALTER TABLE prospect_events MODIFY COLUMN event_type ENUM('created', 'vote_started', 'accepted', 'denied', 'closed', 'paused', 'unpaused', 'extended', 'unclaimed') NOT NULL`);
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

  // ── Performance indexes ──

  await query(`CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets (user_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tickets_channel_status ON tickets (channel_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_prospects_user_status ON prospects (user_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_prospects_channel_status ON prospects (channel_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ticket_messages_source ON ticket_messages (source_message_id)`);

  log.info('Database schema initialized');
}
