import { createReadStream, mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import prism from 'prism-media';
import { describe, expect, it } from 'vitest';
import { clipPath, validateClips } from '../src/voice/clips.js';

const AUDIO_DIR = new URL('../assets/audio', import.meta.url).pathname;

describe('audio clips', () => {
  it('all ten shipped clips are present and valid', () => {
    expect(validateClips(AUDIO_DIR)).toEqual([]);
  });

  it('demux into Opus packets the voice library can send', async () => {
    const packets = await new Promise<number>((resolve, reject) => {
      let n = 0;
      createReadStream(clipPath(AUDIO_DIR, 'dhuhr', 'start'))
        .pipe(new prism.opus.OggDemuxer())
        .on('data', () => n++)
        .on('end', () => resolve(n))
        .on('error', reject);
    });
    // 20ms frames, so a 1.5s+ clip has 75+ packets.
    expect(packets).toBeGreaterThan(75);
  });

  it('flags missing and non-Opus files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clips-'));
    copyFileSync(clipPath(AUDIO_DIR, 'fajr', 'start'), clipPath(dir, 'fajr', 'start'));
    writeFileSync(clipPath(dir, 'fajr', 'ending'), 'not audio');
    const problems = validateClips(dir);
    expect(problems).toHaveLength(9);
    expect(problems.some((p) => p.includes('fajr_ending.ogg is not an Ogg/Opus file'))).toBe(true);
  });
});
