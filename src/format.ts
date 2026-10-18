import type {
  DailyActivity,
  DailyCardiovascularAge,
  DailyReadiness,
  DailyResilience,
  DailySleep,
  DailySpO2,
  DailyStress,
  EnhancedTag,
  HeartRateSample,
  RestModePeriod,
  Sample,
  Session,
  SleepPeriod,
  SleepTime,
  Tag,
  VO2Max,
  Workout,
} from "./types.js";

const MS_PER_MINUTE = 60_000;

export function round(value: number | null | undefined, digits = 1): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const hours = (sec: number | null | undefined) => (sec == null ? undefined : round(sec / 3600, 2));
const minutes = (sec: number | null | undefined) => (sec == null ? undefined : round(sec / 60, 0));
const km = (m: number | null | undefined) => (m == null ? undefined : round(m / 1000, 2));

/** Oura's own score bands: 85+ optimal, 70-84 good, below 70 pay attention. */
export function scoreZone(score: number | null | undefined): "optimal" | "good" | "pay_attention" | undefined {
  if (score == null) return undefined;
  return score >= 85 ? "optimal" : score >= 70 ? "good" : "pay_attention";
}

/** Drops null contributor values so the output stays compact. */
function contributors(c: Record<string, number | null> | undefined) {
  if (!c) return undefined;
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v != null));
}

export function durationMinutes(start: string, end: string): number | undefined {
  return round((Date.parse(end) - Date.parse(start)) / MS_PER_MINUTE, 0);
}

