import type { ChatInputCommandInteraction, SlashCommandOptionsOnlyBuilder, SlashCommandSubcommandsOnlyBuilder } from 'discord.js';
import type { DateTime } from 'luxon';
import type { Repo } from '../db/repo.js';
import type { AladhanClient } from '../prayer/aladhan.js';
import type { TimingsService } from '../prayer/timings.js';
import type { Logger } from '../util/logger.js';
import type { AnnouncementQueue } from '../voice/queue.js';

export interface CommandContext {
  repo: Repo;
  timings: TimingsService;
  aladhan: Pick<AladhanClient, 'resolveCity' | 'resolveCoordinates'>;
  queue: Pick<AnnouncementQueue, 'enqueue'>;
  now: () => DateTime;
  log: Logger;
}

export interface Command {
  data: SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: CommandContext): Promise<void>;
}

/** Shown whenever a command needs a location that has not been set yet. */
export const NEEDS_LOCATION =
  'No location is set for this server yet. An admin can set one with `/config location city:<city> country:<country>`.';
