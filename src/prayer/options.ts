import { DateTime } from 'luxon';
import type { GuildConfig, LocatedConfig, Repo } from '../db/repo.js';
import type { ScheduleOptions } from './types.js';

export function scheduleOptions(cfg: LocatedConfig, repo: Repo): ScheduleOptions {
  return {
    timezone: cfg.timezone,
    warnMinutes: cfg.warnMinutes,
    ishaEnd: cfg.ishaEnd,
    prayers: repo.getPrayerSettings(cfg.guildId),
  };
}

export function isPaused(cfg: GuildConfig, now: DateTime): boolean {
  if (!cfg.pausedUntil) return false;
  if (cfg.pausedUntil === 'forever') return true;
  const until = DateTime.fromISO(cfg.pausedUntil);
  return until.isValid && until > now;
}
