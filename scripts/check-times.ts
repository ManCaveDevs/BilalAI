/**
 * Live check against the real Aladhan API, no Discord needed:
 *   npm run check-times -- London "United Kingdom" [method]
 * Prints today's windows and announcement times exactly as the bot would use them.
 */
import { DateTime } from 'luxon';
import { AladhanClient, methodName } from '../src/prayer/aladhan.js';
import { PRAYERS, PRAYER_NAMES, type DayTimings } from '../src/prayer/types.js';
import { buildDayWindows } from '../src/prayer/windows.js';

const [city, country, method = '3'] = process.argv.slice(2);
if (!city || !country) {
  console.error('Usage: npm run check-times -- <city> <country> [method]');
  process.exit(1);
}

const client = new AladhanClient();
const loc = await client.resolveCity(city, country);
const now = DateTime.now().setZone(loc.timezone);
const params = { ...loc, method: Number(method), school: 0, midnightMode: 0, latitudeAdjustmentMethod: 3 };
const days = new Map<string, DayTimings>();
// Today and tomorrow, which may be in the next month (Isha can end after midnight).
for (const key of new Set([now, now.plus({ days: 1 })].map((d) => `${d.year}-${d.month}`))) {
  const [year, month] = key.split('-').map(Number) as [number, number];
  for (const d of (await client.getMonth(params, year, month)).days) days.set(d.date, d);
}

const opts = {
  timezone: loc.timezone,
  warnMinutes: 15,
  ishaEnd: 'midnight' as const,
  prayers: Object.fromEntries(PRAYERS.map((p) => [p, { startOn: true, endingOn: true, offsetMinutes: 0 }])) as never,
};
const today = now.toISODate()!;
console.log(`${city}, ${country}: ${loc.latitude}, ${loc.longitude} (${loc.timezone}), ${methodName(Number(method))}`);
console.log(`${today}  ${days.get(today)?.hijri ?? ''}\n`);
for (const w of buildDayWindows(today, (d) => days.get(d), opts)) {
  const f = (dt: DateTime | null) => (dt ? dt.toFormat('HH:mm') : '--:--');
  console.log(`${PRAYER_NAMES[w.prayer].padEnd(8)} ${f(w.start)} to ${f(w.close)}   ending soon at ${f(w.endingAt)}`);
}
