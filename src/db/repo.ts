import type { DB } from './index.js';
import { PRAYERS, type DayTimings, type IshaEnd, type Prayer, type PrayerSettings } from '../prayer/types.js';

export type VoiceMode = 'fixed' | 'most_populated';

export type Outcome = 'pending' | 'played' | 'skipped_empty' | 'skipped_paused' | 'skipped_no_channel' | 'error';

export interface GuildConfig {
  guildId: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  locationLabel: string | null;
  method: number;
  school: number;
  midnightMode: number;
  latAdjustMethod: number;
  ishaEnd: IshaEnd;
  warnMinutes: number;
  voiceMode: VoiceMode;
  voiceChannelId: string | null;
  logChannelId: string | null;
  /** ISO timestamp, 'forever', or null. */
  pausedUntil: string | null;
}

/** A guild whose location is set and so can produce prayer times. */
export type LocatedConfig = GuildConfig & { latitude: number; longitude: number; timezone: string };

export function isLocated(cfg: GuildConfig): cfg is LocatedConfig {
  return cfg.latitude !== null && cfg.longitude !== null && cfg.timezone !== null;
}

interface ConfigRow {
  guild_id: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  location_label: string | null;
  method: number;
  school: number;
  midnight_mode: number;
  lat_adjust_method: number;
  isha_end: string;
  warn_minutes: number;
  voice_mode: string;
  voice_channel_id: string | null;
  log_channel_id: string | null;
  paused_until: string | null;
}

const COLUMN: Record<Exclude<keyof GuildConfig, 'guildId'>, keyof ConfigRow> = {
  latitude: 'latitude',
  longitude: 'longitude',
  timezone: 'timezone',
  locationLabel: 'location_label',
  method: 'method',
  school: 'school',
  midnightMode: 'midnight_mode',
  latAdjustMethod: 'lat_adjust_method',
  ishaEnd: 'isha_end',
  warnMinutes: 'warn_minutes',
  voiceMode: 'voice_mode',
  voiceChannelId: 'voice_channel_id',
  logChannelId: 'log_channel_id',
  pausedUntil: 'paused_until',
};

function rowToConfig(r: ConfigRow): GuildConfig {
  return {
    guildId: r.guild_id,
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone,
    locationLabel: r.location_label,
    method: r.method,
    school: r.school,
    midnightMode: r.midnight_mode,
    latAdjustMethod: r.lat_adjust_method,
    ishaEnd: r.isha_end as IshaEnd,
    warnMinutes: r.warn_minutes,
    voiceMode: r.voice_mode as VoiceMode,
    voiceChannelId: r.voice_channel_id,
    logChannelId: r.log_channel_id,
    pausedUntil: r.paused_until,
  };
}

export class Repo {
  constructor(private readonly db: DB) {}

  // ---- guild config ----

  ensureGuild(guildId: string): GuildConfig {
    this.db.prepare('INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)').run(guildId);
    return this.getGuild(guildId)!;
  }

