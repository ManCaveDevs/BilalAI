import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { PRAYERS, type DayTimings, type PrayerSettings, type ScheduleOptions } from '../src/prayer/types.js';
import { buildDayWindows, buildEvents, relevantDates } from '../src/prayer/windows.js';
import { londonOctober, makeDay, type LocalTimes } from './helpers.js';

const ZONE = 'Europe/London';

function opts(overrides: Partial<ScheduleOptions> = {}, prayer: Partial<Record<string, Partial<PrayerSettings>>> = {}): ScheduleOptions {
  return {
    timezone: ZONE,
    warnMinutes: 15,
    ishaEnd: 'midnight',
    prayers: Object.fromEntries(
      PRAYERS.map((p) => [p, { startOn: true, endingOn: true, offsetMinutes: 0, ...prayer[p] }]),
    ) as ScheduleOptions['prayers'],
    ...overrides,
  };
}

function lookupOf(days: DayTimings[]) {
  const map = new Map(days.map((d) => [d.date, d]));
  return (date: string) => map.get(date);
}

function octoberDays(from: number, to: number, times: (d: number) => LocalTimes = londonOctober): DayTimings[] {
  const out: DayTimings[] = [];
  for (let d = from; d <= to; d++) out.push(makeDay(`2026-10-${String(d).padStart(2, '0')}`, ZONE, times(d)));
  return out;
}

const local = (dt: DateTime | null) => dt?.setZone(ZONE).toFormat('yyyy-MM-dd HH:mm');

describe('buildDayWindows', () => {
  const day1: LocalTimes = {
    fajr: '05:28',
    sunrise: '07:03',
    dhuhr: '12:50',
    asr: '15:51',
    maghrib: '18:39',
    isha: '20:05',
    midnight: '00:51',
  };
  const lookup = lookupOf([makeDay('2026-10-01', ZONE, day1), makeDay('2026-10-02', ZONE, { ...day1, fajr: '05:30' })]);

  it('closes each window at the next boundary and warns before it', () => {
    const w = buildDayWindows('2026-10-01', lookup, opts());
    expect(w.map((x) => [x.prayer, local(x.start), local(x.close), local(x.endingAt)])).toEqual([
      ['fajr', '2026-10-01 05:28', '2026-10-01 07:03', '2026-10-01 06:48'],
      ['dhuhr', '2026-10-01 12:50', '2026-10-01 15:51', '2026-10-01 15:36'],
      ['asr', '2026-10-01 15:51', '2026-10-01 18:39', '2026-10-01 18:24'],
      ['maghrib', '2026-10-01 18:39', '2026-10-01 20:05', '2026-10-01 19:50'],
      ['isha', '2026-10-01 20:05', '2026-10-02 00:51', '2026-10-02 00:36'],
    ]);
  });

  it('moves a same-dated midnight timestamp to the next day', () => {
    const buggy = { ...makeDay('2026-10-01', ZONE, day1), midnight: '2026-10-01T00:51:00+01:00' };
    const w = buildDayWindows('2026-10-01', lookupOf([buggy]), opts());
    expect(local(w[4]!.close)).toBe('2026-10-02 00:51');
  });

  it('can end Isha at the next Fajr', () => {
    const w = buildDayWindows('2026-10-01', lookup, opts({ ishaEnd: 'fajr' }));
    expect(local(w[4]!.close)).toBe('2026-10-02 05:30');
    expect(local(w[4]!.endingAt)).toBe('2026-10-02 05:15');
  });

  it('has no Isha warning when ending at Fajr and the next day is unknown', () => {
    const w = buildDayWindows('2026-10-02', lookup, opts({ ishaEnd: 'fajr' }));
    expect(w[4]!.close).toBeNull();
    expect(w[4]!.endingAt).toBeNull();
  });

  it('drops the warning when the window is too short for it', () => {
    // Maghrib to Isha is 86 minutes.
    expect(buildDayWindows('2026-10-01', lookup, opts({ warnMinutes: 60 }))[3]!.endingAt).not.toBeNull();
    expect(buildDayWindows('2026-10-01', lookup, opts({ warnMinutes: 82 }))[3]!.endingAt).toBeNull();
  });

  it('applies offsets to starts, and therefore to the previous window close', () => {
    const w = buildDayWindows('2026-10-01', lookup, opts({}, { isha: { offsetMinutes: 10 }, fajr: { offsetMinutes: -5 } }));
    expect(local(w[0]!.start)).toBe('2026-10-01 05:23');
    expect(local(w[3]!.close)).toBe('2026-10-01 20:15');
    expect(local(w[4]!.start)).toBe('2026-10-01 20:15');
    // Sunrise is not a prayer start and is never shifted.
    expect(local(w[0]!.close)).toBe('2026-10-01 07:03');
  });

  it('returns nothing for an unknown day', () => {
    expect(buildDayWindows('2026-12-25', lookup, opts())).toEqual([]);
  });
});

