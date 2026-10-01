import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { isLocated } from '../db/repo.js';
import { scheduleEmbed } from '../util/format.js';
import { NEEDS_LOCATION, type Command } from './context.js';
import { windowsFor } from './shared.js';

export const schedule: Command = {
  data: new SlashCommandBuilder()
    .setName('schedule')
    .setDescription("Show the prayer times and what the bot will announce")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName('day')
        .setDescription('Which day to show (default today)')
        .addChoices({ name: 'Today', value: 'today' }, { name: 'Tomorrow', value: 'tomorrow' }),
    ),

  async execute(interaction, ctx) {
    const cfg = ctx.repo.ensureGuild(interaction.guildId);
    if (!isLocated(cfg)) {
      await interaction.reply({ content: NEEDS_LOCATION, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();
    const now = ctx.now();
    const day = now.setZone(cfg.timezone).plus({ days: interaction.options.getString('day') === 'tomorrow' ? 1 : 0 });
    const date = day.toISODate()!;
    const { windows, hijri } = await windowsFor(ctx, cfg, date);
    if (windows.length === 0) {
      await interaction.editReply('Prayer times for that day are not available yet. The bot will keep retrying.');
      return;
    }
    const embed = scheduleEmbed(cfg, day, windows, ctx.repo.outcomesForDate(cfg.guildId, date), hijri, now);
    await interaction.editReply({ embeds: [embed] });
  },
};