/** Parses an ISO offset suffix ("+03:00", "-0500", "Z") into minutes east of UTC. */
export function offsetMinutes(iso: string): number {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/** Renders an epoch-ms instant as wall-clock time in the given offset, e.g. "2026-10-13T07:12:00+03:00". */
export function formatLocal(ms: number, offsetMins: number): string {
  const shifted = new Date(ms + offsetMins * MS_PER_MINUTE).toISOString().slice(0, 19);
  if (offsetMins === 0) return `${shifted}Z`;
  const abs = Math.abs(offsetMins);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${shifted}${offsetMins < 0 ? "-" : "+"}${hh}:${mm}`;
}

/** This machine's UTC offset at `ms`, used for Oura's UTC-only time series. */
export function machineOffset(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}

/** avg/min/max of a sample series, ignoring gaps. */
export function sampleStats(sample: Sample | null | undefined) {
  const nums = (sample?.items ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return undefined;
  return {
    avg: round(nums.reduce((a, b) => a + b, 0) / nums.length, 1),
    min: round(Math.min(...nums), 1),
    max: round(Math.max(...nums), 1),
  };
}

export function summarizeReadiness(r: DailyReadiness) {
  return {
    day: r.day,
    score: r.score ?? undefined,
    zone: scoreZone(r.score),
    temperature_deviation_c: round(r.temperature_deviation, 2),
    temperature_trend_deviation_c: round(r.temperature_trend_deviation, 2),
    contributors: contributors(r.contributors),
  };
}

export function summarizeDailySleep(s: DailySleep) {
  return {
    day: s.day,
    score: s.score ?? undefined,
    zone: scoreZone(s.score),
    contributors: contributors(s.contributors),
  };
}

export function summarizeActivity(a: DailyActivity) {
  return {
    day: a.day,
    score: a.score ?? undefined,
    zone: scoreZone(a.score),
    steps: a.steps,
    active_kcal: a.active_calories,
    total_kcal: a.total_calories,
    target_kcal: a.target_calories,
    walking_equivalent_km: km(a.equivalent_walking_distance),
    high_activity_min: minutes(a.high_activity_time),
    medium_activity_min: minutes(a.medium_activity_time),
    low_activity_min: minutes(a.low_activity_time),
    sedentary_h: hours(a.sedentary_time),
    resting_h: hours(a.resting_time),
    non_wear_h: hours(a.non_wear_time),
    inactivity_alerts: a.inactivity_alerts,
    contributors: contributors(a.contributors),
  };
}

/** Sleep periods that are real sleep (not rejected "rest" or user-deleted ones). */
export function isRealSleep(s: SleepPeriod): boolean {
  return s.type !== "rest" && s.type !== "deleted";
}

export function isNap(s: SleepPeriod): boolean {
  return s.type === "sleep" || s.type === "late_nap";
}

export function summarizeSleepPeriod(s: SleepPeriod) {
  return {
    sleep_id: s.id,
    day: s.day,
    type: s.type ?? undefined,
    bedtime_start: s.bedtime_start,
    bedtime_end: s.bedtime_end,
    in_bed_h: hours(s.time_in_bed),
    asleep_h: hours(s.total_sleep_duration),
    deep_h: hours(s.deep_sleep_duration),
    rem_h: hours(s.rem_sleep_duration),
    light_h: hours(s.light_sleep_duration),
    awake_h: hours(s.awake_time),
    latency_min: minutes(s.latency),
    efficiency_pct: s.efficiency ?? undefined,
    restless_periods: s.restless_periods ?? undefined,
    avg_hr_bpm: round(s.average_heart_rate, 1),
    lowest_hr_bpm: s.lowest_heart_rate ?? undefined,
    avg_hrv_ms: s.average_hrv ?? undefined,
    avg_breath_per_min: round(s.average_breath, 1),
    readiness_score: s.readiness?.score ?? undefined,
    sleep_score_delta: s.sleep_score_delta ?? undefined,
    readiness_score_delta: s.readiness_score_delta ?? undefined,
    low_battery_alert: s.low_battery_alert || undefined,
  };
}

const STAGES: Record<string, string> = { "1": "deep", "2": "light", "3": "rem", "4": "awake" };

/** Turns Oura's 5-minute phase string ("4422113...") into time segments in the sleep's own timezone. */
export function hypnogram(s: SleepPeriod) {
  const phases = s.app_sleep_phase_5_min || s.sleep_phase_5_min;
  if (!phases) return undefined;
  const startMs = Date.parse(s.bedtime_start);
  const offset = offsetMinutes(s.bedtime_start);
  const segments: { start: string; end: string; stage: string; minutes: number }[] = [];
  let i = 0;
  while (i < phases.length) {
    let j = i;
    while (j < phases.length && phases[j] === phases[i]) j++;
    segments.push({
      start: formatLocal(startMs + i * 5 * MS_PER_MINUTE, offset),
      end: formatLocal(startMs + j * 5 * MS_PER_MINUTE, offset),
      stage: STAGES[phases[i]!] ?? "unknown",
      minutes: (j - i) * 5,
    });
    i = j;
  }
  return segments;
}

/** Downsamples a sample series to at most `max` points, keeping local timestamps. */
export function compactSeries(sample: Sample | null | undefined, max = 120) {
  if (!sample?.items?.length) return undefined;
  const startMs = Date.parse(sample.timestamp);
  const offset = offsetMinutes(sample.timestamp);
  const step = Math.max(1, Math.ceil(sample.items.length / max));
  const points: { t: string; v: number }[] = [];
  for (let i = 0; i < sample.items.length; i += step) {
    const chunk = sample.items.slice(i, i + step).filter((v): v is number => typeof v === "number");
    if (chunk.length === 0) continue;
    points.push({
      t: formatLocal(startMs + i * sample.interval * 1000, offset),
      v: round(chunk.reduce((a, b) => a + b, 0) / chunk.length, 1)!,
    });
  }
  return { interval_s: sample.interval * step, stats: sampleStats(sample), points };
}

export function sleepPeriodDetail(s: SleepPeriod) {
  return {
    ...summarizeSleepPeriod(s),
    readiness: s.readiness
      ? { score: s.readiness.score ?? undefined, contributors: contributors(s.readiness.contributors) }
      : undefined,
    hypnogram: hypnogram(s),
    heart_rate: compactSeries(s.heart_rate),
    hrv: compactSeries(s.hrv),
  };
}

export function summarizeWorkout(w: Workout) {
  return {
    workout_id: w.id,
    day: w.day,
    activity: w.activity,
    label: w.label ?? undefined,
    intensity: w.intensity,
    source: w.source,
    start: w.start_datetime,
    end: w.end_datetime,
    duration_min: durationMinutes(w.start_datetime, w.end_datetime),
    calories_kcal: round(w.calories, 0),
    distance_km: km(w.distance),
  };
}

export function summarizeSession(s: Session) {
  return {
    session_id: s.id,
    day: s.day,
    type: s.type,
    mood: s.mood ?? undefined,
    start: s.start_datetime,
    end: s.end_datetime,
    duration_min: durationMinutes(s.start_datetime, s.end_datetime),
    heart_rate_bpm: sampleStats(s.heart_rate),
    hrv_ms: sampleStats(s.heart_rate_variability),
  };
}

export function summarizeTag(t: Tag) {
  return { day: t.day, time: t.timestamp, tags: t.tags, text: t.text ?? undefined };
}

export function summarizeEnhancedTag(t: EnhancedTag) {
  return {
    day: t.start_day,
    time: t.start_time,
    end: t.end_time ?? undefined,
    tag: t.tag_type_code === "custom" ? (t.custom_name ?? "custom") : (t.tag_type_code ?? undefined),
    text: t.comment ?? undefined,
  };
}

export function summarizeRestMode(r: RestModePeriod) {
  return {
    start_day: r.start_day,
    end_day: r.end_day ?? undefined,
    ongoing: !r.end_day || undefined,
    start: r.start_time ?? undefined,
    end: r.end_time ?? undefined,
    episodes: r.episodes.map((e) => ({ time: e.timestamp, tags: e.tags })),
  };
}

export function summarizeStress(s: DailyStress) {
  return {
    summary: s.day_summary ?? undefined,
    stress_high_min: minutes(s.stress_high),
    recovery_high_min: minutes(s.recovery_high),
  };
}

export function summarizeResilience(r: DailyResilience) {
  return { level: r.level, contributors: r.contributors };
}

export function summarizeSpo2(s: DailySpO2) {
  return {
    avg_pct: round(s.spo2_percentage?.average, 1),
    breathing_disturbance_index: s.breathing_disturbance_index ?? undefined,
  };
}

const clock = (secondsFromMidnight: number) => {
  const mins = (((Math.round(secondsFromMidnight / 60) % 1440) + 1440) % 1440);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
};

export function summarizeSleepTime(s: SleepTime) {
  return {
    status: s.status ?? undefined,
    recommendation: s.recommendation ?? undefined,
    optimal_bedtime: s.optimal_bedtime
      ? `${clock(s.optimal_bedtime.start_offset)}-${clock(s.optimal_bedtime.end_offset)}`
      : undefined,
  };
}

export interface HealthDocs {
  stress?: DailyStress;
  resilience?: DailyResilience;
  spo2?: DailySpO2;
  cardiovascular?: DailyCardiovascularAge;
  vo2max?: VO2Max;
  sleepTime?: SleepTime;
}

export function summarizeHealth(day: string, h: HealthDocs) {
  return {
    day,
    stress: h.stress && summarizeStress(h.stress),
    resilience: h.resilience && summarizeResilience(h.resilience),
    spo2: h.spo2 && summarizeSpo2(h.spo2),
    cardiovascular_age: h.cardiovascular?.vascular_age ?? undefined,
    vo2_max: h.vo2max?.vo2_max ?? undefined,
    bedtime: h.sleepTime && summarizeSleepTime(h.sleepTime),
  };
}

export type Resolution = "5min" | "15min" | "hour" | "day";

const BUCKET_MINUTES: Record<Resolution, number> = { "5min": 5, "15min": 15, hour: 60, day: 1440 };

/**
 * Aggregates heart-rate samples into fixed buckets aligned to local wall-clock time, so an
 * "hour" bucket is 07:00-08:00 local rather than UTC.
 */
export function aggregateHeartRate(samples: HeartRateSample[], resolution: Resolution) {
  const size = BUCKET_MINUTES[resolution] * MS_PER_MINUTE;
  const buckets = new Map<number, { bpm: number[]; sources: Map<string, number>; offset: number }>();
  for (const s of samples) {
    const ms = Date.parse(s.timestamp);
    const offset = machineOffset(ms);
    const local = ms + offset * MS_PER_MINUTE;
    const key = Math.floor(local / size) * size - offset * MS_PER_MINUTE;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { bpm: [], sources: new Map(), offset }));
    b.bpm.push(s.bpm);
    b.sources.set(s.source, (b.sources.get(s.source) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, b]) => ({
      start: formatLocal(key, b.offset),
      ...bpmStats(b.bpm),
      source: [...b.sources.entries()].sort((x, y) => y[1] - x[1])[0]![0],
    }));
}

/** avg/min/max without spreading, which overflows the stack on month-long heart-rate series. */
function bpmStats(bpm: number[]) {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of bpm) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { avg_bpm: round(sum / bpm.length, 0), min_bpm: min, max_bpm: max, samples: bpm.length };
}

export function heartRateStats(samples: HeartRateSample[]) {
  if (samples.length === 0) return undefined;
  const groups = new Map<string, number[]>();
  for (const s of samples) {
    const list = groups.get(s.source);
    if (list) list.push(s.bpm);
    else groups.set(s.source, [s.bpm]);
  }
  const bySource = Object.fromEntries([...groups].map(([source, bpm]) => [source, bpmStats(bpm)]));
  return { ...bpmStats(samples.map((s) => s.bpm)), by_source: bySource };
}
