import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AladhanClient, AladhanError, type FetchLike } from '../src/prayer/aladhan.js';
import { aladhanMonthBody, londonOctober } from './helpers.js';

const params = { latitude: 51.5074, longitude: -0.1278, method: 3, school: 0, midnightMode: 0, latitudeAdjustmentMethod: 3 };

function fakeFetch(responses: (() => { status: number; body?: unknown } | Error)[]) {
  const urls: string[] = [];
  const fn: FetchLike = async (url) => {
    urls.push(url);
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    const r = next();
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return { fn, urls };
}

const client = (fn: FetchLike) => new AladhanClient({ fetch: fn, baseUrl: 'https://x', retryDelaysMs: [0, 0, 0] });

describe('AladhanClient.getMonth', () => {
  it('parses a calendar month into dated ISO timings', async () => {
    const { fn, urls } = fakeFetch([() => ({ status: 200, body: aladhanMonthBody(2026, 10, 'Europe/London', londonOctober) })]);
    const result = await client(fn).getMonth(params, 2026, 10);
    expect(result.timezone).toBe('Europe/London');
    expect(result.days).toHaveLength(31);
    expect(result.days[0]).toMatchObject({
      date: '2026-10-01',
      fajr: '2026-10-01T05:28:00+01:00',
      midnight: '2026-10-02T00:51:00+01:00',
      hijri: '1 Rabi al-thani 1448',
    });
    expect(result.days[30]!.date).toBe('2026-10-31');
    expect(urls[0]).toBe(
      'https://x/calendar/2026/10?latitude=51.5074&longitude=-0.1278&method=3&school=0&midnightMode=0&latitudeAdjustmentMethod=3&iso8601=true',
    );
  });

  it('retries server errors and network failures, then succeeds', async () => {
    const { fn, urls } = fakeFetch([
      () => ({ status: 502 }),
      () => new Error('ECONNRESET'),
      () => ({ status: 200, body: aladhanMonthBody(2026, 10, 'Europe/London', londonOctober) }),
    ]);
    await expect(client(fn).getMonth(params, 2026, 10)).resolves.toBeDefined();
    expect(urls).toHaveLength(3);
  });

  it('gives up after the last retry', async () => {
    const { fn, urls } = fakeFetch(Array(4).fill(() => ({ status: 503 })));
    await expect(client(fn).getMonth(params, 2026, 10)).rejects.toMatchObject({ retryable: true });
    expect(urls).toHaveLength(4);
  });

  it('does not retry client errors and surfaces the message', async () => {
    const { fn, urls } = fakeFetch([() => ({ status: 400, body: { code: 400, status: 'BAD_REQUEST', data: 'Invalid latitude' } })]);
    await expect(client(fn).getMonth(params, 2026, 10)).rejects.toThrow('Invalid latitude');
    expect(urls).toHaveLength(1);
  });

  it('rejects responses that are not ISO timestamps', async () => {
    const body = aladhanMonthBody(2026, 10, 'Europe/London', londonOctober) as { data: { timings: Record<string, string> }[] };
    body.data[3]!.timings.Fajr = '05:31 (BST)';
    const { fn } = fakeFetch([() => ({ status: 200, body })]);
    await expect(client(fn).getMonth(params, 2026, 10)).rejects.toBeInstanceOf(AladhanError);
  });
});

describe('AladhanClient location lookup', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/aladhan-timingsByCity.json', import.meta.url), 'utf8'));

  it('resolves a city to coordinates and timezone', async () => {
    const { fn, urls } = fakeFetch([() => ({ status: 200, body: fixture })]);
    await expect(client(fn).resolveCity('London', 'GB')).resolves.toEqual({
      latitude: 51.5073219,
      longitude: -0.1276474,
      timezone: 'Europe/London',
    });
    expect(urls[0]).toMatch(/^https:\/\/x\/timingsByCity\/\d{2}-\d{2}-\d{4}\?city=London&country=GB&iso8601=true$/);
  });

  it('reports an unknown city', async () => {
    const { fn } = fakeFetch([() => ({ status: 400, body: { code: 400, status: 'BAD_REQUEST', data: 'Unable to locate city and country.' } })]);
    await expect(client(fn).resolveCity('Nowhere', 'XX')).rejects.toThrow('Unable to locate city');
  });
});
