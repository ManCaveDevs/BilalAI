/** Ordered schema migrations. Index i upgrades user_version i to i + 1. Never edit a shipped entry. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE guild_config (
    guild_id                   TEXT PRIMARY KEY,
    latitude                   REAL,
    longitude                  REAL,
    timezone                   TEXT,
    location_label             TEXT,
    method                     INTEGER NOT NULL DEFAULT 3,
    school                     INTEGER NOT NULL DEFAULT 0,
    midnight_mode              INTEGER NOT NULL DEFAULT 0,
    lat_adjust_method          INTEGER NOT NULL DEFAULT 3,
    isha_end                   TEXT    NOT NULL DEFAULT 'midnight',
    warn_minutes               INTEGER NOT NULL DEFAULT 15,
    voice_mode                 TEXT    NOT NULL DEFAULT 'fixed',
    voice_channel_id           TEXT,
    log_channel_id             TEXT,
    paused_until               TEXT
  );

  CREATE TABLE prayer_settings (
    guild_id        TEXT    NOT NULL,
    prayer          TEXT    NOT NULL,
    start_on        INTEGER NOT NULL DEFAULT 1,
    ending_on       INTEGER NOT NULL DEFAULT 1,
    offset_minutes  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, prayer)
  );

  CREATE TABLE prayer_days (
    guild_id       TEXT NOT NULL,
    date           TEXT NOT NULL,
    settings_hash  TEXT NOT NULL,
    timings_json   TEXT NOT NULL,
    fetched_at     TEXT NOT NULL,
    PRIMARY KEY (guild_id, date)
  );

  CREATE TABLE fired_events (
    guild_id   TEXT NOT NULL,
    event_key  TEXT NOT NULL,
    fired_at   TEXT NOT NULL,
    outcome    TEXT NOT NULL,
    detail     TEXT,
    PRIMARY KEY (guild_id, event_key)
  );
  `,
];
