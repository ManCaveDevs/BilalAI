import { DateTime } from 'luxon';
import type { Repo, LocatedConfig } from '../db/repo.js';
import type { AladhanClient } from './aladhan.js';
import type { DayLookup } from './windows.js';
import type { Logger } from '../util/logger.js';

/** How many days ahead to keep cached, so an Aladhan outage near month end is harmless. */
export const LOOKAHEAD_DAYS = 7;
const FAILURE_BACKOFF_MS = 10 * 60_000;

/** Identifies the inputs that produced a cached day. Changing any of them invalidates the cache. */
export function settingsHash(cfg: LocatedConfig): string {
  return [
    cfg.latitude.toFixed(4),
    cfg.longitude.toFixed(4),
    cfg.method,
    cfg.school,
    cfg.midnightMode,
    cfg.latAdjustMethod,
  ].join('|');
}

export class TimingsService {
  private readonly nextAttemptAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly repo: Repo,
    private readonly aladhan: Pick<AladhanClient, 'getMonth'>,
    private readonly log: Logger,
  ) {}

  lookup(cfg: LocatedConfig): DayLookup {
    const hash = settingsHash(cfg);
    return (date) => this.repo.getDay(cfg.guildId, date, hash);
  }

  /**
   * Makes sure yesterday through LOOKAHEAD_DAYS ahead are cached, fetching whole
   * months from Aladhan as needed. After a failure it waits 10 minutes before
   * trying again unless `force` is set.
   */
  async ensure(cfg: LocatedConfig, now: DateTime, force = false): Promise<void> {
    const existing = this.inFlight.get(cfg.guildId);
    if (existing) return existing;
    const p = this.doEnsure(cfg, now, force).finally(() => this.inFlight.delete(cfg.guildId));
    this.inFlight.set(cfg.guildId, p);
    return p;
  }

  private async doEnsure(cfg: LocatedConfig, now: DateTime, force: boolean): Promise<void> {
    const lookup = this.lookup(cfg);
    const today = now.setZone(cfg.timezone).startOf('day');
    const missing: DateTime[] = [];
    for (let i = -1; i <= LOOKAHEAD_DAYS; i++) {
      const d = today.plus({ days: i });
      if (!lookup(d.toISODate()!)) missing.push(d);
    }
    if (missing.length === 0) return;

    const wait = this.nextAttemptAt.get(cfg.guildId);
    if (!force && wait !== undefined && now.toMillis() < wait) return;

    const months = [...new Set(missing.map((d) => `${d.year}-${d.month}`))].map((s) => s.split('-').map(Number));
    const hash = settingsHash(cfg);
    try {
      for (const [year, month] of months) {
        const result = await this.aladhan.getMonth(
          {
            latitude: cfg.latitude,
            longitude: cfg.longitude,
            method: cfg.method,
            school: cfg.school,
            midnightMode: cfg.midnightMode,
            latitudeAdjustmentMethod: cfg.latAdjustMethod,
          },
          year!,
          month!,
        );
        this.repo.saveDays(cfg.guildId, hash, result.days, DateTime.utc().toISO()!);
        this.log.info({ guildId: cfg.guildId, year, month, days: result.days.length }, 'cached prayer times');
      }
      this.nextAttemptAt.delete(cfg.guildId);
    } catch (err) {
      this.nextAttemptAt.set(cfg.guildId, now.toMillis() + FAILURE_BACKOFF_MS);
      throw err;
    }
  }
}
