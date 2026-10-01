import { describe, expect, it } from 'vitest';
import { pickChannel, type ChannelInfo } from '../src/voice/channels.js';

const ch = (id: string, humans: number, canSpeak = true, position = 0): ChannelInfo => ({ id, name: id, position, humans, canSpeak });

describe('pickChannel', () => {
  it('fixed: uses the configured channel when occupied', () => {
    expect(pickChannel([ch('a', 1), ch('b', 5)], 'fixed', 'a')).toEqual({ ok: true, channelId: 'a', humans: 1 });
  });

  it('fixed: skips when empty, missing, unset or not permitted', () => {
    expect(pickChannel([ch('a', 0)], 'fixed', 'a')).toMatchObject({ ok: false, reason: 'empty' });
    expect(pickChannel([ch('a', 3)], 'fixed', 'gone')).toMatchObject({ ok: false, reason: 'no_channel' });
    expect(pickChannel([ch('a', 3)], 'fixed', null)).toMatchObject({ ok: false, reason: 'no_channel' });
    expect(pickChannel([ch('a', 3, false)], 'fixed', 'a')).toMatchObject({ ok: false, reason: 'no_permission' });
  });

  it('most_populated: picks the busiest channel the bot can speak in', () => {
    const channels = [ch('a', 2), ch('b', 9, false), ch('c', 4), ch('d', 0)];
    expect(pickChannel(channels, 'most_populated', null)).toMatchObject({ ok: true, channelId: 'c' });
  });

  it('most_populated: breaks ties by the configured channel, then position', () => {
    expect(pickChannel([ch('a', 3, true, 0), ch('b', 3, true, 1)], 'most_populated', 'b')).toMatchObject({ channelId: 'b' });
    expect(pickChannel([ch('a', 3, true, 2), ch('b', 3, true, 1)], 'most_populated', null)).toMatchObject({ channelId: 'b' });
  });

  it('most_populated: skips when every channel is empty', () => {
    expect(pickChannel([ch('a', 0), ch('b', 0)], 'most_populated', null)).toMatchObject({ ok: false, reason: 'empty' });
  });
});
