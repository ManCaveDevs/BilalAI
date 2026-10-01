import type { Outcome, Repo } from '../db/repo.js';
import type { EventKind, Prayer } from '../prayer/types.js';
import type { Logger } from '../util/logger.js';
import { pickChannel, type ChannelInfo } from './channels.js';
import { clipPath } from './clips.js';

/** The Discord-facing side of voice, kept behind an interface so the queue can be tested. */
export interface VoiceDriver {
  /** null when the guild is not available to the bot. */
  listChannels(guildId: string): ChannelInfo[] | null;
  connect(guildId: string, channelId: string): Promise<void>;
  play(guildId: string, file: string): Promise<void>;
  disconnect(guildId: string): void;
}

export interface AnnounceJob {
  guildId: string;
  prayer: Prayer;
  kind: EventKind;
  /** Set for scheduled events so the outcome is recorded; omitted for /test. */
  eventKey?: string;
}

export interface AnnounceResult {
  outcome: Exclude<Outcome, 'pending' | 'skipped_paused'>;
  detail?: string;
  channelId?: string;
}

export type AnnounceListener = (job: AnnounceJob, result: AnnounceResult) => void;

interface Pending {
  job: AnnounceJob;
  resolve: (r: AnnounceResult) => void;
}

/**
 * One FIFO per guild. Items play one after another over a single connection,
 * and the bot leaves as soon as the guild's queue is empty.
 */
export class AnnouncementQueue {
  private readonly queues = new Map<string, Pending[]>();
  private readonly draining = new Map<string, Promise<void>>();

  constructor(
    private readonly driver: VoiceDriver,
    private readonly repo: Repo,
    private readonly audioDir: string,
    private readonly log: Logger,
    private readonly listener?: AnnounceListener,
  ) {}

  enqueue(job: AnnounceJob): Promise<AnnounceResult> {
    return new Promise((resolve) => {
      const q = this.queues.get(job.guildId) ?? [];
      q.push({ job, resolve });
      this.queues.set(job.guildId, q);
      if (!this.draining.has(job.guildId)) this.draining.set(job.guildId, this.drain(job.guildId));
    });
  }

  /** Resolves once every guild's queue is empty. Used for graceful shutdown. */
  async idle(): Promise<void> {
    while (this.draining.size) await Promise.all(this.draining.values());
  }

  private async drain(guildId: string): Promise<void> {
    const q = this.queues.get(guildId)!;
    try {
      let item: Pending | undefined;
      while ((item = q.shift())) {
        const result = await this.run(item.job);
        if (item.job.eventKey) this.repo.setOutcome(guildId, item.job.eventKey, result.outcome, result.detail);
        this.log.info({ ...item.job, ...result }, 'announcement finished');
        item.resolve(result);
        try {
          this.listener?.(item.job, result);
        } catch (err) {
          this.log.warn({ err }, 'announce listener failed');
        }
      }
    } finally {
      // Cleared synchronously with the end of the loop, so a job enqueued from
      // here on always starts a fresh drain instead of joining a finished one.
      this.queues.delete(guildId);
      this.draining.delete(guildId);
      this.driver.disconnect(guildId);
    }
  }

  private async run(job: AnnounceJob): Promise<AnnounceResult> {
    const cfg = this.repo.getGuild(job.guildId);
    if (!cfg) return { outcome: 'skipped_no_channel', detail: 'Server is not configured' };
    const channels = this.driver.listChannels(job.guildId);
    if (!channels) return { outcome: 'error', detail: 'Server is unavailable to the bot' };

    const target = pickChannel(channels, cfg.voiceMode, cfg.voiceChannelId);
    if (!target.ok) {
      const outcome = target.reason === 'empty' ? 'skipped_empty' : target.reason === 'no_channel' ? 'skipped_no_channel' : 'error';
      return { outcome, detail: target.detail };
    }

    try {
      await this.driver.connect(job.guildId, target.channelId);
      await this.driver.play(job.guildId, clipPath(this.audioDir, job.prayer, job.kind));
      return { outcome: 'played', channelId: target.channelId };
    } catch (err) {
      // Drop the connection so the next item starts clean.
      this.driver.disconnect(job.guildId);
      return { outcome: 'error', detail: (err as Error).message ?? String(err), channelId: target.channelId };
    }
  }
}
