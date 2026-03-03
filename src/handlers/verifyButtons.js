import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import {
  buildVerifySuccessEmbed,
  buildVerifyFailEmbed,
  buildVerifyCooldownEmbed,
} from '../services/verify/verifyEmbeds.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'verifyButtons' });

// --- Cooldown ---
const cooldowns = new Map();
const COOLDOWN_MS = 30_000;

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of cooldowns) {
    if (now - ts > COOLDOWN_MS) cooldowns.delete(id);
  }
}, 5 * 60 * 1000).unref();

// --- Math challenge generator ---
function generateChallenge() {
  const ops = ['+', '-', '*'];
  const op = ops[Math.floor(Math.random() * ops.length)];

  let a, b, answer;
  if (op === '*') {
    a = Math.floor(Math.random() * 11) + 2; // 2-12
    b = Math.floor(Math.random() * 11) + 2; // 2-12
    answer = a * b;
  } else {
    a = Math.floor(Math.random() * 50) + 1; // 1-50
    b = Math.floor(Math.random() * 50) + 1; // 1-50
    answer = op === '+' ? a + b : a - b;
  }

  const wrongSet = new Set();
  while (wrongSet.size < 3) {
    const offset = Math.floor(Math.random() * 10) + 1;
    const wrong = Math.random() < 0.5 ? answer + offset : answer - offset;
    if (wrong !== answer) wrongSet.add(wrong);
  }

  const choices = [answer, ...wrongSet];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }

  const correctIndex = choices.indexOf(answer);
  const symbol = op === '*' ? 'x' : op;
  return { question: `What is ${a} ${symbol} ${b}?`, choices, correctIndex, answer };
}

// --- Log helper ---
async function sendLog(interaction, embed) {
  const logChannelId = config.verification?.logChannelId;
  if (!logChannelId) return;

  const channel = await interaction.client.channels.fetch(logChannelId).catch(() => null);
  if (!channel) return;

  await channel.send({ embeds: [embed] }).catch((err) =>
    log.error({ err }, 'Failed to send verification log')
  );
}

// --- Handlers ---

export async function handleStart(interaction) {
  const roleId = config.verification?.roleId;
  if (!roleId) {
    return interaction.reply({
      embeds: [errorEmbed('Verification is not configured.')],
      flags: ['Ephemeral'],
    });
  }

  if (interaction.member.roles.cache.has(roleId)) {
    return interaction.reply({
      embeds: [successEmbed('You are already verified.')],
      flags: ['Ephemeral'],
    });
  }

  const lastWrong = cooldowns.get(interaction.user.id);
  if (lastWrong) {
    const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - lastWrong)) / 1000);
    if (remaining > 0) {
      await sendLog(interaction, buildVerifyCooldownEmbed(interaction.user, remaining));
      return interaction.reply({
        embeds: [errorEmbed(`Please wait ${remaining} seconds before trying again.`)],
        flags: ['Ephemeral'],
      });
    }
    cooldowns.delete(interaction.user.id);
  }

  const { question, choices, correctIndex } = generateChallenge();

  const row = new ActionRowBuilder().addComponents(
    choices.map((choice, i) =>
      new ButtonBuilder()
        .setCustomId(`verify_answer_${i}_${correctIndex}`)
        .setLabel(String(choice))
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return interaction.reply({
    content: `**${question}**`,
    components: [row],
    flags: ['Ephemeral'],
  });
}

export async function handleAnswer(interaction) {
  const roleId = config.verification?.roleId;
  if (!roleId) {
    return interaction.reply({
      embeds: [errorEmbed('Verification is not configured.')],
      flags: ['Ephemeral'],
    });
  }

  if (interaction.member.roles.cache.has(roleId)) {
    return interaction.update({
      embeds: [successEmbed('You are already verified.')],
      components: [],
      content: '',
    });
  }

  const parts = interaction.customId.split('_');
  const clicked = parseInt(parts[2], 10);
  const correct = parseInt(parts[3], 10);

  // Extract the question and answers from the message
  const question = interaction.message.content?.replace(/\*/g, '') || 'Unknown';
  const buttons = interaction.message.components[0]?.components || [];
  const userAnswer = buttons[clicked]?.label || '?';
  const correctAnswer = buttons[correct]?.label || '?';

  if (clicked === correct) {
    await interaction.member.roles.add(roleId);
    log.info({ userId: interaction.user.id }, 'User verified');
    await sendLog(interaction, buildVerifySuccessEmbed(interaction.user));
    return interaction.update({
      embeds: [successEmbed('You have been verified. Welcome!')],
      components: [],
      content: '',
    });
  }

  cooldowns.set(interaction.user.id, Date.now());
  log.info({ userId: interaction.user.id }, 'Verification failed - wrong answer');
  await sendLog(interaction, buildVerifyFailEmbed(interaction.user, question, userAnswer, correctAnswer));
  return interaction.update({
    embeds: [errorEmbed('Incorrect answer. Please wait 30 seconds and try again.')],
    components: [],
    content: '',
  });
}
