import { createReadStream } from 'node:fs';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type VoiceConnectionState,
} from '@discordjs/voice';
import { ChannelType, type Client, type VoiceChannel } from 'discord.js';
import type { ChannelInfo } from './channels.js';
import type { VoiceDriver } from './queue.js';

const CONNECT_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 5_000;
const PLAY_TIMEOUT_MS = 30_000;

export class DiscordVoiceDriver implements VoiceDriver {
  constructor(private readonly client: Client) {}

  listChannels(guildId: string): ChannelInfo[] | null {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild?.available) return null;
    return guild.channels.cache
      .filter((c): c is VoiceChannel => c.type === ChannelType.GuildVoice)
      .map((c) => ({
        id: c.id,
        name: c.name,
        position: c.rawPosition,
        humans: c.members.filter((m) => !m.user.bot).size,
        canSpeak: c.joinable && c.speakable,
      }));
  }

  async connect(guildId: string, channelId: string): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Server is unavailable to the bot');

    const existing = getVoiceConnection(guildId);
    const reusable =
      existing &&
      existing.joinConfig.channelId === channelId &&
      existing.state.status !== VoiceConnectionStatus.Destroyed &&
      existing.state.status !== VoiceConnectionStatus.Disconnected;

    const connection = reusable
      ? existing
      : joinVoiceChannel({
          guildId,
          channelId,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: false,
        });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    } catch {
      connection.destroy();
      throw new Error('Timed out connecting to voice');
    }
  }

  async play(guildId: string, file: string): Promise<void> {
    const connection = getVoiceConnection(guildId);
    if (!connection) throw new Error('Not connected to voice');

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    const subscription = connection.subscribe(player);
    let onConnState: ((o: VoiceConnectionState, n: VoiceConnectionState) => void) | undefined;
    let timer: NodeJS.Timeout | undefined;

    try {
      const finished = new Promise<void>((resolve, reject) => {
        player.once(AudioPlayerStatus.Idle, () => resolve());
        player.once('error', (err) => reject(err));
        onConnState = (_old, next) => {
          if (next.status === VoiceConnectionStatus.Disconnected || next.status === VoiceConnectionStatus.Destroyed) {
            reject(new Error('Disconnected from voice during playback'));
          }
        };
        connection.on('stateChange', onConnState);
        timer = setTimeout(() => reject(new Error('Playback timed out')), PLAY_TIMEOUT_MS);
      });
      // Attach a handler now so an early rejection is not reported as unhandled.
      finished.catch(() => undefined);

      player.play(createAudioResource(createReadStream(file), { inputType: StreamType.OggOpus }));
      await entersState(player, AudioPlayerStatus.Playing, START_TIMEOUT_MS);
      await finished;
    } finally {
      if (timer) clearTimeout(timer);
      if (onConnState) connection.off('stateChange', onConnState);
      subscription?.unsubscribe();
      player.stop(true);
    }
  }

  disconnect(guildId: string): void {
    const connection = getVoiceConnection(guildId);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }
}
