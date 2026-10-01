import { describe, expect, it } from 'vitest';
import type { ChannelInfo } from '../src/voice/channels.js';
import { AnnouncementQueue, type VoiceDriver } from '../src/voice/queue.js';
import { memoryRepo, silentLog } from './helpers.js';

class FakeDriver implements VoiceDriver {
  log: string[] = [];
  channels: ChannelInfo[] | null = [{ id: 'vc1', name: 'General', position: 0, humans: 2, canSpeak: true }];
  failPlay = false;
  playDelay = 0;

  listChannels() {
    return this.channels;
  }
  async connect(_g: string, channelId: string) {
    this.log.push(`connect ${channelId}`);
  }
  async play(_g: string, file: string) {
    this.log.push(`play ${file.split('/').pop()}`);
    if (this.playDelay) await new Promise((r) => setTimeout(r, this.playDelay));
    if (this.failPlay) throw new Error('boom');
  }
  disconnect() {
    this.log.push('disconnect');
  }
}

function setup() {
  const repo = memoryRepo();
  repo.updateGuild('g1', { voiceChannelId: 'vc1' });
  const driver = new FakeDriver();
  const notes: string[] = [];
  const queue = new AnnouncementQueue(driver, repo, '/audio', silentLog, (job, r) => notes.push(`${job.prayer}:${r.outcome}`));
  return { repo, driver, queue, notes };
}

describe('AnnouncementQueue', () => {
  it('joins, plays the right clip, leaves and records the outcome', async () => {
    const { repo, driver, queue, notes } = setup();
    repo.claimEvent('g1', '2026-10-01:dhuhr:start', 'now');
    const result = await queue.enqueue({ guildId: 'g1', prayer: 'dhuhr', kind: 'start', eventKey: '2026-10-01:dhuhr:start' });
    expect(result).toEqual({ outcome: 'played', channelId: 'vc1' });
    expect(driver.log).toEqual(['connect vc1', 'play dhuhr_start.ogg', 'disconnect']);
    expect(repo.outcomesForDate('g1', '2026-10-01').get('2026-10-01:dhuhr:start')).toBe('played');
    expect(notes).toEqual(['dhuhr:played']);
  });

  it('does not join an empty channel', async () => {
    const { driver, queue } = setup();
    driver.channels = [{ id: 'vc1', name: 'General', position: 0, humans: 0, canSpeak: true }];
    const result = await queue.enqueue({ guildId: 'g1', prayer: 'asr', kind: 'ending' });
    expect(result.outcome).toBe('skipped_empty');
    expect(driver.log).toEqual(['disconnect']);
  });

  it('plays back-to-back events over one connection, leaving only at the end', async () => {
    const { driver, queue } = setup();
    driver.playDelay = 5;
    const a = queue.enqueue({ guildId: 'g1', prayer: 'maghrib', kind: 'ending' });
    const b = queue.enqueue({ guildId: 'g1', prayer: 'isha', kind: 'start' });
    await Promise.all([a, b]);
    expect(driver.log).toEqual(['connect vc1', 'play maghrib_ending.ogg', 'connect vc1', 'play isha_start.ogg', 'disconnect']);
  });

  it('always leaves voice after a failure', async () => {
    const { repo, driver, queue } = setup();
    driver.failPlay = true;
    repo.claimEvent('g1', 'k', 'now');
    const result = await queue.enqueue({ guildId: 'g1', prayer: 'fajr', kind: 'start', eventKey: 'k' });
    expect(result).toMatchObject({ outcome: 'error', detail: 'boom' });
    expect(driver.log.at(-1)).toBe('disconnect');
  });

  it('reports a missing channel configuration', async () => {
    const { repo, queue } = setup();
    repo.updateGuild('g1', { voiceChannelId: null });
    expect((await queue.enqueue({ guildId: 'g1', prayer: 'fajr', kind: 'start' })).outcome).toBe('skipped_no_channel');
  });

  it('reports an unavailable server', async () => {
    const { driver, queue } = setup();
    driver.channels = null;
    expect((await queue.enqueue({ guildId: 'g1', prayer: 'fajr', kind: 'start' })).outcome).toBe('error');
  });

  it('idle() waits for queued work', async () => {
    const { driver, queue } = setup();
    driver.playDelay = 20;
    void queue.enqueue({ guildId: 'g1', prayer: 'fajr', kind: 'start' });
    await queue.idle();
    expect(driver.log.at(-1)).toBe('disconnect');
  });
});

describe('AnnouncementQueue after draining', () => {
  it('starts a fresh drain for a job enqueued after the previous one finished', async () => {
    const { driver, queue } = setup();
    await queue.enqueue({ guildId: 'g1', prayer: 'fajr', kind: 'start' });
    await queue.enqueue({ guildId: 'g1', prayer: 'fajr', kind: 'ending' });
    expect(driver.log).toEqual(['connect vc1', 'play fajr_start.ogg', 'disconnect', 'connect vc1', 'play fajr_ending.ogg', 'disconnect']);
  });
});
