import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import { discordTs } from '../util/format.js';
import type { Command } from './context.js';

export const pause: Command = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause all announcements')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName('duration')
        .setDescription('How long to pause (default: until /resume)')
        .addChoices(
          { name: '1 hour', value: '1h' },
          { name: '3 hours', value: '3h' },
          { name: '12 hours', value: '12h' },
          { name: 'Until tomorrow', value: 'tomorrow' },
          { name: 'Until /resume', value: 'forever' },
        ),
    ),

  async execute(interaction, ctx) {
    const cfg = ctx.repo.ensureGuild(interaction.guildId);
    const choice = interaction.options.getString('duration') ?? 'forever';
    const now = ctx.now();
    let until: DateTime | null = null;
    if (choice === '1h') until = now.plus({ hours: 1 });
    else if (choice === '3h') until = now.plus({ hours: 3 });
    else if (choice === '12h') until = now.plus({ hours: 12 });
    else if (choice === 'tomorrow') until = now.setZone(cfg.timezone ?? 'UTC').plus({ days: 1 }).startOf('day');

    ctx.repo.updateGuild(interaction.guildId, { pausedUntil: until ? until.toUTC().toISO()! : 'forever' });
    await interaction.reply(
      until
        ? `Announcements paused until ${discordTs(until, 'f')}.`
        : 'Announcements paused until someone runs `/resume`.',
    );
  },
};

export const resume: Command = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume announcements')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, ctx) {
    ctx.repo.updateGuild(interaction.guildId, { pausedUntil: null });
    await interaction.reply('Announcements resumed.');
  },
};
