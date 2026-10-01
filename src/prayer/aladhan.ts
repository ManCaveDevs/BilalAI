import { z } from 'zod';
import type { DayTimings } from './types.js';

export const ALADHAN_BASE = 'https://api.aladhan.com/v1';

export interface CalcParams {
  latitude: number;
  longitude: number;
  method: number;
  school: number;
  midnightMode: number;
  latitudeAdjustmentMethod: number;
}

export interface ResolvedLocation {
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface MonthResult {
  timezone: string;
  days: DayTimings[];
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Aladhan calculation methods offered in /config method. */
export const METHODS: { id: number; name: string }[] = [
  { id: 3, name: 'Muslim World League' },
  { id: 2, name: 'ISNA (North America)' },
  { id: 15, name: 'Moonsighting Committee Worldwide' },
  { id: 1, name: 'University of Islamic Sciences, Karachi' },
  { id: 4, name: 'Umm Al-Qura, Makkah' },
  { id: 5, name: 'Egyptian General Authority of Survey' },
  { id: 8, name: 'Gulf Region' },
  { id: 9, name: 'Kuwait' },
  { id: 10, name: 'Qatar' },
  { id: 16, name: 'Dubai' },
  { id: 11, name: 'MUIS, Singapore' },
  { id: 17, name: 'JAKIM, Malaysia' },
  { id: 20, name: 'KEMENAG, Indonesia' },
  { id: 12, name: 'UOIF, France' },
  { id: 13, name: 'Diyanet, Turkey' },
  { id: 14, name: 'Spiritual Administration of Muslims of Russia' },
  { id: 18, name: 'Tunisia' },
  { id: 19, name: 'Algeria' },
  { id: 21, name: 'Morocco' },
  { id: 22, name: 'Comunidade Islamica de Lisboa' },
  { id: 23, name: 'Ministry of Awqaf, Jordan' },
  { id: 7, name: 'Institute of Geophysics, Tehran' },
  { id: 0, name: 'Shia Ithna-Ashari (Jafari)' },
];

export function methodName(id: number): string {
  return METHODS.find((m) => m.id === id)?.name ?? `Method ${id}`;
}

const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/, 'expected ISO timestamp');

const dayEntry = z.object({
  timings: z.object({
    Fajr: isoTime,
    Sunrise: isoTime,
    Dhuhr: isoTime,
    Asr: isoTime,
    Maghrib: isoTime,
    Isha: isoTime,
    Midnight: isoTime,
  }),
  date: z.object({
    gregorian: z.object({ date: z.string().regex(/^\d{2}-\d{2}-\d{4}$/) }),
    hijri: z
      .object({
        day: z.string(),
        month: z.object({ en: z.string() }),
        year: z.string(),
      })
      .optional(),
  }),
  meta: z.object({
    latitude: z.number(),
    longitude: z.number(),
    timezone: z.string().min(1),
  }),
});

type DayEntry = z.infer<typeof dayEntry>;

const calendarResponse = z.object({ code: z.literal(200), data: z.array(dayEntry).min(1) });
const singleResponse = z.object({ code: z.literal(200), data: dayEntry });

export class AladhanError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AladhanError';
  }
}

function toDay(entry: DayEntry): DayTimings {
  const [dd, mm, yyyy] = entry.date.gregorian.date.split('-');
  const t = entry.timings;
  const h = entry.date.hijri;
  return {
    date: `${yyyy}-${mm}-${dd}`,
    fajr: t.Fajr,
    sunrise: t.Sunrise,
    dhuhr: t.Dhuhr,
    asr: t.Asr,
    maghrib: t.Maghrib,
    isha: t.Isha,
    midnight: t.Midnight,
    hijri: h ? `${h.day} ${h.month.en} ${h.year}` : undefined,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AladhanClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  /** Delays between attempts; length + 1 = total attempts. */
  retryDelaysMs?: number[];
}

export class AladhanClient {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];

  constructor(opts: AladhanClientOptions = {}) {
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = opts.baseUrl ?? ALADHAN_BASE;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retryDelaysMs = opts.retryDelaysMs ?? [1_000, 4_000, 16_000];
  }

  /** Every day of one month (month is 1-12). */
  async getMonth(params: CalcParams, year: number, month: number): Promise<MonthResult> {
    const url = `${this.baseUrl}/calendar/${year}/${month}?${calcQuery(params)}`;
    const body = await this.request(url);
    const parsed = calendarResponse.safeParse(body);
    if (!parsed.success) throw new AladhanError(`Unexpected calendar response: ${describe(body, parsed.error)}`, false);
    return { timezone: parsed.data.data[0]!.meta.timezone, days: parsed.data.data.map(toDay) };
  }

  /** Resolves a city to coordinates and timezone. */
  async resolveCity(city: string, country: string): Promise<ResolvedLocation> {
    const q = new URLSearchParams({ city, country, iso8601: 'true' });
    const body = await this.request(`${this.baseUrl}/timingsByCity/${todayParam()}?${q}`);
    return this.parseLocation(body);
  }

  /** Looks up the timezone for a pair of coordinates. */
  async resolveCoordinates(latitude: number, longitude: number): Promise<ResolvedLocation> {
    const q = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), iso8601: 'true' });
    const body = await this.request(`${this.baseUrl}/timings/${todayParam()}?${q}`);
    return this.parseLocation(body);
  }

  private parseLocation(body: unknown): ResolvedLocation {
    const parsed = singleResponse.safeParse(body);
    if (!parsed.success) throw new AladhanError(`Could not resolve location: ${describe(body, parsed.error)}`, false);
    const { latitude, longitude, timezone } = parsed.data.data.meta;
    return { latitude, longitude, timezone };
  }

  private async request(url: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(this.retryDelaysMs[attempt - 1]!);
      try {
        const res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.ok) return await res.json();
        // 4xx (bad city, bad params) will not succeed on retry.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          const body = await res.json().catch(() => undefined);
          // Aladhan's own message (e.g. "Unable to locate city and country.") is shown to users.
          throw new AladhanError(describe(body, undefined, `Aladhan returned ${res.status}`), false);
        }
        lastError = new AladhanError(`Aladhan returned ${res.status}`, true);
      } catch (err) {
        if (err instanceof AladhanError && !err.retryable) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof AladhanError
      ? lastError
      : new AladhanError(`Aladhan request failed: ${(lastError as Error)?.message ?? lastError}`, true);
  }
}

function calcQuery(p: CalcParams): URLSearchParams {
  return new URLSearchParams({
    latitude: String(p.latitude),
    longitude: String(p.longitude),
    method: String(p.method),
    school: String(p.school),
    midnightMode: String(p.midnightMode),
    latitudeAdjustmentMethod: String(p.latitudeAdjustmentMethod),
    iso8601: 'true',
  });
}

function todayParam(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function describe(body: unknown, error?: z.ZodError, fallback = 'no details'): string {
  if (body && typeof body === 'object' && 'data' in body && typeof (body as { data: unknown }).data === 'string') {
    return (body as { data: string }).data;
  }
  return error ? error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : fallback;
}
