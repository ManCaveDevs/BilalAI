import fs from 'node:fs';
import path from 'node:path';
import { Client, Events, GatewayIntentBits, type SendableChannels } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { DateTime } from 'luxon';
import { handleInteraction } from './commands/index.js';
import type { CommandContext } from './commands/context.js';
import { loadEnv } from './config/env.js';
import { openDatabase } from './db/index.js';
import { Repo } from './db/repo.js';
import { AladhanClient } from './prayer/aladhan.js';
import { TimingsService } from './prayer/timings.js';
import { PRAYER_NAMES } from './prayer/types.js';
import { Scheduler } from './scheduler/scheduler.js';
import { logger } from './util/logger.js';
import { validateClips } from './voice/clips.js';
import { DiscordVoiceDriver } from './voice/discordDriver.js';
import { AnnouncementQueue, type AnnounceListener } from './voice/queue.js';

async function main(): Promise<void> {
  const env = loadEnv();
  logger.level = env.LOG_LEVEL;

  const clipProblems = validateClips(env.AUDIO_DIR);
  if (clipProblems.length) {
    throw new Error(`Audio clips are missing or invalid (run \`npm run gen-audio\`):\n  ${clipProblems.join('\n  ')}`);
  }
  logger.debug(generateDependencyReport());

  const db = openDatabase(env.DB_PATH);
  const repo = new Repo(db);
  const aladhan = new AladhanClient();
  const timings = new TimingsService(repo, aladhan, logger);

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

  const postToLogChannel: AnnounceListener = (job, result) => {
    if (!job.eventKey || (result.outcome !== 'played' && result.outcome !== 'error')) return;
    const cfg = repo.getGuild(job.guildId);
    if (!cfg?.logChannelId) return;
    const channel = client.channels.cache.get(cfg.logChannelId);
    if (!channel?.isSendable()) return;
    const what = `${PRAYER_NAMES[job.prayer]} ${job.kind === 'start' ? 'start' : 'ending soon'}`;
    const text =
      result.outcome === 'played'
        ? `Announced ${what} in <#${result.channelId}>.`
        : `Could not announce ${what}: ${result.detail}`;
    (channel as SendableChannels).send({ content: text, allowedMentions: { parse: [] } }).catch((err) => {
      logger.warn({ err, guildId: job.guildId }, 'could not post to log channel');
    });
  };

  const queue = new AnnouncementQueue(new DiscordVoiceDriver(client), repo, env.AUDIO_DIR, logger, postToLogChannel);

  fs.mkdirSync(path.dirname(path.resolve(env.HEALTH_FILE)), { recursive: true });
  const scheduler = new Scheduler({
    repo,
    timings,
    queue,
    log: logger,
    onTick: () => fs.writeFileSync(env.HEALTH_FILE, String(Date.now())),
  });

  const ctx: CommandContext = { repo, timings, aladhan, queue, now: () => DateTime.utc(), log: logger };

  client.once(Events.ClientReady, (c) => {
    logger.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'logged in');
    for (const guild of c.guilds.cache.values()) repo.ensureGuild(guild.id);
    scheduler.start();
  });
  client.on(Events.GuildCreate, (guild) => {
    repo.ensureGuild(guild.id);
    logger.info({ guildId: guild.id, name: guild.name }, 'joined server');
  });
  client.on(Events.InteractionCreate, (interaction) => void handleInteraction(interaction, ctx));
  client.on(Events.Error, (err) => logger.error({ err }, 'discord client error'));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    // Let a clip that is playing finish, but do not hang forever.
    await Promise.race([queue.idle(), new Promise((r) => setTimeout(r, 10_000))]);
    await client.destroy();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
