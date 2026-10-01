import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { LocatedConfig } from '../src/db/repo.js';
import { TimingsService } from '../src/prayer/timings.js';
import { FakeAladhan, memoryRepo, silentLog } from './helpers.js';

function setup() {
  const repo = memoryRepo();
  const aladhan = new FakeAladhan();
  const timings = new TimingsService(repo, aladhan, silentLog);
  const cfg = repo.updateGuild('g1', { latitude: 51.5074, longitude: -0.1278, timezone: 'Europe/London' }) as LocatedConfig;
  return { repo, aladhan, timings, cfg };
}

describe('TimingsService', () => {
  it('fetches the month once and then serves from cache', async () => {
    const { aladhan, timings, cfg } = setup();
    const now = DateTime.fromISO('2026-10-10T12:00:00Z');
    await timings.ensure(cfg, now);
    await timings.ensure(cfg, now.plus({ days: 3 }));
    expect(aladhan.calls.map((c) => `${c.year}-${c.month}`)).toEqual(['2026-10']);
    expect(timings.lookup(cfg)('2026-10-10')?.fajr).toBe('2026-10-10T05:40:00+01:00');
  });

  it('prefetches next month a week ahead and fetches the previous month on the 1st', async () => {
    const { aladhan, timings, cfg } = setup();
    await timings.ensure(cfg, DateTime.fromISO('2026-10-27T12:00:00Z'));
    expect(aladhan.calls.map((c) => `${c.year}-${c.month}`)).toEqual(['2026-10', '2026-11']);

    const fresh = setup();
    await fresh.timings.ensure(fresh.cfg, DateTime.fromISO('2026-11-01T12:00:00Z'));
    expect(fresh.aladhan.calls.map((c) => `${c.year}-${c.month}`)).toEqual(['2026-10', '2026-11']);
  });

  it('refetches when calculation settings change', async () => {
    const { repo, aladhan, timings, cfg } = setup();
    const now = DateTime.fromISO('2026-10-10T12:00:00Z');
    await timings.ensure(cfg, now);
    const changed = repo.updateGuild('g1', { school: 1 }) as LocatedConfig;
    expect(timings.lookup(changed)('2026-10-10')).toBeUndefined();
    await timings.ensure(changed, now);
    expect(aladhan.calls).toHaveLength(2);
    expect(aladhan.calls[1]!.params.school).toBe(1);
  });

  it('backs off for 10 minutes after a failure unless forced', async () => {
    const { aladhan, timings, cfg } = setup();
    const now = DateTime.fromISO('2026-10-10T12:00:00Z');
    aladhan.failNext = 1;
    await expect(timings.ensure(cfg, now)).rejects.toThrow('simulated outage');
    await timings.ensure(cfg, now.plus({ minutes: 5 }));
    expect(aladhan.calls).toHaveLength(1);
    await timings.ensure(cfg, now.plus({ minutes: 11 }));
    expect(aladhan.calls).toHaveLength(2);

    aladhan.failNext = 1;
    const later = now.plus({ days: 40 });
    await expect(timings.ensure(cfg, later)).rejects.toThrow();
    await timings.ensure(cfg, later.plus({ minutes: 1 }), true);
    expect(timings.lookup(cfg)(later.toISODate()!)).toBeDefined();
  });

  it('shares one request between concurrent callers', async () => {
    const { aladhan, timings, cfg } = setup();
    const now = DateTime.fromISO('2026-10-10T12:00:00Z');
    await Promise.all([timings.ensure(cfg, now), timings.ensure(cfg, now), timings.ensure(cfg, now)]);
    expect(aladhan.calls).toHaveLength(1);
  });
});
