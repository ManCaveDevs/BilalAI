import type { DateTime } from 'luxon';
import type { LocatedConfig } from '../db/repo.js';
import { scheduleOptions } from '../prayer/options.js';
import { addDays, buildDayWindows, buildEvents } from '../prayer/windows.js';
import type { PrayerEvent, PrayerWindow } from '../prayer/types.js';
import type { CommandContext } from './context.js';

/** Fetches from Aladhan if `date` (or the day after, needed for Isha) is not cached yet. */
export async function ensureDates(ctx: CommandContext, cfg: LocatedConfig, dates: string[]): Promise<void> {
  const lookup = ctx.timings.lookup(cfg);
  if (dates.every((d) => lookup(d))) return;
  await ctx.timings.ensure(cfg, ctx.now(), true);
}

export async function windowsFor(
  ctx: CommandContext,
  cfg: LocatedConfig,
  date: string,
): Promise<{ windows: PrayerWindow[]; hijri: string | undefined }> {
  await ensureDates(ctx, cfg, [date, addDays(date, 1)]);
  const lookup = ctx.timings.lookup(cfg);
  return { windows: buildDayWindows(date, lookup, scheduleOptions(cfg, ctx.repo)), hijri: lookup(date)?.hijri };
}

export async function nextEvent(ctx: CommandContext, cfg: LocatedConfig, now: DateTime): Promise<PrayerEvent | undefined> {
  const today = now.setZone(cfg.timezone).toISODate()!;
  const dates = [addDays(today, -1), today, addDays(today, 1), addDays(today, 2)];
  await ensureDates(ctx, cfg, dates);
  return buildEvents(dates, ctx.timings.lookup(cfg), scheduleOptions(cfg, ctx.repo)).find((e) => e.at > now);
}
