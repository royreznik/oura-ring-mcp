import { OuraApiError, type DayRange, type OuraClient } from "./client.js";
import {
  isNap,
  isRealSleep,
  round,
  scoreZone,
  summarizeActivity,
  summarizeDailySleep,
  summarizeEnhancedTag,
  summarizeHealth,
  summarizeReadiness,
  summarizeSession,
  summarizeSleepPeriod,
  summarizeTag,
  summarizeWorkout,
} from "./format.js";
import type { DocumentType, DocumentTypes, SleepPeriod } from "./types.js";
import { addDays, today } from "./util.js";

/** Maps a 404 to null, e.g. personal info in the sandbox. */
export async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof OuraApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Statuses that mean "this one data type isn't available to us" (scope not granted, endpoint
 * missing, app too old) rather than "the request failed". Combined views skip that type
 * and list it under `unavailable` instead of failing as a whole.
 */
const SKIPPABLE = new Set([403, 404, 426]);

export class Collector {
  readonly unavailable: string[] = [];

  constructor(private readonly client: OuraClient) {}

  async docs<K extends DocumentType>(type: K, range: DayRange): Promise<DocumentTypes[K][]> {
    try {
      return (await this.client.documents(type, range)).data;
    } catch (err) {
      if (err instanceof OuraApiError && SKIPPABLE.has(err.status)) {
        this.unavailable.push(`${type} (${err.status})`);
        return [];
      }
      throw err;
    }
  }

  /** `unavailable` only when something was skipped, to keep normal output compact. */
  report() {
    return this.unavailable.length ? { unavailable: this.unavailable.sort() } : {};
  }
}

const byDay = <T extends { day: string }>(docs: T[]) => new Map(docs.map((d) => [d.day, d]));

const sleepLength = (s: SleepPeriod) => s.total_sleep_duration ?? s.time_in_bed;

/** The night's main sleep: the longest real sleep, preferring Oura's `long_sleep` periods. */
export function mainSleep(periods: SleepPeriod[]): SleepPeriod | undefined {
  const real = periods.filter(isRealSleep);
  const long = real.filter((s) => s.type === "long_sleep");
  return (long.length ? long : real).sort((a, b) => sleepLength(b) - sleepLength(a))[0];
}

/** The most recent day with a sleep or readiness score; Oura only scores a day once the ring syncs. */
async function latestScoredDay(client: OuraClient, now: number): Promise<string> {
  const end = today(now);
  const range = { start: addDays(end, -3), end };
  const c = new Collector(client);
  const [readiness, sleep] = await Promise.all([c.docs("daily_readiness", range), c.docs("daily_sleep", range)]);
  const days = [...readiness, ...sleep].filter((d) => d.score != null).map((d) => d.day);
  return days.sort().at(-1) ?? end;
}

export async function dailyOverview(client: OuraClient, date?: string, now = Date.now()) {
  const day = date ?? (await latestScoredDay(client, now));
  const range = { start: day, end: day };
  const c = new Collector(client);
  const [readiness, dailySleep, activity, periods, stress, resilience, spo2, cardio, vo2, sleepTime, workouts, sessions, tags, enhancedTags] =
    await Promise.all([
      c.docs("daily_readiness", range),
      c.docs("daily_sleep", range),
      c.docs("daily_activity", range),
      c.docs("sleep", range),
      c.docs("daily_stress", range),
      c.docs("daily_resilience", range),
      c.docs("daily_spo2", range),
      c.docs("daily_cardiovascular_age", range),
      c.docs("vO2_max", range),
      c.docs("sleep_time", range),
      c.docs("workout", range),
      c.docs("session", range),
      c.docs("tag", range),
      c.docs("enhanced_tag", range),
    ]);

  const main = mainSleep(periods);
  const health = summarizeHealth(day, {
    stress: stress[0],
    resilience: resilience[0],
    spo2: spo2[0],
    cardiovascular: cardio[0],
    vo2max: vo2[0],
    sleepTime: sleepTime[0],
  });
  const empty = !readiness.length && !dailySleep.length && !activity.length && !periods.length;
  return {
    day,
    ...(empty ? { message: "No Oura data for this day yet. The ring may not have synced; open the Oura app." } : {}),
    readiness: readiness[0] && summarizeReadiness(readiness[0]),
    sleep: {
      ...(dailySleep[0] ? summarizeDailySleep(dailySleep[0]) : {}),
      main: main && summarizeSleepPeriod(main),
      naps: periods.filter((s) => s !== main && isRealSleep(s) && isNap(s)).map(summarizeSleepPeriod),
    },
    activity: activity[0] && summarizeActivity(activity[0]),
    stress: health.stress,
    resilience: health.resilience,
    spo2: health.spo2,
    cardiovascular_age: health.cardiovascular_age,
    vo2_max: health.vo2_max,
    bedtime: health.bedtime,
    workouts: workouts.map(summarizeWorkout),
    sessions: sessions.map(summarizeSession),
    tags: [...tags.map(summarizeTag), ...enhancedTags.map(summarizeEnhancedTag)],
    ...c.report(),
  };
}

