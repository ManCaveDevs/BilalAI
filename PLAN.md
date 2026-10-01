# BilalAI: Implementation Plan

> **Status:** implemented. See `README.md` for setup and usage. Changes from this plan:
> - Added `/config adjust` to shift individual prayer times to match a local mosque timetable.
> - Dropped the per-guild `volume` setting. Adjusting volume would mean decoding and re-encoding every clip; set the level in the clip files instead.
> - Ending clips use the "ending soon" wording (no number), as recommended in section 7.
> - Default calculation method is Muslim World League (3).

A Discord bot that announces the five daily prayers in voice. When a prayer time starts, it joins a voice channel (only if people are in it), plays a short clip such as "Dhuhr has started," and leaves. A configurable number of minutes before that prayer's window closes, it does the same with an "ending soon" warning. Prayer times are pulled from the Aladhan API for a configured location. Slash commands let admins view the schedule, pause the bot, and toggle individual prayers.

---

## 1. Goal and definition of done

The bot is done when all of these hold:

1. For every enabled prayer, a **start** announcement plays within 15 seconds of the Aladhan start time, in the configured voice channel, and only if at least one non-bot member is in that channel.
2. For every enabled prayer, an **ending soon** announcement plays N minutes before the window closes (N configurable per server, default 15).
3. The bot leaves voice right after each clip, and never sits in a channel idle.
4. Times are correct across midnight, DST changes and month boundaries for the configured location and timezone.
5. `/schedule`, `/pause`, `/resume`, `/prayer toggle`, `/config ...` and `/test` work and persist across restarts.
6. A restart, crash or Aladhan outage never causes a duplicate announcement, and never causes more than one missed announcement.
7. It runs unattended in Docker on a small VPS.

---

## 2. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript on Node.js 22 LTS | Strong typing for time logic, first-class Discord voice library |
| Discord | `discord.js` v14 + `@discordjs/voice` | Mature slash command and voice support |
| Voice encryption | `@discordjs/voice` with DAVE support (`@snazzah/davey`), `sodium-native` or `libsodium-wrappers` | Discord now requires the DAVE end-to-end encryption protocol for voice. **Verify in Phase 0 that the pinned version connects and plays audio.** |
| Audio | Pre-encoded Ogg/Opus clips, played as `StreamType.OggOpus` | No transcoding at runtime, so FFmpeg is not needed |
| Time handling | `luxon` | IANA timezone math, DST-safe |
| Storage | SQLite via `better-sqlite3` | Single file, zero ops, synchronous and simple |
| HTTP | Built-in `fetch` | No extra dependency |
| Tests | `vitest` | Fast, TS-native, fake timers |
| Logging | `pino` | Structured logs |
| Deploy | Docker + `docker compose`, `restart: unless-stopped` | One command deploy |

---

## 3. Prayer windows

Aladhan returns these fields (among others): `Fajr`, `Sunrise`, `Dhuhr`, `Asr`, `Maghrib`, `Isha`, `Midnight`. Each prayer's window is defined as:

| Prayer | Starts | Window closes |
|---|---|---|
| Fajr | `Fajr` | `Sunrise` |
| Dhuhr | `Dhuhr` | `Asr` |
| Asr | `Asr` | `Maghrib` |
| Maghrib | `Maghrib` | `Isha` |
| Isha | `Isha` | `Midnight` (Islamic midnight) by default, or next day's `Fajr` (configurable `isha_end` = `midnight` or `fajr`) |

Rules:

- **Ending soon time** = window close minus `warn_minutes`.
- If the window is shorter than `warn_minutes + 5`, skip the ending-soon event for that prayer that day (it would fire almost on top of the start) and log it.
- **Isha crosses midnight.** Its close time comes from the next day's data when `isha_end = fajr`, and `Midnight` itself can fall after 00:00. Always work with full timestamps, never "HH:mm" strings.
- Request Aladhan with `iso8601=true` so every time comes back as a full ISO timestamp with offset. This removes all string parsing of values like `"05:12 (BST)"`.

---

## 4. Aladhan integration

Endpoint (monthly, to reduce calls and survive outages):

