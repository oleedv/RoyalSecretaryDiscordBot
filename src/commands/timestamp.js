import { SlashCommandBuilder } from 'discord.js';
import { unixFromLocal, isValidZone } from '../services/timestamp/timeParse.js';
import { buildPreviewText, buildComponents } from '../services/timestamp/timestampView.js';
import { suggestZones } from '../services/timestamp/zones.js';
import { getUserTimezone, setUserTimezone } from '../services/timestamp/timestampService.js';
import { errorEmbed } from '../utils/embed.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:timestamp' });

const ERROR_MESSAGES = {
  invalid_date: 'I couldn\'t read that date. Use `YYYY-MM-DD`, e.g. `2026-07-01`.',
  invalid_time: 'I couldn\'t read that time. Use 24-hour `18:00` or 12-hour `6:00 PM`.',
  invalid_zone: 'That timezone isn\'t valid. Start typing a city in the `timezone` option and pick from the list.',
};

export default {
  data: new SlashCommandBuilder()
    .setName('timestamp')
    .setDescription('Make a Discord timestamp that shows in everyone\'s local time')
    .addStringOption((o) =>
      o.setName('date').setDescription('Date as YYYY-MM-DD, e.g. 2026-07-01').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('time').setDescription('Time, e.g. 18:00 or 6:00 PM').setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('timezone')
        .setDescription('Your timezone (remembered after first use)')
        .setAutocomplete(true)
        .setRequired(false)
    ),

  async execute(interaction) {
    const date = interaction.options.getString('date');
    const time = interaction.options.getString('time');
    const tzOption = interaction.options.getString('timezone');

    // Resolve the timezone: explicit option (saved for next time) or saved default.
    let zone = tzOption;
    if (tzOption) {
      if (!isValidZone(tzOption)) {
        return interaction.reply({ embeds: [errorEmbed(ERROR_MESSAGES.invalid_zone)], flags: ['Ephemeral'] });
      }
      await setUserTimezone(interaction.user.id, tzOption);
    } else {
      zone = await getUserTimezone(interaction.user.id);
      if (!zone) {
        return interaction.reply({
          embeds: [errorEmbed(
            'You haven\'t set a timezone yet. Run `/timestamp` again with the `timezone` option (start typing a city) and I\'ll remember it for next time.'
          )],
          flags: ['Ephemeral'],
        });
      }
    }

    const result = unixFromLocal(date, time, zone);
    if (result.error) {
      return interaction.reply({
        embeds: [errorEmbed(ERROR_MESSAGES[result.error] ?? 'Could not build that timestamp.')],
        flags: ['Ephemeral'],
      });
    }

    const content =
      `Times shown below in **${zone}**. Pick a style and **Post to this channel**, or copy a code:\n\n` +
      buildPreviewText(result.unix);

    await interaction.reply({
      content,
      components: buildComponents(result.unix),
      flags: ['Ephemeral'],
    });
    log.info({ userId: interaction.user.id, zone, unix: result.unix }, 'timestamp generated');
  },

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    let saved = null;
    try {
      saved = await getUserTimezone(interaction.user.id);
    } catch (err) {
      log.warn({ err }, 'autocomplete failed to read saved timezone');
    }
    await interaction.respond(suggestZones(focused, saved));
  },
};