describe('buildEvents', () => {
  it('produces ten sorted events per day with stable keys', () => {
    const events = buildEvents(['2026-10-01'], lookupOf(octoberDays(1, 2)), opts());
    expect(events).toHaveLength(10);
    expect(events.map((e) => e.key)).toEqual([
      '2026-10-01:fajr:start',
      '2026-10-01:fajr:ending',
      '2026-10-01:dhuhr:start',
      '2026-10-01:dhuhr:ending',
      '2026-10-01:asr:start',
      '2026-10-01:asr:ending',
      '2026-10-01:maghrib:start',
      '2026-10-01:maghrib:ending',
      '2026-10-01:isha:start',
      '2026-10-01:isha:ending',
    ]);
  });

  it('respects toggles', () => {
    const events = buildEvents(
      ['2026-10-01'],
      lookupOf(octoberDays(1, 2)),
      opts({}, { fajr: { startOn: false, endingOn: false }, asr: { endingOn: false }, isha: { startOn: false } }),
    );
    const keys = events.map((e) => e.key);
    expect(keys).toHaveLength(6);
    expect(keys).not.toContain('2026-10-01:fajr:start');
    expect(keys).not.toContain('2026-10-01:asr:ending');
    expect(keys).toContain('2026-10-01:asr:start');
    expect(keys).toContain('2026-10-01:isha:ending');
  });

  it('keeps wall-clock times correct across the October DST change', () => {
    // Clocks go back at 02:00 BST on Sunday 25 October 2026.
    const days = octoberDays(24, 26);
    const events = buildEvents(['2026-10-24', '2026-10-25', '2026-10-26'], lookupOf(days), opts());
    expect(events).toHaveLength(30);
    const fajr = events.filter((e) => e.prayer === 'fajr' && e.kind === 'start');
    expect(fajr.map((e) => local(e.at))).toEqual(['2026-10-24 05:58', '2026-10-25 05:59', '2026-10-26 06:01']);
    expect(fajr.map((e) => e.at.setZone(ZONE).offset)).toEqual([60, 0, 0]);
    // Isha on the 24th ends at 00:51 on the 25th, still BST (clocks change at 02:00).
    const ishaEnd = events.find((e) => e.key === '2026-10-24:isha:ending')!;
    expect(ishaEnd.at.toUTC().toISO()).toBe('2026-10-24T23:36:00.000Z');
    // Isha on the 25th is entirely in GMT.
    const ishaEnd25 = events.find((e) => e.key === '2026-10-25:isha:ending')!;
    expect(ishaEnd25.at.toUTC().toISO()).toBe('2026-10-26T00:36:00.000Z');
    // Sorted strictly by instant.
    for (let i = 1; i < events.length; i++) expect(events[i]!.at >= events[i - 1]!.at).toBe(true);
  });

  it('crosses a month boundary for Isha ending at Fajr', () => {
    const oct31 = makeDay('2026-10-31', ZONE, londonOctober(31));
    const nov1 = makeDay('2026-11-01', ZONE, { ...londonOctober(31), fajr: '06:10' });
    const events = buildEvents(['2026-10-31'], lookupOf([oct31, nov1]), opts({ ishaEnd: 'fajr' }));
    expect(local(events.find((e) => e.key === '2026-10-31:isha:ending')!.at)).toBe('2026-11-01 05:55');
  });

  it('handles a high-latitude summer day where Isha is after midnight', () => {
    const ZONE_OSLO = 'Europe/Oslo';
    const day = makeDay('2026-06-20', ZONE_OSLO, {
      fajr: '01:20',
      sunrise: '03:53',
      dhuhr: '13:23',
      asr: '18:12',
      maghrib: '22:53',
      isha: '23:59',
      midnight: '01:23',
    });
    const w = buildDayWindows('2026-06-20', lookupOf([day]), opts({ timezone: ZONE_OSLO }));
    expect(w[4]!.close!.diff(w[4]!.start, 'minutes').minutes).toBe(84);
    expect(w[4]!.endingAt!.setZone(ZONE_OSLO).toFormat('dd HH:mm')).toBe('21 01:08');
  });
});

describe('relevantDates', () => {
  it('uses the calendar date in the location timezone', () => {
    // 23:30 UTC on 1 Oct is 00:30 BST on 2 Oct in London.
    const now = DateTime.fromISO('2026-10-01T23:30:00Z');
    expect(relevantDates(now, ZONE)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });
});
