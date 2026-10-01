import { EmbedBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import type { GuildConfig, Outcome } from '../db/repo.js';
import { methodName } from '../prayer/aladhan.js';
import { PRAYER_NAMES, type PrayerWindow } from '../prayer/types.js';
import { eventKey } from '../prayer/windows.js';
import { isPaused } from '../prayer/options.js';

export const EMBED_COLOR = 0x1f8b4c;

export function hhmm(dt: DateTime): string {
  return dt.toFormat('HH:mm');
}

/** Discord renders this in each viewer's own timezone. */
export function discordTs(dt: DateTime, style: 't' | 'T' | 'f' | 'F' | 'R' | 'd' = 'f'): string {
  return `<t:${Math.floor(dt.toSeconds())}:${style}>`;
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  pending: 'playing',
  played: 'played',
  skipped_empty: 'skipped, channel empty',
  skipped_paused: 'skipped, paused',
  skipped_no_channel: 'skipped, no channel set',
  error: 'failed',
};

function status(enabled: boolean, outcome: Outcome | undefined): string {
  if (!enabled) return 'off';
  return outcome ? `on, ${OUTCOME_LABEL[outcome]}` : 'on';
}

export function pauseText(cfg: GuildConfig, now: DateTime): string | null {
  if (!isPaused(cfg, now)) return null;
  if (cfg.pausedUntil === 'forever') return 'Announcements are **paused** until someone runs `/resume`.';
  return `Announcements are **paused** until ${discordTs(DateTime.fromISO(cfg.pausedUntil!), 'f')}.`;
}

export function locationText(cfg: GuildConfig): string {
  return `${cfg.locationLabel ?? 'Unknown location'} (${cfg.timezone ?? 'no timezone'})`;
}

export function scheduleEmbed(
  cfg: GuildConfig,
  date: DateTime,
  windows: PrayerWindow[],
  outcomes: Map<string, Outcome>,
  hijri: string | undefined,
  now: DateTime,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`Prayer times for ${date.toFormat('cccc d LLLL yyyy')}`)
    .setFooter({
      text: `${locationText(cfg)} | ${methodName(cfg.method)}${cfg.school === 1 ? ', Hanafi Asr' : ''} | warning ${cfg.warnMinutes} min before end`,
    });

  const desc: string[] = [];
  if (hijri) desc.push(`*${hijri}*`);
  const paused = pauseText(cfg, now);
  if (paused) desc.push(paused);
  if (desc.length) embed.setDescription(desc.join('\n'));

  for (const w of windows) {
    const start = outcomes.get(eventKey(w.date, w.prayer, 'start'));
    const ending = outcomes.get(eventKey(w.date, w.prayer, 'ending'));
    const closeText = w.close ? hhmm(w.close) : 'unknown';
    const lines = [
      `**${hhmm(w.start)}** to ${closeText}`,
      `Start announcement: ${status(w.startOn, start)}`,
      w.endingAt
        ? `Ending soon at ${hhmm(w.endingAt)}: ${status(w.endingOn, ending)}`
        : 'Ending soon: none (window too short)',
    ];
    embed.addFields({ name: PRAYER_NAMES[w.prayer], value: lines.join('\n') });
  }
  return embed;
}
