/**
 * End-to-end run of the bot with only Discord's network replaced:
 * a real HTTP server stands in for Aladhan, the database is a real SQLite file,
 * the real scheduler runs over two simulated days (including the October clock
 * change), commands go through the real handlers, and every announcement is
 * played through @discordjs/voice's real audio player using the shipped clips.
 */
import { createReadStream, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
} from '@discordjs/voice';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandContext } from '../../src/commands/context.js';
import { handleInteraction } from '../../src/commands/index.js';
import { openDatabase, type DB } from '../../src/db/index.js';
import { Repo, type Outcome } from '../../src/db/repo.js';
import { AladhanClient } from '../../src/prayer/aladhan.js';
import { TimingsService } from '../../src/prayer/timings.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import type { ChannelInfo } from '../../src/voice/channels.js';
import { AnnouncementQueue, type VoiceDriver } from '../../src/voice/queue.js';
import { fakeInteraction, type Opts } from '../fakes.js';
import { aladhanMonthBody, londonOctober, silentLog } from '../helpers.js';

const ZONE = 'Europe/London';
const AUDIO_DIR = path.resolve('assets/audio');
const local = (iso: string) => DateTime.fromISO(iso, { zone: ZONE });

let clock = local('2026-10-24T01:00');

// ---------------------------------------------------------------- fake Aladhan

const aladhan = {
  down: false,
  requests: [] as { path: string; status: number; query: URLSearchParams }[],
  server: undefined as http.Server | undefined,
  baseUrl: '',
};

function startAladhan(): Promise<void> {
  const cityFixture = JSON.parse(readFileSync(new URL('../fixtures/aladhan-timingsByCity.json', import.meta.url), 'utf8'));
  aladhan.server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const send = (status: number, body: unknown) => {
      aladhan.requests.push({ path: url.pathname, status, query: url.searchParams });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (aladhan.down) return send(503, { code: 503, status: 'Service Unavailable', data: 'down for maintenance' });

    const month = url.pathname.match(/^\/v1\/calendar\/(\d{4})\/(\d{1,2})$/);
    if (month) {
      if (url.searchParams.get('iso8601') !== 'true') return send(400, { code: 400, data: 'expected iso8601' });
      return send(200, aladhanMonthBody(Number(month[1]), Number(month[2]), ZONE, londonOctober));
    }
    if (url.pathname.startsWith('/v1/timingsByCity/')) {
      if (url.searchParams.get('city') !== 'London') return send(400, { code: 400, data: 'Unable to locate city and country.' });
      return send(200, cityFixture);
    }
    send(404, { code: 404, data: 'not found' });
  });
  return new Promise((resolve) =>
    aladhan.server!.listen(0, '127.0.0.1', () => {
      aladhan.baseUrl = `http://127.0.0.1:${(aladhan.server!.address() as AddressInfo).port}/v1`;
      resolve();
    }),
  );
}

// ------------------------------------------------------------- simulated voice

/** A server with one text-free voice channel; plays clips through the real audio player. */
class SimVoice implements VoiceDriver {
  humans = 2;
  connectedTo: string | null = null;
  connects = 0;
  disconnects = 0;
  plays: { clip: string; at: DateTime; durationMs: number }[] = [];

  listChannels(): ChannelInfo[] {
    return [
      { id: 'vc1', name: 'General', position: 0, humans: this.humans, canSpeak: true },
      { id: 'vc2', name: 'Quiet', position: 1, humans: 0, canSpeak: true },
    ];
  }

  async connect(_guildId: string, channelId: string): Promise<void> {
    this.connects++;
    this.connectedTo = channelId;
  }

  async play(_guildId: string, file: string): Promise<void> {
    if (!this.connectedTo) throw new Error('play() before connect()');
    const at = clock;
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const resource = createAudioResource(createReadStream(file), { inputType: StreamType.OggOpus });
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, 5_000);
    await entersState(player, AudioPlayerStatus.Idle, 30_000);
    this.plays.push({ clip: path.basename(file), at, durationMs: resource.playbackDuration });
  }

  disconnect(): void {
    if (this.connectedTo) this.disconnects++;
    this.connectedTo = null;
  }
}

