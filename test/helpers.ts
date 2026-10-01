import { DateTime } from 'luxon';
import { pino } from 'pino';
import { openDatabase } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import type { CalcParams, MonthResult } from '../src/prayer/aladhan.js';
import type { DayTimings } from '../src/prayer/types.js';

export const silentLog = pino({ level: 'silent' });

export function memoryRepo(): Repo {
  return new Repo(openDatabase(':memory:'));
}

export interface LocalTimes {
  fajr: string;
  sunrise: string;
  dhuhr: string;
  asr: string;
  maghrib: string;
  isha: string;
  /** Local time; assumed to be on the following calendar day if before 12:00. */
  midnight: string;
}

/** London-ish times for October, drifting a minute or two per day like the real thing. */
export function londonOctober(day: number): LocalTimes {
  const m = (base: string, perDay: number) => {
    const [h, min] = base.split(':').map(Number);
    const total = h! * 60 + min! + Math.round(perDay * (day - 1));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  return {
    fajr: m('05:28', 1.3),
    sunrise: m('07:03', 1.8),
    dhuhr: m('12:50', -0.3),
    asr: m('15:51', -1.5),
    maghrib: m('18:39', -1.8),
    isha: m('20:05', -1.7),
    midnight: m('00:51', 0),
  };
}

function iso(date: string, hhmm: string, zone: string, nextDay = false): string {
  const [hour, minute] = hhmm.split(':').map(Number);
  let dt = DateTime.fromISO(date, { zone }).set({ hour, minute, second: 0, millisecond: 0 });
  if (nextDay) dt = dt.plus({ days: 1 });
  return dt.toISO({ suppressMilliseconds: true })!;
}

/** A DayTimings as the app stores it, from local wall-clock times. */
export function makeDay(date: string, zone: string, t: LocalTimes): DayTimings {
  const midnightNextDay = Number(t.midnight.split(':')[0]) < 12;
  return {
    date,
    fajr: iso(date, t.fajr, zone),
    sunrise: iso(date, t.sunrise, zone),
    dhuhr: iso(date, t.dhuhr, zone),
    asr: iso(date, t.asr, zone),
    maghrib: iso(date, t.maghrib, zone),
    isha: iso(date, t.isha, zone),
    midnight: iso(date, t.midnight, zone, midnightNextDay),
  };
}

/** Full Aladhan /calendar response body for a month. */
export function aladhanMonthBody(
  year: number,
  month: number,
  zone: string,
  timesFor: (day: number, month: number) => LocalTimes,
  coords = { latitude: 51.5074, longitude: -0.1278 },
): unknown {
  const first = DateTime.fromObject({ year, month, day: 1 }, { zone });
  const data = [];
  for (let d = 1; d <= first.daysInMonth!; d++) {
    const date = first.set({ day: d }).toISODate()!;
    const day = makeDay(date, zone, timesFor(d, month));
    data.push({
      timings: {
        Fajr: day.fajr,
        Sunrise: day.sunrise,
        Dhuhr: day.dhuhr,
        Asr: day.asr,
        Sunset: day.maghrib,
        Maghrib: day.maghrib,
        Isha: day.isha,
        Imsak: day.fajr,
        Midnight: day.midnight,
        Firstthird: day.isha,
        Lastthird: day.fajr,
      },
      date: {
        readable: date,
        timestamp: String(first.set({ day: d }).toUnixInteger()),
        gregorian: { date: `${String(d).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`, format: 'DD-MM-YYYY' },
        hijri: { date: '', day: String(d), month: { number: 4, en: 'Rabi al-thani', ar: '' }, year: '1448' },
      },
      meta: { ...coords, timezone: zone, method: { id: 3, name: 'Muslim World League' }, school: 'STANDARD' },
    });
  }
  return { code: 200, status: 'OK', data };
}

/** Fake Aladhan client for the timings service. */
export class FakeAladhan {
  calls: { params: CalcParams; year: number; month: number }[] = [];
  failNext = 0;

  constructor(
    private readonly zone = 'Europe/London',
    private readonly timesFor: (day: number, month: number) => LocalTimes = (d) => londonOctober(d),
  ) {}

  async getMonth(params: CalcParams, year: number, month: number): Promise<MonthResult> {
    this.calls.push({ params, year, month });
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated outage');
    }
    const first = DateTime.fromObject({ year, month, day: 1 }, { zone: this.zone });
    const days: DayTimings[] = [];
    for (let d = 1; d <= first.daysInMonth!; d++) {
      days.push(makeDay(first.set({ day: d }).toISODate()!, this.zone, this.timesFor(d, month)));
    }
    return { timezone: this.zone, days };
  }
}
