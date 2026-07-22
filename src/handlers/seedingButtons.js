import { getSeedingConfig } from '../services/seeding/seedingService.js';
import { buildSeederRoleComponents } from '../services/seeding/seedingEmbeds.js';
import logger from '../logger.js';

const log = logger.child({ module: 'seedingButtons' });

function roleIdsFromConfig(cfg) {
  if (Array.isArray(cfg?.role_ids) && cfg.role_ids.length > 0) {
    return cfg.role_ids.map(String).filter(Boolean);
  }
  if (cfg?.role_id) return [String(cfg.role_id)];
  return [];
}

async function updateButtonCount(interaction, primaryRoleId) {
  try {
    const role = await interaction.guild.roles.fetch(primaryRoleId);
    const count = role?.members?.size ?? null;
    const components = buildSeederRoleComponents(count);
    await interaction.message.edit({ components });
  } catch (err) {
    log.warn({ err }, 'Failed to update seeder button count');
  }
}

export async function handleJoin(interaction) {
  const cfg = await getSeedingConfig();
  const roleIds = roleIdsFromConfig(cfg);
  if (roleIds.length === 0) {
    return interaction.reply({ content: 'Seeder role is not configured.', flags: ['Ephemeral'] });
  }

  const member = interaction.member;
  const missing = roleIds.filter((id) => !member.roles.cache.has(id));
  if (missing.length === 0) {
    return interaction.reply({ content: 'You already have the seeder role.', flags: ['Ephemeral'] });
  }

  await member.roles.add(missing);
  await interaction.reply({
    content: 'You have joined the seeders! You will be pinged when seeding is needed.',
    flags: ['Ephemeral'],
  });
  await updateButtonCount(interaction, roleIds[0]);
  log.info({ userId: interaction.user.id, roleIds: missing }, 'User joined seeders');
}

export async function handleLeave(interaction) {
  const cfg = await getSeedingConfig();
  const roleIds = roleIdsFromConfig(cfg);
  if (roleIds.length === 0) {
    return interaction.reply({ content: 'Seeder role is not configured.', flags: ['Ephemeral'] });
  }

  const member = interaction.member;
  const present = roleIds.filter((id) => member.roles.cache.has(id));
  if (present.length === 0) {
    return interaction.reply({ content: 'You do not have the seeder role.', flags: ['Ephemeral'] });
  }

  await member.roles.remove(present);
  await interaction.reply({
    content: 'You have left the seeders.',
    flags: ['Ephemeral'],
  });
  await updateButtonCount(interaction, roleIds[0]);
  log.info({ userId: interaction.user.id, roleIds: present }, 'User left seeders');
}
