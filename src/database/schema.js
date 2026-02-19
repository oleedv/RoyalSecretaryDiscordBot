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

  // Prospect table migrations
  await query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS extra_days INT DEFAULT 0`);
  await query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS paused_at TIMESTAMP NULL`);
  await query(`ALTER TABLE prospect_events MODIFY COLUMN event_type ENUM('created', 'vote_started', 'accepted', 'denied', 'closed', 'paused', 'unpaused', 'extended') NOT NULL`);

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

  log.info('Database schema initialized');
}
