import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { isLocated, type GuildConfig } from '../db/repo.js';
import { METHODS, methodName, type ResolvedLocation } from '../prayer/aladhan.js';
import { PRAYERS, PRAYER_NAMES, type IshaEnd, type Prayer } from '../prayer/types.js';
import { EMBED_COLOR, hhmm, locationText, pauseText } from '../util/format.js';
import type { Command, CommandContext } from './context.js';
import { prayerChoices } from './prayer.js';
import { windowsFor } from './shared.js';

const HIGH_LAT_METHODS = [
  { name: 'Middle of the night', value: 1 },
  { name: 'One seventh of the night', value: 2 },
  { name: 'Angle based (default)', value: 3 },
];

export const config: Command = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure the prayer announcer')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('location')
        .setDescription('Set the location used for prayer times (city + country, or coordinates)')
        .addStringOption((o) => o.setName('city').setDescription('City, e.g. London'))
        .addStringOption((o) => o.setName('country').setDescription('Country, e.g. United Kingdom or GB'))
        .addNumberOption((o) => o.setName('latitude').setDescription('Latitude, e.g. 51.5074').setMinValue(-90).setMaxValue(90))
        .addNumberOption((o) =>
          o.setName('longitude').setDescription('Longitude, e.g. -0.1278').setMinValue(-180).setMaxValue(180),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('channel')
        .setDescription('Choose the voice channel for announcements')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Voice channel to announce in').addChannelTypes(ChannelType.GuildVoice),
        )
        .addBooleanOption((o) =>
          o.setName('auto').setDescription('Instead announce in whichever voice channel has the most people'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('warning')
        .setDescription('How many minutes before a prayer ends to warn')
        .addIntegerOption((o) =>
          o.setName('minutes').setDescription('Minutes (1 to 60)').setRequired(true).setMinValue(1).setMaxValue(60),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('method')
        .setDescription('Calculation method and related options')
        .addIntegerOption((o) =>
          o
            .setName('method')
            .setDescription('Calculation method')
            .addChoices(...METHODS.map((m) => ({ name: m.name, value: m.id }))),
        )
        .addIntegerOption((o) =>
          o
            .setName('asr')
            .setDescription('Asr calculation')
            .addChoices({ name: 'Standard (Shafi, Maliki, Hanbali)', value: 0 }, { name: 'Hanafi', value: 1 }),
        )
        .addStringOption((o) =>
          o
            .setName('isha_end')
            .setDescription('When the Isha window ends')
            .addChoices({ name: 'Islamic midnight', value: 'midnight' }, { name: 'Next Fajr', value: 'fajr' }),
        )
        .addIntegerOption((o) =>
          o.setName('high_latitude').setDescription('Adjustment for high latitudes').addChoices(...HIGH_LAT_METHODS),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('adjust')
        .setDescription("Shift a prayer's start time to match a local mosque timetable")
        .addStringOption((o) =>
          o.setName('prayer').setDescription('Which prayer').setRequired(true).addChoices(...prayerChoices),
        )
        .addIntegerOption((o) =>
          o
            .setName('minutes')
            .setDescription('Minutes to add (negative for earlier, 0 to reset)')
            .setRequired(true)
            .setMinValue(-60)
            .setMaxValue(60),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('logchannel')
        .setDescription('Text channel for short notes about announcements and errors (omit to turn off)')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Text channel')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) => s.setName('show').setDescription('Show the current settings')),

  async execute(interaction, ctx) {
    ctx.repo.ensureGuild(interaction.guildId);
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case 'location':
        return setLocation(interaction, ctx);
      case 'channel':
        return setChannel(interaction, ctx);
      case 'warning': {
        const minutes = interaction.options.getInteger('minutes', true);
        ctx.repo.updateGuild(interaction.guildId, { warnMinutes: minutes });
        await reply(interaction, `Ending soon warnings will play **${minutes} minutes** before each prayer ends.`);
        return;
      }
      case 'method':
        return setMethod(interaction, ctx);
      case 'adjust': {
        const p = interaction.options.getString('prayer', true) as Prayer;
        const minutes = interaction.options.getInteger('minutes', true);
        ctx.repo.updatePrayerSettings(interaction.guildId, p, { offsetMinutes: minutes });
        await reply(
          interaction,
          minutes === 0
            ? `${PRAYER_NAMES[p]} adjustment removed.`
            : `${PRAYER_NAMES[p]} will start **${Math.abs(minutes)} minutes ${minutes > 0 ? 'later' : 'earlier'}** than calculated.`,
        );
        return;
      }
      case 'logchannel': {
        const channel = interaction.options.getChannel('channel');
        ctx.repo.updateGuild(interaction.guildId, { logChannelId: channel?.id ?? null });
        await reply(interaction, channel ? `Notes will be posted in <#${channel.id}>.` : 'Log channel turned off.');
        return;
      }
      case 'show':
        await interaction.reply({ embeds: [settingsEmbed(ctx.repo.getGuild(interaction.guildId)!, ctx)], flags: MessageFlags.Ephemeral });
        return;
    }
  },
};

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (interaction.deferred) await interaction.editReply(content);
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function setLocation(interaction: ChatInputCommandInteraction<'cached'>, ctx: CommandContext): Promise<void> {
  const city = interaction.options.getString('city')?.trim();
  const country = interaction.options.getString('country')?.trim();
  const lat = interaction.options.getNumber('latitude');
  const lng = interaction.options.getNumber('longitude');

  const byCity = !!city && !!country;
  const byCoords = lat !== null && lng !== null;
  if (!byCity && !byCoords) {
    await reply(interaction, 'Give either `city` and `country`, or `latitude` and `longitude`.');
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let resolved: ResolvedLocation;
  try {
    resolved = byCity ? await ctx.aladhan.resolveCity(city, country) : await ctx.aladhan.resolveCoordinates(lat!, lng!);
  } catch (err) {
    await interaction.editReply(`Could not find that location: ${(err as Error).message}`);
    return;
  }

  const label = byCity ? `${city}, ${country}` : `${resolved.latitude.toFixed(4)}, ${resolved.longitude.toFixed(4)}`;
  const cfg = ctx.repo.updateGuild(interaction.guildId, {
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    timezone: resolved.timezone,
    locationLabel: label,
  });
  ctx.repo.clearDays(interaction.guildId);
  await confirmWithToday(interaction, ctx, cfg, `Location set to **${label}** (${resolved.timezone}).`);
}

async function setMethod(interaction: ChatInputCommandInteraction<'cached'>, ctx: CommandContext): Promise<void> {
  const method = interaction.options.getInteger('method') ?? undefined;
  const school = interaction.options.getInteger('asr') ?? undefined;
  const ishaEnd = (interaction.options.getString('isha_end') ?? undefined) as IshaEnd | undefined;
  const latAdjustMethod = interaction.options.getInteger('high_latitude') ?? undefined;
  if ([method, school, ishaEnd, latAdjustMethod].every((v) => v === undefined)) {
    await reply(interaction, 'Pick at least one option to change.');
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const cfg = ctx.repo.updateGuild(interaction.guildId, { method, school, ishaEnd, latAdjustMethod });
  await confirmWithToday(interaction, ctx, cfg, 'Calculation settings updated.');
}

/** Replies with a confirmation plus today's times, so admins can check them against a local timetable. */
async function confirmWithToday(
  interaction: ChatInputCommandInteraction<'cached'>,
  ctx: CommandContext,
  cfg: GuildConfig,
  message: string,
): Promise<void> {
  if (!isLocated(cfg)) {
    await interaction.editReply(`${message}\nSet a location with \`/config location\` to start announcing.`);
    return;
  }
  try {
    const today = ctx.now().setZone(cfg.timezone).toISODate()!;
    const { windows } = await windowsFor(ctx, cfg, today);
    const times = windows.map((w) => `${PRAYER_NAMES[w.prayer]} ${hhmm(w.start)}`).join(' | ');
    await interaction.editReply(`${message}\nToday: ${times}`);
  } catch (err) {
    ctx.log.warn({ err, guildId: cfg.guildId }, 'fetch after config change failed');
    await interaction.editReply(
      `${message}\nPrayer times could not be fetched right now (${(err as Error).message}). The bot will keep retrying.`,
    );
  }
}

async function setChannel(interaction: ChatInputCommandInteraction<'cached'>, ctx: CommandContext): Promise<void> {
  const channel = interaction.options.getChannel('channel', false, [ChannelType.GuildVoice]);
  const auto = interaction.options.getBoolean('auto') ?? false;

  if (!auto && !channel) {
    await reply(interaction, 'Pick a voice `channel`, or set `auto:true` to use the busiest voice channel.');
    return;
  }
  if (channel && !(channel.joinable && channel.speakable)) {
    await reply(interaction, `I need the View Channel, Connect and Speak permissions in <#${channel.id}>.`);
    return;
  }
  ctx.repo.updateGuild(interaction.guildId, {
    voiceMode: auto ? 'most_populated' : 'fixed',
    voiceChannelId: channel?.id ?? null,
  });
  await reply(
    interaction,
    auto
      ? `Announcements will play in whichever voice channel has the most people${channel ? `, preferring <#${channel.id}> on a tie` : ''}.`
      : `Announcements will play in <#${channel!.id}> when someone is in it.`,
  );
}

function settingsEmbed(cfg: GuildConfig, ctx: CommandContext): EmbedBuilder {
  const settings = ctx.repo.getPrayerSettings(cfg.guildId);
  const adjustments = PRAYERS.filter((p) => settings[p].offsetMinutes)
    .map((p) => `${PRAYER_NAMES[p]} ${settings[p].offsetMinutes > 0 ? '+' : ''}${settings[p].offsetMinutes} min`)
    .join(', ');
  const channel =
    cfg.voiceMode === 'most_populated'
      ? 'Busiest voice channel'
      : cfg.voiceChannelId
        ? `<#${cfg.voiceChannelId}>`
        : 'Not set';
  const highLat = HIGH_LAT_METHODS.find((m) => m.value === cfg.latAdjustMethod)?.name ?? String(cfg.latAdjustMethod);

  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Prayer announcer settings')
    .setDescription(pauseText(cfg, ctx.now()) ?? 'Announcements are **active**.')
    .addFields(
      { name: 'Location', value: cfg.latitude === null ? 'Not set' : locationText(cfg) },
      { name: 'Voice channel', value: channel, inline: true },
      { name: 'Log channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Off', inline: true },
      { name: 'Warning', value: `${cfg.warnMinutes} min before end`, inline: true },
      { name: 'Method', value: methodName(cfg.method), inline: true },
      { name: 'Asr', value: cfg.school === 1 ? 'Hanafi' : 'Standard', inline: true },
      { name: 'Isha ends at', value: cfg.ishaEnd === 'fajr' ? 'Next Fajr' : 'Islamic midnight', inline: true },
      { name: 'High latitude rule', value: highLat, inline: true },
      { name: 'Adjustments', value: adjustments || 'None', inline: true },
    );
}
