/** Strips control characters (terminal escapes, newlines, bidi overrides) from untrusted text and caps its length. */
export function sanitize(text: string, max = 200): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .trim()
    .slice(0, max);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

const DAY_MS = 86_400_000;

/** Shifts a YYYY-MM-DD calendar day by `n` days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Today's calendar day in this machine's timezone, which is normally the ring wearer's. */
export function today(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days from `from` to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
