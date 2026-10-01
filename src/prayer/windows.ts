import { DateTime } from 'luxon';
import {
  PRAYERS,
  type DayTimings,
  type Prayer,
  type PrayerEvent,
  type PrayerWindow,
  type ScheduleOptions,
} from './types.js';

/** An ending-soon warning is dropped if it would land within this many minutes of the start. */
export const MIN_GAP_AFTER_START_MINUTES = 5;

export type DayLookup = (date: string) => DayTimings | undefined;

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date).plus({ days }).toISODate()!;
}

function parse(iso: string, zone: string, offsetMinutes = 0): DateTime {
  const dt = DateTime.fromISO(iso, { setZone: true }).setZone(zone);
  if (!dt.isValid) throw new Error(`Invalid timestamp from Aladhan: ${iso}`);
  return offsetMinutes ? dt.plus({ minutes: offsetMinutes }) : dt;
}

/**
 * Builds the five prayer windows for one date. Each prayer's start includes its
 * configured offset, and because a window closes when the next prayer starts,
 * the offset of the next prayer moves the close time too.
 */
export function buildDayWindows(date: string, lookup: DayLookup, opts: ScheduleOptions): PrayerWindow[] {
  const day = lookup(date);
  if (!day) return [];
  const tz = opts.timezone;
  const off = (p: Prayer) => opts.prayers[p].offsetMinutes;

  const start: Record<Prayer, DateTime> = {
    fajr: parse(day.fajr, tz, off('fajr')),
    dhuhr: parse(day.dhuhr, tz, off('dhuhr')),
    asr: parse(day.asr, tz, off('asr')),
    maghrib: parse(day.maghrib, tz, off('maghrib')),
    isha: parse(day.isha, tz, off('isha')),
  };

  let ishaClose: DateTime | null;
  if (opts.ishaEnd === 'midnight') {
    ishaClose = parse(day.midnight, tz);
    // Midnight usually falls after 00:00. If the timestamp carries the same
    // calendar date (so it sorts before Isha), it belongs to the next day.
    if (ishaClose <= start.isha) ishaClose = ishaClose.plus({ days: 1 });
  } else {
    const next = lookup(addDays(date, 1));
    ishaClose = next ? parse(next.fajr, tz, off('fajr')) : null;
  }

  const close: Record<Prayer, DateTime | null> = {
    fajr: parse(day.sunrise, tz),
    dhuhr: start.asr,
    asr: start.maghrib,
    maghrib: start.isha,
    isha: ishaClose,
  };

  return PRAYERS.map((prayer) => {
    const s = start[prayer];
    const c = close[prayer];
    let endingAt: DateTime | null = null;
    if (c) {
      const candidate = c.minus({ minutes: opts.warnMinutes });
      if (candidate.diff(s, 'minutes').minutes >= MIN_GAP_AFTER_START_MINUTES) endingAt = candidate;
    }
    return {
      date,
      prayer,
      start: s,
      close: c,
      endingAt,
      startOn: opts.prayers[prayer].startOn,
      endingOn: opts.prayers[prayer].endingOn,
    };
  });
}

export function eventKey(date: string, prayer: Prayer, kind: 'start' | 'ending'): string {
  return `${date}:${prayer}:${kind}`;
}

/** All enabled events for the given dates, sorted by time. */
export function buildEvents(dates: string[], lookup: DayLookup, opts: ScheduleOptions): PrayerEvent[] {
  const events: PrayerEvent[] = [];
  for (const date of dates) {
    for (const w of buildDayWindows(date, lookup, opts)) {
      if (w.startOn) {
        events.push({ key: eventKey(date, w.prayer, 'start'), date, prayer: w.prayer, kind: 'start', at: w.start });
      }
      if (w.endingOn && w.endingAt) {
        events.push({ key: eventKey(date, w.prayer, 'ending'), date, prayer: w.prayer, kind: 'ending', at: w.endingAt });
      }
    }
  }
  return events.sort((a, b) => a.at.toMillis() - b.at.toMillis());
}

/**
 * Dates whose events can fall near `now`. Yesterday is included because Isha's
 * window (and so its ending warning) can run past midnight.
 */
export function relevantDates(now: DateTime, timezone: string): string[] {
  const today = now.setZone(timezone).toISODate()!;
  return [addDays(today, -1), today, addDays(today, 1)];
}
