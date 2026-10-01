import { MessageFlags, type Interaction } from 'discord.js';
import { AladhanError } from '../prayer/aladhan.js';
import type { Command, CommandContext } from './context.js';
import { config } from './config.js';
import { next } from './next.js';
import { pause, resume } from './pause.js';
import { prayer } from './prayer.js';
import { schedule } from './schedule.js';
import { test } from './test.js';

export const commands: Command[] = [schedule, next, pause, resume, prayer, config, test];

const byName = new Map(commands.map((c) => [c.data.name, c]));

export async function handleInteraction(interaction: Interaction, ctx: CommandContext): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inCachedGuild()) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral });
    }
    return;
  }
  const command = byName.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, ctx);
  } catch (err) {
    ctx.log.error({ err, command: interaction.commandName, guildId: interaction.guildId }, 'command failed');
    const content =
      err instanceof AladhanError
        ? 'Could not reach the prayer times service (Aladhan) right now. Please try again in a few minutes.'
        : 'Something went wrong running that command.';
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(content);
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch {
      // The interaction may have expired; nothing more to do.
    }
  }
}