```
GET https://api.aladhan.com/v1/calendar/{year}/{month}
    ?latitude={lat}&longitude={lng}
    &method={method}            # e.g. 2 = ISNA, 3 = MWL, 4 = Umm al-Qura, 15 = Moonsighting Committee
    &school={0|1}               # 0 = Shafi/standard Asr, 1 = Hanafi Asr
    &midnightMode={0|1}         # 0 = standard (sunset to sunrise), 1 = Jafari (sunset to fajr)
    &latitudeAdjustmentMethod={1|2|3}  # for high latitudes
    &iso8601=true
```

Also support city lookup for convenience (`/v1/calendarByCity?city=&country=`), but store the resolved lat/lng and timezone (`data[].meta.timezone`) so later fetches are deterministic.

Behavior:

- Fetch the current month and the next month (needed near month end for Isha and "tomorrow" in `/schedule`).
- Cache each day's timings in the `prayer_days` table keyed by `(guild_id, date)`, along with a hash of the location/method settings that produced it. If settings change, invalidate and refetch.
- Refresh daily at 00:10 local time, and on startup if today or tomorrow is missing.
- On failure: retry with exponential backoff (1s, 4s, 16s, 60s, then every 10 minutes). Because a whole month is cached, an outage of days is harmless.
- Timeout each request at 10 seconds. Validate the response shape before writing to the DB.

---

## 5. Data model (SQLite)

```sql
CREATE TABLE guild_config (
  guild_id            TEXT PRIMARY KEY,
  latitude            REAL,
  longitude           REAL,
  timezone            TEXT,            -- IANA, from Aladhan meta
  location_label      TEXT,            -- e.g. "London, UK" for display
  method              INTEGER NOT NULL DEFAULT 2,
  school              INTEGER NOT NULL DEFAULT 0,
  midnight_mode       INTEGER NOT NULL DEFAULT 0,
  lat_adjust_method   INTEGER NOT NULL DEFAULT 3,
  isha_end            TEXT NOT NULL DEFAULT 'midnight',  -- 'midnight' | 'fajr'
  warn_minutes        INTEGER NOT NULL DEFAULT 15,
  voice_mode          TEXT NOT NULL DEFAULT 'fixed',     -- 'fixed' | 'most_populated'
  voice_channel_id    TEXT,
  log_channel_id      TEXT,            -- optional text channel for "announced X" / errors
  paused_until        TEXT,            -- ISO timestamp, or 'forever', or NULL
  volume              REAL NOT NULL DEFAULT 1.0
);

CREATE TABLE prayer_toggle (
  guild_id   TEXT NOT NULL,
  prayer     TEXT NOT NULL,            -- fajr|dhuhr|asr|maghrib|isha
  start_on   INTEGER NOT NULL DEFAULT 1,
  ending_on  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guild_id, prayer)
);

CREATE TABLE prayer_days (
  guild_id      TEXT NOT NULL,
  date          TEXT NOT NULL,         -- YYYY-MM-DD in guild timezone
  settings_hash TEXT NOT NULL,
  timings_json  TEXT NOT NULL,         -- raw ISO timestamps from Aladhan
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (guild_id, date)
);

CREATE TABLE fired_events (
  guild_id  TEXT NOT NULL,
  event_key TEXT NOT NULL,             -- e.g. "2026-10-01:isha:ending"
  fired_at  TEXT NOT NULL,
  outcome   TEXT NOT NULL,             -- played|skipped_empty|skipped_paused|error
  PRIMARY KEY (guild_id, event_key)
);
```

Migrations: a simple numbered `migrations/*.sql` runner using `PRAGMA user_version`. Prune `fired_events` and `prayer_days` older than 60 days nightly.

---

## 6. Scheduler design

Use a **tick loop with a dedupe table**, not long `setTimeout` chains. It is robust to clock drift, sleep, restarts and config changes.

```
every 10 seconds:
  for each configured guild:
    events = buildEvents(guild, today, yesterday)   // pure function, cached per tick
    for each event where now >= event.at and now - event.at <= GRACE (2 min):
      if fired_events has (guild, event.key): continue
      insert fired_events row FIRST (claim it), outcome = 'pending'
      enqueue announcement(guild, event)
```

