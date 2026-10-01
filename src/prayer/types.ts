import type { DateTime } from 'luxon';

export const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
export type Prayer = (typeof PRAYERS)[number];

export const EVENT_KINDS = ['start', 'ending'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const PRAYER_NAMES: Record<Prayer, string> = {
  fajr: 'Fajr',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
};

/** One calendar day of times from Aladhan, all as ISO-8601 timestamps with offset. */
export interface DayTimings {
  /** YYYY-MM-DD in the location's timezone. */
  date: string;
  fajr: string;
  sunrise: string;
  dhuhr: string;
  asr: string;
  maghrib: string;
  isha: string;
  midnight: string;
  /** e.g. "19 Rabi al-thani 1448", for display only. */
  hijri?: string;
}

export interface PrayerSettings {
  startOn: boolean;
  endingOn: boolean;
  /** Minutes added to Aladhan's start time to match a local timetable. */
  offsetMinutes: number;
}

export type IshaEnd = 'midnight' | 'fajr';

export interface ScheduleOptions {
  timezone: string;
  warnMinutes: number;
  ishaEnd: IshaEnd;
  prayers: Record<Prayer, PrayerSettings>;
}

export interface PrayerWindow {
  date: string;
  prayer: Prayer;
  start: DateTime;
  /** null when the close time cannot be computed (missing next-day data). */
  close: DateTime | null;
  /** null when there is no warning (window too short, or close unknown). */
  endingAt: DateTime | null;
  startOn: boolean;
  endingOn: boolean;
}

export interface PrayerEvent {
  /** Stable id used for dedupe, e.g. "2026-10-01:isha:ending". */
  key: string;
  date: string;
  prayer: Prayer;
  kind: EventKind;
  at: DateTime;
}
