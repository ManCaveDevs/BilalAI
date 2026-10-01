import { DateTime } from 'luxon';
import type { Repo } from '../db/repo.js';
import { isPaused, scheduleOptions } from '../prayer/options.js';
import type { TimingsService } from '../prayer/timings.js';
import { buildEvents, relevantDates } from '../prayer/windows.js';
import type { Logger } from '../util/logger.js';
import type { AnnouncementQueue } from '../voice/queue.js';

export const TICK_MS = 10_000;
/** An event is still announced if the bot notices it up to this long after it was due. */
export const GRACE_MS = 2 * 60_000;
const HISTORY_DAYS = 60;

export interface SchedulerDeps {
  repo: Repo;
  timings: TimingsService;
  queue: Pick<AnnouncementQueue, 'enqueue'>;
  log: Logger;
  now?: () => DateTime;
  onTick?: (now: DateTime) => void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastPrune: string | undefined;
  private readonly now: () => DateTime;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => DateTime.utc());
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { repo, timings, queue, log } = this.deps;
    const now = this.now();
    try {
      for (const cfg of repo.locatedGuilds()) {
        // Refresh in the background so a slow or failing API never delays announcements;
        // events are built from whatever is already cached.
        timings
          .ensure(cfg, now)
          .catch((err) =>
            log.warn({ err, guildId: cfg.guildId }, 'could not refresh prayer times; will retry in 10 minutes'),
          );

        const events = buildEvents(relevantDates(now, cfg.timezone), timings.lookup(cfg), scheduleOptions(cfg, repo));
        for (const event of events) {
          const late = now.toMillis() - event.at.toMillis();
          if (late < 0 || late > GRACE_MS) continue;
          // Claim before acting, so a crash or restart can never announce twice.
          if (!repo.claimEvent(cfg.guildId, event.key, now.toISO()!)) continue;

          if (isPaused(cfg, now)) {
            repo.setOutcome(cfg.guildId, event.key, 'skipped_paused');
            log.info({ guildId: cfg.guildId, key: event.key }, 'skipped (paused)');
            continue;
          }
          log.info({ guildId: cfg.guildId, key: event.key, lateMs: late }, 'announcing');
          queue
            .enqueue({ guildId: cfg.guildId, prayer: event.prayer, kind: event.kind, eventKey: event.key })
            .catch((err) => log.error({ err, key: event.key }, 'announcement crashed'));
        }
      }

      const today = now.toISODate()!;
      if (this.lastPrune !== today) {
        repo.prune(now.minus({ days: HISTORY_DAYS }).toISODate()!);
        this.lastPrune = today;
      }
      this.deps.onTick?.(now);
    } catch (err) {
      log.error({ err }, 'scheduler tick failed');
    } finally {
      this.running = false;
    }
  }
}