export function stats(values: (number | undefined)[]) {
  const nums = values.filter((v): v is number => typeof v === "number");
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    avg: round(sum / nums.length, 1),
    min: round(Math.min(...nums), 1),
    max: round(Math.max(...nums), 1),
    days: nums.length,
  };
}

export async function trends(client: OuraClient, days: number, now = Date.now()) {
  const end = today(now);
  const range = { start: addDays(end, -(days - 1)), end };
  const c = new Collector(client);
  const [readiness, dailySleep, activity, periods, stress, resilience, spo2, workouts] = await Promise.all([
    c.docs("daily_readiness", range),
    c.docs("daily_sleep", range),
    c.docs("daily_activity", range),
    c.docs("sleep", range),
    c.docs("daily_stress", range),
    c.docs("daily_resilience", range),
    c.docs("daily_spo2", range),
    c.docs("workout", range),
  ]);

  const readinessBy = byDay(readiness);
  const sleepBy = byDay(dailySleep);
  const activityBy = byDay(activity);
  const stressBy = byDay(stress);
  const resilienceBy = byDay(resilience);
  const spo2By = byDay(spo2);
  const periodsBy = new Map<string, SleepPeriod[]>();
  for (const p of periods) periodsBy.set(p.day, [...(periodsBy.get(p.day) ?? []), p]);

  const rows = [];
  for (let day = range.start; day <= range.end; day = addDays(day, 1)) {
    const r = readinessBy.get(day);
    const s = sleepBy.get(day);
    const a = activityBy.get(day);
    const main = mainSleep(periodsBy.get(day) ?? []);
    const dayWorkouts = workouts.filter((w) => w.day === day);
    if (!r && !s && !a && !main && !dayWorkouts.length) continue;
    const st = stressBy.get(day);
    rows.push({
      day,
      // Today's activity keeps accumulating until 4 a.m. tomorrow.
      in_progress: day === end || undefined,
      readiness: r?.score ?? undefined,
      readiness_zone: scoreZone(r?.score),
      sleep_score: s?.score ?? undefined,
      activity_score: a?.score ?? undefined,
      asleep_h: round((main?.total_sleep_duration ?? NaN) / 3600, 2),
      deep_h: round((main?.deep_sleep_duration ?? NaN) / 3600, 2),
      rem_h: round((main?.rem_sleep_duration ?? NaN) / 3600, 2),
      sleep_efficiency_pct: main?.efficiency ?? undefined,
      hrv_ms: main?.average_hrv ?? undefined,
      lowest_hr_bpm: main?.lowest_heart_rate ?? undefined,
      temperature_deviation_c: round(r?.temperature_deviation, 2),
      steps: a?.steps,
      active_kcal: a?.active_calories,
      stress_high_min: round((st?.stress_high ?? NaN) / 60, 0),
      stress_summary: st?.day_summary ?? undefined,
      resilience: resilienceBy.get(day)?.level,
      spo2_pct: round(spo2By.get(day)?.spo2_percentage?.average, 1),
      workouts: dayWorkouts.map((w) => w.activity),
    });
  }

  // Today's steps and calories are partial, so keep them out of activity averages.
  const complete = rows.filter((r) => !r.in_progress);
  const zones = { optimal: 0, good: 0, pay_attention: 0 };
  for (const r of rows) if (r.readiness_zone) zones[r.readiness_zone]++;

  return {
    period: { days, from: range.start, to: range.end },
    averages: {
      readiness: stats(rows.map((r) => r.readiness)),
      sleep_score: stats(rows.map((r) => r.sleep_score)),
      activity_score: stats(complete.map((r) => r.activity_score)),
      asleep_h: stats(rows.map((r) => r.asleep_h)),
      deep_h: stats(rows.map((r) => r.deep_h)),
      rem_h: stats(rows.map((r) => r.rem_h)),
      hrv_ms: stats(rows.map((r) => r.hrv_ms)),
      lowest_hr_bpm: stats(rows.map((r) => r.lowest_hr_bpm)),
      temperature_deviation_c: stats(rows.map((r) => r.temperature_deviation_c)),
      steps: stats(complete.map((r) => r.steps)),
      active_kcal: stats(complete.map((r) => r.active_kcal)),
      stress_high_min: stats(complete.map((r) => r.stress_high_min)),
    },
    readiness_zones: zones,
    total_workouts: rows.reduce((n, r) => n + r.workouts.length, 0),
    days: rows,
    ...c.report(),
  };
}

