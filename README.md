# BilalAI

A Discord bot that announces the five daily prayers in voice.

- When a prayer starts, the bot joins your voice channel (only if people are in it), plays a short clip like "Dhuhr has started," and leaves.
- A configurable number of minutes before the prayer's window closes, it does the same with an "ending soon" warning.
- Prayer times come from the free [Aladhan API](https://aladhan.com/prayer-times-api) for your location. The bot caches them a month at a time, so a short API outage doesn't affect it.
- Slash commands let you view the schedule, pause the bot, toggle individual prayers, and change settings.

## Prayer windows

| Prayer | Starts | Window closes |
|---|---|---|
| Fajr | Fajr | Sunrise |
| Dhuhr | Dhuhr | Asr |
| Asr | Asr | Maghrib |
| Maghrib | Maghrib | Isha |
| Isha | Isha | Islamic midnight, or next Fajr (`/config method isha_end`) |

The "ending soon" warning plays `warning` minutes before the close. If a window is too short for the warning to make sense, it is skipped that day.

## Setup

### 1. Create the Discord application

1. Go to https://discord.com/developers/applications and click **New Application**.
2. On the **Bot** tab, click **Reset Token** and copy the token. No privileged intents are needed.
3. Copy the **Application ID** from the **General Information** tab.
4. Invite the bot by opening this URL with your application ID filled in:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=3165184
   ```

   That permission set is View Channels, Send Messages, Embed Links, Connect and Speak.

### 2. Configure

```bash
cp .env.example .env
# then fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
```

Set `DEV_GUILD_ID` to your server's ID while testing, so slash commands show up instantly. Without it, commands are registered globally, which can take up to an hour.

### 3a. Run with Docker (recommended)

```bash
docker compose run --rm bilal node dist/scripts/deploy-commands.js   # register slash commands (once, and after command changes)
docker compose up -d --build
docker compose logs -f
```

The database lives in `./data` on the host.

### 3b. Run with Node directly

Requires Node 22+.

```bash
npm ci
npm run deploy-commands   # register slash commands
npm run build && npm start
# or, while developing:
npm run dev
```

### 4. In Discord

An admin with **Manage Server** runs:

```
/config location city:London country:United Kingdom
/config channel channel:#General
/schedule
/test prayer:Dhuhr
```

You can also check the times before involving Discord at all. This calls the live Aladhan API and prints today's windows exactly as the bot will use them:

```bash
npm run check-times -- London "United Kingdom"
```

Check `/schedule` against your local mosque timetable. If it is off, try a different `/config method`. If it is still a few minutes off, use `/config adjust` to shift individual prayers.

## Commands

Everyone can use `/schedule` and `/next`. All other commands require **Manage Server** by default. You can change who has access in Server Settings > Integrations.

| Command | What it does |
|---|---|
| `/schedule [day]` | Today's (or tomorrow's) times, warning times, which announcements are on, and what already played |
| `/next` | The next announcement and how long until it |
| `/pause [duration]` | Pause for 1h, 3h, 12h, until tomorrow, or until `/resume` |
| `/resume` | Resume announcements |
| `/prayer toggle prayer enabled [which]` | Turn a prayer's start announcement, ending warning, or both on or off |
| `/prayer list` | Show which announcements are on |
| `/config location` | Set `city` + `country`, or `latitude` + `longitude` |
| `/config channel` | Pick a voice `channel`, or `auto:true` to use whichever voice channel has the most people |
| `/config warning minutes` | Minutes before the window closes to warn (1 to 60, default 15) |
| `/config method` | Calculation `method`, `asr` (Standard or Hanafi), `isha_end`, `high_latitude` rule |
| `/config adjust prayer minutes` | Shift a prayer's start by -60 to +60 minutes to match a local timetable |
| `/config logchannel [channel]` | Post a short note in a text channel after each announcement or error |
| `/config show` | Show all settings |
| `/test prayer [kind]` | Play a clip now using the normal channel rules |

## Audio clips

The ten clips live in `assets/audio` as `<prayer>_<start|ending>.ogg`, for example `dhuhr_start.ogg` and `dhuhr_ending.ogg`.

The included clips are generated with espeak-ng (`npm run gen-audio`) and sound robotic. **Replace them with recorded clips for a much nicer result.** Record or generate any audio, then convert each file:

```bash
ffmpeg -i dhuhr_start.wav -af "adelay=400|400" -c:a libopus -b:a 64k -ar 48000 -ac 2 assets/audio/dhuhr_start.ogg
```

The leading 0.4s of silence stops the first word being clipped while voice connects. The ending clips say "ending soon" rather than a number, so they stay correct whatever `/config warning` is set to. The bot checks all ten files at startup and refuses to start if any are missing or aren't Ogg/Opus.

## How it works

- **Times:** Aladhan's monthly calendar endpoint returns separate times for every day. The bot stores each day in SQLite and keeps from yesterday to 7 days ahead cached. If calculation settings change, it fetches again. If a fetch fails, it retries 10 minutes later.
- **Scheduler:** every 10 seconds it works out which events are due. Before playing anything, it records the event in the database, so a crash or restart can never announce the same event twice. If the bot was down when an event was due and comes back within 2 minutes, it still announces it; after that the event is skipped.
- **Voice:** each server has its own queue, so back-to-back events (for example Maghrib ending and Isha starting) play over one connection. The bot leaves as soon as the queue is empty, including after errors. Every voice step has a timeout.
- **Time zones:** all times are full timestamps in the location's time zone, so midnight, month ends and daylight saving changes are handled correctly.

## Hosting

The bot is a single always-on process using very little CPU and memory. Any small VPS (about $4 to $6 a month), the Oracle Cloud free tier, or a Raspberry Pi at home will run it. The host must allow outbound UDP, which Discord voice needs. Serverless platforms and free tiers that sleep won't work.

## Development

```bash
npm test          # unit tests (fast)
npm run test:e2e  # end-to-end run (about 80 seconds)
npm run lint
npm run typecheck
```

The end-to-end test (`test/e2e`) runs the whole bot with only Discord's network replaced. It uses a real HTTP server standing in for Aladhan, a real SQLite file, the real scheduler over two simulated days (including the October clock change, a restart, an Aladhan outage, an empty channel, a toggle and a pause), the real command handlers, and plays every announcement through `@discordjs/voice`'s real audio player using the shipped clips.

The unit tests cover the prayer window maths (including DST, month boundaries and high latitudes), the Aladhan client, caching, the scheduler (dedupe, grace window, pause), the voice queue, channel selection, clip validation and the command handlers.

## Troubleshooting

- **Bot never speaks:** run `/test`. If the reply says the channel is empty, someone needs to be in it. If it says a permission is missing, give the bot Connect and Speak in that channel.
- **"Timed out connecting to voice":** the host is probably blocking outbound UDP.
- **Times look wrong:** check `/config show`. The location and time zone come from Aladhan, so try coordinates if a city name resolves to the wrong place.
- **More logs:** set `LOG_LEVEL=debug` in `.env`.
