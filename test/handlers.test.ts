import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { handleInteraction } from '../src/commands/index.js';
import type { Repo } from '../src/db/repo.js';
import { TimingsService } from '../src/prayer/timings.js';
import type { AnnounceJob } from '../src/voice/queue.js';
import { FakeAladhan, memoryRepo, silentLog } from './helpers.js';

type Opts = Record<string, string | number | boolean | { id: string; joinable?: boolean; speakable?: boolean } | undefined>;

/** Just enough of a ChatInputCommandInteraction for the handlers. */
function interaction(commandName: string, opts: Opts = {}, subcommand?: string) {
  const out: { content?: string; embeds?: { data: { title?: string; description?: string; fields?: { name: string; value: string }[] } }[] }[] = [];
  const get = (name: string, required?: boolean) => {
    const v = opts[name];
    if (v === undefined && required) throw new Error(`missing required option ${name}`);
    return v ?? null;
  };
  const record = async (payload: string | { content?: string; embeds?: never[] }) => {
    out.push(typeof payload === 'string' ? { content: payload } : payload);
  };
  const i = {
    commandName,
    guildId: 'g1',
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    inCachedGuild: () => true,
    isRepliable: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: get,
      getInteger: get,
      getNumber: get,
      getBoolean: get,
      getChannel: get,
    },
    reply: async (p: string | { content?: string }) => {
      i.replied = true;
      await record(p);
    },
    deferReply: async () => {
      i.deferred = true;
    },
    editReply: record,
    out,
    text: () => out.map((o) => [o.content, ...(o.embeds ?? []).map((e) => JSON.stringify(e.data))].join(' ')).join('\n'),
  };
  return i;
}

let repo: Repo;
let ctx: CommandContext;
let jobs: AnnounceJob[];
let aladhan: FakeAladhan;

async function run(name: string, opts: Opts = {}, sub?: string) {
  const i = interaction(name, opts, sub);
  await handleInteraction(i as never, ctx);
  return i;
}

beforeEach(() => {
  repo = memoryRepo();
  jobs = [];
  aladhan = new FakeAladhan();
  ctx = {
    repo,
    timings: new TimingsService(repo, aladhan, silentLog),
    aladhan: {
      resolveCity: async (city) => {
        if (city === 'Nowhere') throw new Error('Unable to locate city and country.');
        return { latitude: 51.5074, longitude: -0.1278, timezone: 'Europe/London' };
      },
      resolveCoordinates: async (latitude, longitude) => ({ latitude, longitude, timezone: 'Europe/London' }),
    },
    queue: {
      enqueue: async (job) => {
        jobs.push(job);
        return { outcome: 'played', channelId: 'vc1' };
      },
    },
    now: () => DateTime.fromISO('2026-10-01T11:00:00Z'),
    log: silentLog,
  };
});

