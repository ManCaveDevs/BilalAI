import { EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { PRAYERS, PRAYER_NAMES, type Prayer } from '../prayer/types.js';
import { EMBED_COLOR } from '../util/format.js';
import type { Command } from './context.js';

export const prayerChoices = PRAYERS.map((p) => ({ name: PRAYER_NAMES[p], value: p }));

export const prayer: Command = {
  data: new SlashCommandBuilder()
    .setName('prayer')
    .setDescription('Turn announcements for individual prayers on or off')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('toggle')
        .setDescription('Turn a prayer announcement on or off')
        .addStringOption((o) =>
          o.setName('prayer').setDescription('Which prayer').setRequired(true).addChoices(...prayerChoices),
        )
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('which')
            .setDescription('Which announcement (default both)')
            .addChoices(
              { name: 'Both', value: 'both' },
              { name: 'Start only', value: 'start' },
              { name: 'Ending soon only', value: 'ending' },
            ),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show which announcements are on')),

  async execute(interaction, ctx) {
    const guildId = interaction.guildId;
    ctx.repo.ensureGuild(guildId);

    if (interaction.options.getSubcommand() === 'toggle') {
      const p = interaction.options.getString('prayer', true) as Prayer;
      const enabled = interaction.options.getBoolean('enabled', true);
      const which = interaction.options.getString('which') ?? 'both';
      ctx.repo.updatePrayerSettings(guildId, p, {
        startOn: which === 'ending' ? undefined : enabled,
        endingOn: which === 'start' ? undefined : enabled,
      });
      const label = which === 'both' ? 'announcements' : which === 'start' ? 'start announcement' : 'ending soon warning';
      await interaction.reply(`${PRAYER_NAMES[p]} ${label} turned **${enabled ? 'on' : 'off'}**.`);
      return;
    }

    const settings = ctx.repo.getPrayerSettings(guildId);
    const onOff = (b: boolean) => (b ? 'on' : 'off');
    const lines = PRAYERS.map((p) => {
      const s = settings[p];
      const offset = s.offsetMinutes ? `, adjusted ${s.offsetMinutes > 0 ? '+' : ''}${s.offsetMinutes} min` : '';
      return `**${PRAYER_NAMES[p]}**: start ${onOff(s.startOn)}, ending soon ${onOff(s.endingOn)}${offset}`;
    });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Announcements').setDescription(lines.join('\n'))] });
  },
};