// ----------------------------------------------------------------- the "app"

const dbFile = path.join(mkdtempSync(path.join(tmpdir(), 'bilal-e2e-')), 'bilal.db');
const voice = new SimVoice();

interface App {
  db: DB;
  repo: Repo;
  timings: TimingsService;
  queue: AnnouncementQueue;
  scheduler: Scheduler;
  ctx: CommandContext;
}

/** Wires everything the way src/index.ts does. Called again to simulate a restart. */
function boot(): App {
  const db = openDatabase(dbFile);
  const repo = new Repo(db);
  const client = new AladhanClient({ baseUrl: aladhan.baseUrl, retryDelaysMs: [0, 0] });
  const timings = new TimingsService(repo, client, silentLog);
  const queue = new AnnouncementQueue(voice, repo, AUDIO_DIR, silentLog);
  const scheduler = new Scheduler({ repo, timings, queue, log: silentLog, now: () => clock });
  const ctx: CommandContext = { repo, timings, aladhan: client, queue, now: () => clock, log: silentLog };
  return { db, repo, timings, queue, scheduler, ctx };
}

let app: App;

async function command(name: string, opts: Opts = {}, sub?: string): Promise<string> {
  const i = fakeInteraction(name, opts, sub);
  await handleInteraction(i as never, app.ctx);
  return i.text();
}

/** Advances the simulated clock in scheduler-sized steps, letting fetches and clips finish each step. */
async function runUntil(localIso: string): Promise<void> {
  const end = local(localIso);
  while (clock < end) {
    clock = clock.plus({ seconds: 10 });
    await app.scheduler.tick();
    for (const cfg of app.repo.locatedGuilds()) await app.timings.ensure(cfg, clock).catch(() => undefined);
    await app.queue.idle();
  }
}

function outcomes(date: string): Record<string, Outcome> {
  return Object.fromEntries(app.repo.outcomesForDate('g1', date));
}

// ------------------------------------------------------------------- the run

const replies: Record<string, string> = {};

beforeAll(async () => {
  await startAladhan();
  app = boot();

  replies.badCity = await command('config', { city: 'Atlantis', country: 'XX' }, 'location');
  replies.location = await command('config', { city: 'London', country: 'United Kingdom' }, 'location');
  replies.channel = await command('config', { channel: { id: 'vc1', joinable: true, speakable: true } }, 'channel');
  replies.schedule24 = await command('schedule');

  // Saturday 24 October: a normal day. Late in the evening Aladhan goes down,
  // just before the bot would fetch November. October is cached, so
  // announcements must carry on.
  await runUntil('2026-10-24T23:00');
  aladhan.down = true;
  await runUntil('2026-10-25T06:00');

  // The process restarts.
  app.db.close();
  app = boot();

  // Nobody is in voice over Dhuhr.
  await runUntil('2026-10-25T10:00');
  voice.humans = 0;
  await runUntil('2026-10-25T14:00');
  voice.humans = 3;

  replies.toggleAsr = await command('prayer', { prayer: 'asr', enabled: false }, 'toggle');
  await runUntil('2026-10-25T18:00');
  aladhan.down = false;

  await runUntil('2026-10-25T19:00');
  replies.pause = await command('pause', { duration: '1h' });
  replies.nextWhilePaused = await command('next');

  await runUntil('2026-10-26T01:00');
  replies.schedule25 = await command('schedule', {});
  replies.test = await command('test', { prayer: 'isha', kind: 'start' });
}, 300_000);

afterAll(() => {
  app?.db.close();
  aladhan.server?.close();
});