- `buildEvents` is a **pure function** of (config, toggles, timings for yesterday/today/tomorrow) returning `{ key, prayer, kind: 'start'|'ending', at: DateTime }[]`. Including yesterday handles an Isha window that closes after 00:00. This function is where most unit tests go.
- **Grace window** of 2 minutes: if the bot was down when an event was due and comes back within 2 minutes, it still announces; later than that it skips (a "Fajr has started" an hour late is worse than nothing). This satisfies "never more than one missed announcement" for short restarts.
- Claiming the event in the DB before playing guarantees no duplicates even if the process crashes mid-play.
- **Pause** is checked at fire time: if `paused_until` is in the future, record `skipped_paused`.
- **Toggles** are applied in `buildEvents`, so `/schedule` shows the exact same thing the scheduler will do.

### Announcement queue (per guild)

Events can collide (for example a short Maghrib window where Maghrib "ending" and Isha "start" are a minute apart). Each guild has a FIFO queue processed one item at a time:

1. Resolve the target channel:
   - `fixed`: the configured `voice_channel_id`.
   - `most_populated`: the voice channel with the most non-bot members the bot can `Connect` + `Speak` in (ties broken by configured channel, then position).
2. Count non-bot members in that channel from the voice state cache. If zero, record `skipped_empty` and stop.
3. If the bot is already connected in this guild (previous item still finishing), reuse the connection.
4. `joinVoiceChannel` with `selfDeaf: true`, wait for `VoiceConnectionStatus.Ready` (timeout 15s).
5. Create an audio player, play the clip, wait for `AudioPlayerStatus.Idle` (timeout 30s).
6. If the queue is empty, `connection.destroy()`. Otherwise keep it for the next item.
7. Record `played` or `error` (with message) and, if `log_channel_id` is set, post a one-line note.

Any failure in steps 4 to 6 must still destroy the connection in a `finally` block.

---

## 7. Audio clips

Ten clips, one per prayer per kind:

```
assets/audio/fajr_start.ogg      assets/audio/fajr_ending.ogg
assets/audio/dhuhr_start.ogg     assets/audio/dhuhr_ending.ogg
assets/audio/asr_start.ogg       assets/audio/asr_ending.ogg
assets/audio/maghrib_start.ogg   assets/audio/maghrib_ending.ogg
assets/audio/isha_start.ogg      assets/audio/isha_ending.ogg
```

- Script: "Dhuhr has started." / "Dhuhr ends in fifteen minutes." Note that the ending clip says a fixed number. Two options:
  1. Wording that does not mention a number: "Dhuhr time is ending soon." **(Recommended, works for any `warn_minutes`.)**
  2. Generate clips per minute value at config time with a TTS engine. More moving parts; defer.
- Source: record a human voice, or generate once with any TTS tool, then commit the files. Optionally prefix with a short soft chime (under 1s).
- Encode: `ffmpeg -i in.wav -c:a libopus -b:a 64k -ar 48000 -ac 2 out.ogg`. Keep each clip under 5 seconds.
- A `scripts/check-audio.ts` test asserts all ten files exist and are valid Ogg/Opus at startup, so a missing clip fails loudly at boot rather than at Fajr.
- Optional later: per-guild custom clips uploaded via a command.

---

## 8. Slash commands

All config and control commands default to `ManageGuild` permission via `setDefaultMemberPermissions`, so server admins can adjust access in Server Settings > Integrations. `/schedule` and `/next` are available to everyone.

| Command | Options | Behavior |
|---|---|---|
| `/schedule` | `day`: today (default) / tomorrow | Embed with each prayer: start time, window close, ending-soon time, on/off status for start and ending, and which events already fired today. Times shown as Discord timestamps (`<t:unix:t>`) so each viewer sees their own local time, plus the server location's local time. |
| `/next` | none | Next upcoming event and a relative timestamp (`<t:unix:R>`). |
| `/pause` | `duration` (optional): 1h, 3h, until tomorrow, indefinitely | Sets `paused_until`. Replies with when it resumes. |
| `/resume` | none | Clears `paused_until`. |
| `/prayer toggle` | `prayer` (choice of 5), `which`: start / ending / both, `enabled`: true/false | Updates `prayer_toggle`. |
| `/prayer list` | none | Shows the toggle matrix. |
| `/config location` | `city` + `country`, or `latitude` + `longitude` | Resolves via Aladhan, stores lat/lng/timezone, refetches the calendar, replies with today's schedule to confirm. |
| `/config channel` | `channel` (voice channel) or `mode: most_populated` | Validates the bot has View, Connect and Speak in it. |
| `/config warning` | `minutes` (1 to 60) | Sets `warn_minutes`. |
| `/config method` | `method` (choice list of Aladhan methods), `school` (Standard/Hanafi), `isha_end` (midnight/fajr) | Refetches calendar. |
| `/config logchannel` | `channel` (text, optional) | Where to post announce/error notes. |
| `/config show` | none | Displays all current settings. |
| `/test` | `prayer`, `kind` | Plays the clip now through the full pipeline (empty-channel check included). Does not touch `fired_events`. |

