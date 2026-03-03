import { createEmbed } from '../../utils/embed.js';

export function buildVerifySuccessEmbed(user) {
  return createEmbed('Verification')
    .setColor(0x57f287)
    .setTitle('Verification Successful')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${user.tag} (<@${user.id}>)`, inline: true },
      { name: 'User ID', value: user.id, inline: true },
    );
}

export function buildVerifyFailEmbed(user, question, userAnswer, correctAnswer) {
  return createEmbed('Verification')
    .setColor(0xed4245)
    .setTitle('Verification Failed')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${user.tag} (<@${user.id}>)`, inline: true },
      { name: 'User ID', value: user.id, inline: true },
      { name: 'Question', value: question, inline: false },
      { name: 'Their Answer', value: String(userAnswer), inline: true },
      { name: 'Correct Answer', value: String(correctAnswer), inline: true },
    );
}

export function buildVerifyCooldownEmbed(user, remainingSeconds) {
  return createEmbed('Verification')
    .setColor(0xfee75c)
    .setTitle('Verification Cooldown')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${user.tag} (<@${user.id}>)`, inline: true },
      { name: 'User ID', value: user.id, inline: true },
      { name: 'Cooldown Remaining', value: `${remainingSeconds}s`, inline: true },
    );
}
