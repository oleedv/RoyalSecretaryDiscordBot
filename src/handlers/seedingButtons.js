import { getSeedingConfig } from '../services/seeding/seedingService.js';
import logger from '../logger.js';

const log = logger.child({ module: 'seedingButtons' });

export async function handleJoin(interaction) {
  const cfg = await getSeedingConfig();
  if (!cfg?.role_id) {
    return interaction.reply({ content: 'Seeder role is not configured.', flags: ['Ephemeral'] });
  }

  const member = interaction.member;
  if (member.roles.cache.has(cfg.role_id)) {
    return interaction.reply({ content: 'You already have the seeder role.', flags: ['Ephemeral'] });
  }

  await member.roles.add(cfg.role_id);
  await interaction.reply({
    content: 'You have joined the seeders! You will be pinged when seeding is needed.',
    flags: ['Ephemeral'],
  });
  log.info({ userId: interaction.user.id }, 'User joined seeders');
}

export async function handleLeave(interaction) {
  const cfg = await getSeedingConfig();
  if (!cfg?.role_id) {
    return interaction.reply({ content: 'Seeder role is not configured.', flags: ['Ephemeral'] });
  }

  const member = interaction.member;
  if (!member.roles.cache.has(cfg.role_id)) {
    return interaction.reply({ content: 'You do not have the seeder role.', flags: ['Ephemeral'] });
  }

  await member.roles.remove(cfg.role_id);
  await interaction.reply({
    content: 'You have left the seeders.',
    flags: ['Ephemeral'],
  });
  log.info({ userId: interaction.user.id }, 'User left seeders');
}
