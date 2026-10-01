import fs from 'node:fs';
import path from 'node:path';
import { EVENT_KINDS, PRAYERS, type EventKind, type Prayer } from '../prayer/types.js';

export function clipPath(dir: string, prayer: Prayer, kind: EventKind): string {
  return path.resolve(dir, `${prayer}_${kind}.ogg`);
}

/** Returns a list of problems; empty means all ten clips exist and look like Ogg/Opus. */
export function validateClips(dir: string): string[] {
  const problems: string[] = [];
  for (const prayer of PRAYERS) {
    for (const kind of EVENT_KINDS) {
      const file = clipPath(dir, prayer, kind);
      if (!fs.existsSync(file)) {
        problems.push(`missing ${file}`);
        continue;
      }
      const head = Buffer.alloc(64);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, head, 0, head.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (head.subarray(0, 4).toString('latin1') !== 'OggS' || !head.includes('OpusHead')) {
        problems.push(`${file} is not an Ogg/Opus file`);
      }
    }
  }
  return problems;
}