describe('command handlers', () => {
  it('asks for a location before showing a schedule', async () => {
    const i = await run('schedule');
    expect(i.text()).toContain('/config location');
  });

  it('sets a location by city and confirms with today\'s times', async () => {
    const i = await run('config', { city: 'London', country: 'GB' }, 'location');
    expect(i.text()).toContain('Location set to **London, GB** (Europe/London)');
    expect(i.text()).toContain('Fajr 05:28');
    expect(repo.getGuild('g1')).toMatchObject({ timezone: 'Europe/London', locationLabel: 'London, GB' });
  });

  it('reports an unknown city without saving it', async () => {
    const i = await run('config', { city: 'Nowhere', country: 'XX' }, 'location');
    expect(i.text()).toContain('Could not find that location');
    expect(repo.getGuild('g1')!.latitude).toBeNull();
  });

  it('requires city+country or coordinates', async () => {
    const i = await run('config', { city: 'London' }, 'location');
    expect(i.text()).toContain('Give either');
  });

  it('shows the schedule with statuses', async () => {
    await run('config', { latitude: 51.5, longitude: -0.12 }, 'location');
    repo.claimEvent('g1', '2026-10-01:fajr:start', 'x');
    repo.setOutcome('g1', '2026-10-01:fajr:start', 'skipped_empty');
    await run('prayer', { prayer: 'asr', enabled: false, which: 'ending' }, 'toggle');
    const i = await run('schedule');
    const text = i.text();
    expect(text).toContain('Prayer times for Thursday 1 October 2026');
    expect(text).toContain('Start announcement: on, skipped, channel empty');
    expect(text).toMatch(/Asr.*Ending soon at 18:24: off/);
  });

  it('shows tomorrow', async () => {
    await run('config', { city: 'London', country: 'GB' }, 'location');
    expect((await run('schedule', { day: 'tomorrow' })).text()).toContain('Friday 2 October 2026');
  });

  it('shows the next event', async () => {
    await run('config', { city: 'London', country: 'GB' }, 'location');
    // 11:00Z is 12:00 BST; Dhuhr is 12:50.
    expect((await run('next')).text()).toContain('Next: **Dhuhr starts** at 12:50 Europe/London');
  });

  it('pauses and resumes', async () => {
    await run('config', { city: 'London', country: 'GB' }, 'location');
    await run('pause', { duration: 'tomorrow' });
    expect(repo.getGuild('g1')!.pausedUntil).toBe('2026-10-01T23:00:00.000Z');
    expect((await run('next')).text()).toContain('paused');
    await run('pause');
    expect(repo.getGuild('g1')!.pausedUntil).toBe('forever');
    await run('resume');
    expect(repo.getGuild('g1')!.pausedUntil).toBeNull();
  });

  it('toggles prayers and lists them', async () => {
    await run('prayer', { prayer: 'fajr', enabled: false }, 'toggle');
    expect(repo.getPrayerSettings('g1').fajr).toMatchObject({ startOn: false, endingOn: false });
    await run('prayer', { prayer: 'fajr', enabled: true, which: 'start' }, 'toggle');
    expect(repo.getPrayerSettings('g1').fajr).toMatchObject({ startOn: true, endingOn: false });
    expect((await run('prayer', {}, 'list')).text()).toContain('**Fajr**: start on, ending soon off');
  });

  it('updates warning, method and adjustments', async () => {
    await run('config', { city: 'London', country: 'GB' }, 'location');
    await run('config', { minutes: 20 }, 'warning');
    expect(repo.getGuild('g1')!.warnMinutes).toBe(20);

    const m = await run('config', { method: 2, asr: 1, isha_end: 'fajr' }, 'method');
    expect(m.text()).toContain('Calculation settings updated');
    expect(repo.getGuild('g1')).toMatchObject({ method: 2, school: 1, ishaEnd: 'fajr' });
    expect(aladhan.calls.at(-1)!.params).toMatchObject({ method: 2, school: 1 });

    await run('config', { prayer: 'isha', minutes: 10 }, 'adjust');
    expect(repo.getPrayerSettings('g1').isha.offsetMinutes).toBe(10);
    const show = (await run('config', {}, 'show')).text();
    expect(show).toContain('Isha +10 min');
    expect(show).toContain('Hanafi');
  });

  it('sets the voice channel, checking permissions', async () => {
    const denied = await run('config', { channel: { id: 'vc9', joinable: false, speakable: true } }, 'channel');
    expect(denied.text()).toContain('Connect and Speak');
    await run('config', { channel: { id: 'vc1', joinable: true, speakable: true } }, 'channel');
    expect(repo.getGuild('g1')).toMatchObject({ voiceMode: 'fixed', voiceChannelId: 'vc1' });
    await run('config', { auto: true }, 'channel');
    expect(repo.getGuild('g1')).toMatchObject({ voiceMode: 'most_populated', voiceChannelId: null });
  });

  it('plays a test clip through the queue', async () => {
    const i = await run('test', { prayer: 'maghrib', kind: 'ending' });
    expect(jobs).toEqual([{ guildId: 'g1', prayer: 'maghrib', kind: 'ending' }]);
    expect(i.text()).toContain('Played the Maghrib ending soon clip in <#vc1>');
  });
});

describe('command errors', () => {
  it('explains when Aladhan is unreachable', async () => {
    const { AladhanError } = await import('../src/prayer/aladhan.js');
    await run('config', { city: 'London', country: 'GB' }, 'location');
    repo.clearDays('g1');
    ctx.timings = new TimingsService(repo, { getMonth: async () => { throw new AladhanError('down', true); } }, silentLog);
    expect((await run('schedule')).text()).toContain('Could not reach the prayer times service');
  });
});
