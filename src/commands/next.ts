import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { isLocated } from '../db/repo.js';
import { PRAYER_NAMES } from '../prayer/types.js';
import { discordTs, hhmm, pauseText } from '../util/format.js';
import { NEEDS_LOCATION, type Command } from './context.js';
import { nextEvent } from './shared.js';

export const next: Command = {
  data: new SlashCommandBuilder()
    .setName('next')
    .setDescription('Show the next announcement')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, ctx) {
    const cfg = ctx.repo.ensureGuild(interaction.guildId);
    if (!isLocated(cfg)) {
      await interaction.reply({ content: NEEDS_LOCATION, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();
    const now = ctx.now();
    const event = await nextEvent(ctx, cfg, now);
    if (!event) {
      await interaction.editReply('No upcoming announcements. Check `/prayer list` to see if any are turned on.');
      return;
    }
    const what = event.kind === 'start' ? `${PRAYER_NAMES[event.prayer]} starts` : `${PRAYER_NAMES[event.prayer]} ending soon`;
    const local = event.at.setZone(cfg.timezone);
    const lines = [`Next: **${what}** at ${hhmm(local)} ${cfg.timezone} (${discordTs(event.at, 'R')})`];
    const paused = pauseText(cfg, now);
    if (paused) lines.push(paused);
    await interaction.editReply(lines.join('\n'));
  },
};
