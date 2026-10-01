import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LocatedConfig, Repo } from '../src/db/repo.js';
import { TimingsService } from '../src/prayer/timings.js';
import { GRACE_MS, Scheduler } from '../src/scheduler/scheduler.js';
import type { AnnounceJob, AnnounceResult } from '../src/voice/queue.js';
import { FakeAladhan, memoryRepo, silentLog } from './helpers.js';

class FakeQueue {
  jobs: AnnounceJob[] = [];
  async enqueue(job: AnnounceJob): Promise<AnnounceResult> {
    this.jobs.push(job);
    return { outcome: 'played' };
  }
}

let repo: Repo;
let timings: TimingsService;
let queue: FakeQueue;
let clock: DateTime;
let cfg: LocatedConfig;

function scheduler() {
  return new Scheduler({ repo, timings, queue, log: silentLog, now: () => clock });
}

async function at(iso: string, s = scheduler()) {
  clock = DateTime.fromISO(iso);
  await timings.ensure(cfg, clock);
  await s.tick();
  return s;
}

beforeEach(() => {
  repo = memoryRepo();
  timings = new TimingsService(repo, new FakeAladhan(), silentLog);
  queue = new FakeQueue();
  cfg = repo.updateGuild('g1', {
    latitude: 51.5074,
    longitude: -0.1278,
    timezone: 'Europe/London',
    voiceChannelId: 'vc1',
  }) as LocatedConfig;
});

// On 2026-10-01 (BST, UTC+1): Fajr 05:28, Sunrise 07:03 so Fajr ending 06:48.
describe('Scheduler', () => {
  it('announces an event once, however many ticks see it', async () => {
    const s = await at('2026-10-01T04:28:05Z');
    await at('2026-10-01T04:28:15Z', s);
    await at('2026-10-01T04:29:00Z', s);
    expect(queue.jobs).toEqual([{ guildId: 'g1', prayer: 'fajr', kind: 'start', eventKey: '2026-10-01:fajr:start' }]);
  });

  it('does nothing before an event is due', async () => {
    await at('2026-10-01T04:27:55Z');
    expect(queue.jobs).toHaveLength(0);
  });

  it('never repeats an event after a restart', async () => {
    await at('2026-10-01T04:28:05Z');
    await at('2026-10-01T04:28:30Z', scheduler());
    expect(queue.jobs).toHaveLength(1);
  });

  it('still announces within the grace window after downtime, and skips after it', async () => {
    await at('2026-10-01T04:29:30Z');
    expect(queue.jobs.map((j) => j.eventKey)).toEqual(['2026-10-01:fajr:start']);

    await at(DateTime.fromISO('2026-10-01T05:48:00Z').plus({ milliseconds: GRACE_MS + 1000 }).toISO()!);
    expect(queue.jobs).toHaveLength(1);
  });

  it('records paused events and does not play them later', async () => {
    repo.updateGuild('g1', { pausedUntil: 'forever' });
    cfg = repo.getGuild('g1') as LocatedConfig;
    await at('2026-10-01T04:28:05Z');
    expect(queue.jobs).toHaveLength(0);
    expect(repo.outcomesForDate('g1', '2026-10-01').get('2026-10-01:fajr:start')).toBe('skipped_paused');

    repo.updateGuild('g1', { pausedUntil: null });
    await at('2026-10-01T04:28:30Z');
    expect(queue.jobs).toHaveLength(0);
  });

  it('resumes automatically when a timed pause runs out', async () => {
    repo.updateGuild('g1', { pausedUntil: '2026-10-01T05:00:00Z' });
    await at('2026-10-01T05:48:10Z');
    expect(queue.jobs.map((j) => j.eventKey)).toEqual(['2026-10-01:fajr:ending']);
  });

  it("announces yesterday's Isha ending after midnight", async () => {
    // Isha on 1 Oct ends at 00:51 BST on 2 Oct, warning at 00:36 BST = 23:36Z on 1 Oct.
    await at('2026-10-01T23:36:10Z');
    expect(queue.jobs.map((j) => j.eventKey)).toEqual(['2026-10-01:isha:ending']);
  });

  it('skips prayers that are toggled off', async () => {
    repo.updatePrayerSettings('g1', 'fajr', { startOn: false });
    await at('2026-10-01T04:28:05Z');
    await at('2026-10-01T05:48:05Z');
    expect(queue.jobs.map((j) => j.eventKey)).toEqual(['2026-10-01:fajr:ending']);
  });

  it('ignores servers without a location', async () => {
    repo.ensureGuild('g2');
    await at('2026-10-01T04:28:05Z');
    expect(queue.jobs.every((j) => j.guildId === 'g1')).toBe(true);
  });
});