  getGuild(guildId: string): GuildConfig | undefined {
    const row = this.db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId) as ConfigRow | undefined;
    return row ? rowToConfig(row) : undefined;
  }

  locatedGuilds(): LocatedConfig[] {
    const rows = this.db
      .prepare('SELECT * FROM guild_config WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND timezone IS NOT NULL')
      .all() as ConfigRow[];
    return rows.map(rowToConfig).filter(isLocated);
  }

  updateGuild(guildId: string, patch: Partial<Omit<GuildConfig, 'guildId'>>): GuildConfig {
    this.ensureGuild(guildId);
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof typeof COLUMN, unknown][];
    if (entries.length) {
      const sets = entries.map(([k]) => `${COLUMN[k]} = ?`).join(', ');
      this.db.prepare(`UPDATE guild_config SET ${sets} WHERE guild_id = ?`).run(...entries.map(([, v]) => v), guildId);
    }
    return this.getGuild(guildId)!;
  }

  // ---- per-prayer settings ----

  getPrayerSettings(guildId: string): Record<Prayer, PrayerSettings> {
    const rows = this.db
      .prepare('SELECT prayer, start_on, ending_on, offset_minutes FROM prayer_settings WHERE guild_id = ?')
      .all(guildId) as { prayer: Prayer; start_on: number; ending_on: number; offset_minutes: number }[];
    const result = Object.fromEntries(
      PRAYERS.map((p) => [p, { startOn: true, endingOn: true, offsetMinutes: 0 }]),
    ) as Record<Prayer, PrayerSettings>;
    for (const r of rows) {
      if (r.prayer in result) {
        result[r.prayer] = { startOn: !!r.start_on, endingOn: !!r.ending_on, offsetMinutes: r.offset_minutes };
      }
    }
    return result;
  }

  updatePrayerSettings(guildId: string, prayer: Prayer, patch: Partial<PrayerSettings>): PrayerSettings {
    const current = this.getPrayerSettings(guildId)[prayer];
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    this.db
      .prepare(
        `INSERT INTO prayer_settings (guild_id, prayer, start_on, ending_on, offset_minutes) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, prayer) DO UPDATE SET
           start_on = excluded.start_on, ending_on = excluded.ending_on, offset_minutes = excluded.offset_minutes`,
      )
      .run(guildId, prayer, next.startOn ? 1 : 0, next.endingOn ? 1 : 0, next.offsetMinutes);
    return next;
  }

  // ---- cached prayer days ----

  getDay(guildId: string, date: string, settingsHash: string): DayTimings | undefined {
    const row = this.db
      .prepare('SELECT timings_json FROM prayer_days WHERE guild_id = ? AND date = ? AND settings_hash = ?')
      .get(guildId, date, settingsHash) as { timings_json: string } | undefined;
    return row ? (JSON.parse(row.timings_json) as DayTimings) : undefined;
  }

  saveDays(guildId: string, settingsHash: string, days: DayTimings[], fetchedAt: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO prayer_days (guild_id, date, settings_hash, timings_json, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, date) DO UPDATE SET
         settings_hash = excluded.settings_hash, timings_json = excluded.timings_json, fetched_at = excluded.fetched_at`,
    );
    this.db.transaction(() => {
      for (const d of days) stmt.run(guildId, d.date, settingsHash, JSON.stringify(d), fetchedAt);
    })();
  }

  clearDays(guildId: string): void {
    this.db.prepare('DELETE FROM prayer_days WHERE guild_id = ?').run(guildId);
  }

  // ---- fired events (dedupe + history) ----

  /** Atomically claims an event. Returns false if it was already claimed. */
  claimEvent(guildId: string, eventKey: string, firedAt: string): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO fired_events (guild_id, event_key, fired_at, outcome) VALUES (?, ?, ?, 'pending')")
      .run(guildId, eventKey, firedAt);
    return info.changes === 1;
  }

  setOutcome(guildId: string, eventKey: string, outcome: Outcome, detail?: string): void {
    this.db
      .prepare('UPDATE fired_events SET outcome = ?, detail = ? WHERE guild_id = ? AND event_key = ?')
      .run(outcome, detail ?? null, guildId, eventKey);
  }

  outcomesForDate(guildId: string, date: string): Map<string, Outcome> {
    const rows = this.db
      .prepare('SELECT event_key, outcome FROM fired_events WHERE guild_id = ? AND event_key LIKE ?')
      .all(guildId, `${date}:%`) as { event_key: string; outcome: Outcome }[];
    return new Map(rows.map((r) => [r.event_key, r.outcome]));
  }

  /** Deletes history and cached days older than the cutoff date (YYYY-MM-DD). */
  prune(beforeDate: string): void {
    this.db.prepare('DELETE FROM prayer_days WHERE date < ?').run(beforeDate);
    this.db.prepare('DELETE FROM fired_events WHERE substr(event_key, 1, 10) < ?').run(beforeDate);
  }
}