Commands are registered with a `scripts/deploy-commands.ts` script: guild-scoped during development (instant), global in production.

---

## 9. Discord setup

- **Intents:** `Guilds`, `GuildVoiceStates`. No privileged intents needed (voice state cache gives channel membership; `member.user.bot` is available from voice states).
- **Invite scopes:** `bot`, `applications.commands`.
- **Bot permissions:** View Channels, Connect, Speak, Send Messages (only for the log channel), Embed Links. Permission integer computed in the README.
- On `guildCreate`, create a default `guild_config` row and DM nothing; the first `/schedule` call explains how to run `/config location` if it is unset.

---

## 10. Project layout

```
BilalAI/
  src/
    index.ts                 # boot: env, DB, client login, start scheduler
    config/env.ts            # DISCORD_TOKEN, CLIENT_ID, DEV_GUILD_ID, DB_PATH, LOG_LEVEL (validated with zod)
    db/
      index.ts               # better-sqlite3 connection + migration runner
      migrations/001_init.sql
      repo.ts                # typed queries for config, toggles, days, fired events
    prayer/
      aladhan.ts             # API client, response validation, retries
      timings.ts             # fetch + cache orchestration, settings hash
      windows.ts             # pure: timings -> windows -> events (buildEvents)
      types.ts
    scheduler/
      tick.ts                # 10s loop, dedupe, grace window
      queue.ts               # per-guild FIFO
    voice/
      announcer.ts           # resolve channel, member check, join, play, leave
      clips.ts               # clip path lookup + startup validation
    commands/
      index.ts               # registry + interaction router
      schedule.ts  next.ts  pause.ts  resume.ts  prayer.ts  config.ts  test.ts
    util/
      format.ts              # embeds, Discord timestamps
      logger.ts
  assets/audio/*.ogg
  scripts/
    deploy-commands.ts
    check-audio.ts
  test/
    fixtures/aladhan-*.json  # real captured responses (London in BST/GMT switch, Oslo in summer, Mecca)
    windows.test.ts
    tick.test.ts
    aladhan.test.ts
    announcer.test.ts
  Dockerfile
  docker-compose.yml
  .env.example
  package.json  tsconfig.json  vitest.config.ts  eslint.config.js
  README.md
```

---

## 11. Implementation phases

### Phase 0: Voice spike (half a day)
Highest risk first. Minimal script: log in, join a hardcoded voice channel, play one Ogg/Opus file, leave.
- Confirms DAVE encryption works with the pinned `@discordjs/voice` version and native deps build in Docker (Alpine vs Debian slim: prefer `node:22-bookworm-slim` to avoid native build pain).
- Confirms the host allows outbound UDP (voice uses UDP; some hosts block it).
- **Exit:** clip is audible in a real server, from inside the Docker container.

### Phase 1: Skeleton (half a day)
- `package.json`, TS config, ESLint, Prettier, Vitest, pino.
- Env validation, client login, SQLite + migrations, `/config show` and `/schedule` stubs.
- `deploy-commands` script.
- **Exit:** bot comes online, stub commands respond in a dev guild.

### Phase 2: Prayer time engine (1 day)
- `aladhan.ts` with response validation (zod) and retries.
- `timings.ts` caching per month with settings hash.
- `windows.ts` `buildEvents` pure function.
- Capture real fixtures and write unit tests (see section 12).
- **Exit:** `buildEvents` passes all edge case tests; `/schedule` shows real times.

### Phase 3: Config commands (1 day)
- `/config location|channel|warning|method|logchannel|show`, `/prayer toggle|list`, `/pause`, `/resume`, `/next`.
- Permission defaults, input validation, ephemeral error replies.
- **Exit:** all settings persist across restart and are reflected in `/schedule`.

