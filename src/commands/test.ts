import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { PRAYER_NAMES, type EventKind, type Prayer } from '../prayer/types.js';
import type { Command } from './context.js';
import { prayerChoices } from './prayer.js';

export const test: Command = {
  data: new SlashCommandBuilder()
    .setName('test')
    .setDescription('Play an announcement now, using the normal channel rules')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('prayer').setDescription('Which prayer').setRequired(true).addChoices(...prayerChoices))
    .addStringOption((o) =>
      o
        .setName('kind')
        .setDescription('Which clip (default start)')
        .addChoices({ name: 'Start', value: 'start' }, { name: 'Ending soon', value: 'ending' }),
    ),

  async execute(interaction, ctx) {
    ctx.repo.ensureGuild(interaction.guildId);
    const p = interaction.options.getString('prayer', true) as Prayer;
    const kind = (interaction.options.getString('kind') ?? 'start') as EventKind;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const result = await ctx.queue.enqueue({ guildId: interaction.guildId, prayer: p, kind });
    const clip = `${PRAYER_NAMES[p]} ${kind === 'start' ? 'start' : 'ending soon'}`;
    const messages: Record<typeof result.outcome, string> = {
      played: `Played the ${clip} clip in <#${result.channelId}>.`,
      skipped_empty: `Did not play: ${result.detail}. The bot only joins channels that have people in them.`,
      skipped_no_channel: `Did not play: ${result.detail}. Set one with \`/config channel\`.`,
      error: `Failed to play: ${result.detail}.`,
    };
    await interaction.editReply(messages[result.outcome]);
  },
};
