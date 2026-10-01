import { describe, expect, it } from 'vitest';
import { commands } from '../src/commands/index.js';

describe('slash command definitions', () => {
  it('serialize without validation errors and have unique names', () => {
    const json = commands.map((c) => c.data.toJSON());
    expect(new Set(json.map((c) => c.name)).size).toBe(json.length);
    expect(json.map((c) => c.name).sort()).toEqual(['config', 'next', 'pause', 'prayer', 'resume', 'schedule', 'test']);
  });

  it('restrict everything except schedule and next to Manage Server', () => {
    for (const c of commands.map((x) => x.data.toJSON())) {
      const open = c.name === 'schedule' || c.name === 'next';
      expect(c.default_member_permissions ?? null, c.name).toBe(open ? null : '32');
    }
  });
});