### Phase 4: Scheduler + announcer (1 to 1.5 days)
- Tick loop, dedupe, grace window, per-guild queue.
- Announcer with channel resolution, empty-channel skip, join/play/leave with timeouts and `finally` cleanup.
- `/test` command.
- Daily refresh job and nightly pruning.
- **Exit:** with a fake clock, events fire exactly once; in a real server, `/test` and a real prayer time both announce correctly; empty channel is skipped.

### Phase 5: Audio (half a day, can run in parallel with Phase 2 to 4)
- Produce and encode the ten clips; `check-audio` at boot.

### Phase 6: Hardening + deploy (1 day)
- Dockerfile (multi-stage, non-root user, DB on a mounted volume), compose file, healthcheck (process alive + last tick under 60s ago, exposed via a tiny HTTP endpoint or a heartbeat file).
- Graceful shutdown: on SIGTERM, stop the tick loop, wait for the current clip to finish (max 10s), destroy voice connections, close DB.
- Handle `voiceStateUpdate` where the bot is kicked/moved mid-clip (abort and clean up).
- Log channel notes for errors (e.g. missing permissions, API down for over 24h).
- README: setup, invite link, env vars, choosing a calculation method, how to replace clips.
- **Exit:** runs on the VPS for 3 full days with every announcement verified from logs and `fired_events`.

Total: roughly 5 to 6 focused days.

---

## 12. Testing strategy

**Unit tests (`windows.test.ts`)**, all using captured Aladhan fixtures and Luxon with fixed zones:
- Normal day: 10 events in the right order with correct timestamps.
- `warn_minutes` larger than a short window: ending event skipped.
- Isha with `isha_end = midnight` where Midnight is after 00:00: ending event dated next calendar day, reachable via "yesterday" data.
- Isha with `isha_end = fajr`: uses next day's Fajr, including across a month boundary (Oct 31 to Nov 1).
- DST transition days (e.g. Europe/London last Sunday of October): no event shifts by an hour.
- High latitude summer (Oslo, June): Isha/Fajr still produce sane windows with `latitudeAdjustmentMethod`.
- Toggles off for start, ending, or both.

**Scheduler tests (`tick.test.ts`)** with Vitest fake timers and an in-memory SQLite:
- Event fires once even if the tick runs many times past it.
- Restart within grace window: fires. After grace: skipped.
- Paused: recorded as `skipped_paused`, does not fire after resume.
- Two events one minute apart are queued, single join, both clips play.

**Aladhan client tests:** malformed response rejected, retries on 5xx, timeout honored (mock `fetch`).

**Announcer tests:** mock `@discordjs/voice`; assert skip on empty channel, skip on bots-only channel, `destroy()` always called, including on errors.

**Manual acceptance checklist** in a test server: `/test` for all ten clips, empty-channel skip, `most_populated` mode, pause/resume, toggles, location change mid-day.

CI: GitHub Actions running `lint`, `typecheck`, `test` on every push.

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Discord voice protocol changes (DAVE E2EE) break playback | Phase 0 spike; pin library versions; Renovate/Dependabot for updates; `/test` for quick verification |
| Host blocks UDP | Verify in Phase 0 before committing to a host |
| Aladhan outage or rate limiting | Monthly caching, backoff, settings hash; one call per guild per month in steady state |
| Wrong times due to timezone/DST | ISO timestamps from API, Luxon only, dedicated DST tests |
| Calculation method disagreements in a community | Method, school and Isha end are all configurable; `/schedule` shows exactly what will happen |
| Bot joins a channel during a sensitive moment | Only joins populated channels by design; `/pause` with durations; per-prayer toggles; clips kept short |
| Duplicate announcements after crash | Claim-before-play in `fired_events` |
| Bot stuck in voice | Timeouts on every await, `finally` destroy, `voiceStateUpdate` handling |

---

## 14. Later ideas (out of scope for v1)

- Full adhan audio option instead of a short clip.
- Jumu'ah (Friday) special announcement and Ramadan suhoor/iftar reminders using `Imsak` and `Maghrib`.
- Text channel announcements as a fallback when voice is empty.
- Per-guild custom clips and multiple languages.
- Hijri date in `/schedule` (Aladhan already returns it).
- Web dashboard for config.