describe('end to end', () => {
  it('sets up through the commands, resolving the city over HTTP', () => {
    expect(replies.badCity).toContain('Could not find that location: Unable to locate city and country.');
    expect(replies.location).toContain('Location set to **London, United Kingdom** (Europe/London)');
    expect(replies.location).toMatch(/Today: Fajr 05:58 \| Dhuhr 12:43 \| Asr 15:17 \| Maghrib 17:58 \| Isha 19:26/);
    expect(replies.channel).toContain('<#vc1>');
    expect(replies.schedule24).toContain('Saturday 24 October 2026');
  });

  it('requests prayer times with the configured parameters', () => {
    const calendar = aladhan.requests.find((r) => r.path === '/v1/calendar/2026/10' && r.status === 200)!;
    expect(Object.fromEntries(calendar.query)).toMatchObject({
      latitude: '51.5073219',
      longitude: '-0.1276474',
      method: '3',
      school: '0',
      iso8601: 'true',
    });
  });

  it('announces all ten events on a normal day', () => {
    const o = outcomes('2026-10-24');
    expect(Object.keys(o)).toHaveLength(10);
    expect(Object.values(o).every((v) => v === 'played')).toBe(true);
  });

  it('handles the second day: empty channel, toggle, pause, restart and outage', () => {
    expect(outcomes('2026-10-25')).toEqual({
      '2026-10-25:fajr:start': 'played',
      '2026-10-25:fajr:ending': 'played',
      '2026-10-25:dhuhr:start': 'skipped_empty',
      '2026-10-25:dhuhr:ending': 'played',
      // Asr toggled off before it started: never scheduled at all.
      '2026-10-25:maghrib:start': 'played',
      '2026-10-25:maghrib:ending': 'skipped_paused',
      '2026-10-25:isha:start': 'skipped_paused',
      '2026-10-25:isha:ending': 'played',
    });
  });

  it('plays each announcement within one tick of its time, including after the clock change', () => {
    const scheduled = voice.plays.slice(0, -1); // the last play is /test
    expect(scheduled).toHaveLength(15);
    // Every prayer time is on the minute and the scheduler ticks every 10 seconds.
    for (const p of scheduled) expect(p.at.second, p.clip).toBeLessThanOrEqual(10);
    const byClip = (clip: string) => scheduled.filter((p) => p.clip === clip).map((p) => p.at.toUTC().toISO());
    // Fajr 05:58 BST on the 24th, 05:59 GMT on the 25th (clocks went back at 02:00).
    expect(byClip('fajr_start.ogg')).toEqual(['2026-10-24T04:58:00.000Z', '2026-10-25T05:59:00.000Z']);
    // Isha on the 25th ends at 00:51 GMT on the 26th; warning 15 minutes before.
    expect(byClip('isha_ending.ogg').at(-1)).toBe('2026-10-26T00:36:00.000Z');
  });

  it('plays real audio of the right length and never announces twice', () => {
    for (const p of voice.plays) expect(p.durationMs, p.clip).toBeGreaterThan(1_500);
    const keys = voice.plays.map((p) => `${p.at.toISO()}|${p.clip}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves voice after every announcement', () => {
    expect(voice.connectedTo).toBeNull();
    expect(voice.disconnects).toBeGreaterThanOrEqual(1);
    expect(voice.connects).toBe(voice.plays.length);
  });

  it('kept working through the Aladhan outage and caught up afterwards', () => {
    const failed = aladhan.requests.filter((r) => r.status === 503);
    expect(failed.length).toBeGreaterThan(0);
    // One attempt (of up to 3 quick tries) per 10 minutes over the 19 hour outage,
    // rather than one every 10 second tick.
    const outageWindows = (19 * 60) / 10;
    expect(failed.length).toBeGreaterThan(outageWindows);
    expect(failed.length).toBeLessThanOrEqual(3 * (outageWindows + 2));
    expect(aladhan.requests.some((r) => r.path === '/v1/calendar/2026/11' && r.status === 200)).toBe(true);
  });

  it('reports state accurately through the commands', () => {
    expect(replies.toggleAsr).toContain('Asr announcements turned **off**');
    expect(replies.pause).toContain('Announcements paused until');
    expect(replies.nextWhilePaused).toContain('paused');
    expect(replies.schedule25).toContain('Monday 26 October 2026');
    expect(replies.test).toContain('Played the Isha start clip in <#vc1>');
  });

  it("shows yesterday's history in the schedule", async () => {
    clock = local('2026-10-25T23:00');
    const text = await command('schedule');
    expect(text).toContain('Sunday 25 October 2026');
    expect(text).toContain('Start announcement: on, skipped, channel empty');
    expect(text).toContain('skipped, paused');
    expect(text).toMatch(/"name":"Asr","value":"[^"]*Start announcement: off/);
  });
});
