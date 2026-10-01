import type { VoiceMode } from '../db/repo.js';

export interface ChannelInfo {
  id: string;
  name: string;
  position: number;
  /** Non-bot members currently in the channel. */
  humans: number;
  /** The bot can see, join and speak in the channel. */
  canSpeak: boolean;
}

export type Target =
  | { ok: true; channelId: string; humans: number }
  | { ok: false; reason: 'no_channel' | 'empty' | 'no_permission'; detail: string };

export function pickChannel(channels: ChannelInfo[], mode: VoiceMode, configuredId: string | null): Target {
  if (mode === 'fixed') {
    if (!configuredId) return { ok: false, reason: 'no_channel', detail: 'No voice channel configured' };
    const ch = channels.find((c) => c.id === configuredId);
    if (!ch) return { ok: false, reason: 'no_channel', detail: 'Configured voice channel no longer exists' };
    if (!ch.canSpeak) return { ok: false, reason: 'no_permission', detail: `Missing permission to join or speak in #${ch.name}` };
    if (ch.humans === 0) return { ok: false, reason: 'empty', detail: `#${ch.name} is empty` };
    return { ok: true, channelId: ch.id, humans: ch.humans };
  }

  const best = channels
    .filter((c) => c.canSpeak && c.humans > 0)
    .sort(
      (a, b) =>
        b.humans - a.humans ||
        Number(b.id === configuredId) - Number(a.id === configuredId) ||
        a.position - b.position,
    )[0];
  if (!best) return { ok: false, reason: 'empty', detail: 'No occupied voice channel the bot can speak in' };
  return { ok: true, channelId: best.id, humans: best.humans };
}
