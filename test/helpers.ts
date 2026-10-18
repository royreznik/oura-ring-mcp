import type {
  DailyActivity,
  DailyReadiness,
  DailyResilience,
  DailySleep,
  DailySpO2,
  DailyStress,
  EnhancedTag,
  HeartRateSample,
  RingConfiguration,
  Session,
  SleepPeriod,
  SleepTime,
  Tag,
  Workout,
} from "../src/types.js";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export interface RecordedCall {
  url: URL;
  init?: RequestInit;
}

/** A fetch stand-in that records calls and delegates responses to `handler`. */
export function fakeFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

export const staticTokens = {
  getAccessToken: async () => "token-1",
  forceRefresh: async () => "token-2",
};

export const DAY = "2026-10-13";

export const readiness: DailyReadiness = {
  id: "r-1",
  day: DAY,
  score: 86,
  temperature_deviation: -0.123,
  temperature_trend_deviation: 0.05,
  timestamp: "2026-10-13T00:00:00+03:00",
  contributors: {
    activity_balance: 81,
    body_temperature: 98,
    hrv_balance: 77,
    previous_day_activity: 90,
    previous_night: 88,
    recovery_index: 100,
    resting_heart_rate: 95,
    sleep_balance: 84,
    sleep_regularity: null,
  },
};

export const dailySleep: DailySleep = {
  id: "ds-1",
  day: DAY,
  score: 68,
  timestamp: "2026-10-13T00:00:00+03:00",
  contributors: { deep_sleep: 95, efficiency: 88, latency: 75, rem_sleep: 60, restfulness: 70, timing: 90, total_sleep: 55 },
};

const HOUR = 3600;

export const mainSleepPeriod: SleepPeriod = {
  id: "sleep-main",
  day: DAY,
  type: "long_sleep",
  period: 0,
  // 23:30 local on Oct 12 -> belongs to Oct 13, the day you wake up.
  bedtime_start: "2026-10-12T23:30:00+03:00",
  bedtime_end: "2026-10-13T06:45:00+03:00",
  time_in_bed: 7.25 * HOUR,
  total_sleep_duration: 6.5 * HOUR,
  awake_time: 0.75 * HOUR,
  light_sleep_duration: 3.5 * HOUR,
  deep_sleep_duration: 1.5 * HOUR,
  rem_sleep_duration: 1.5 * HOUR,
  latency: 600,
  efficiency: 90,
  restless_periods: 180,
  average_breath: 14.625,
  average_heart_rate: 52.375,
  lowest_heart_rate: 46,
  average_hrv: 61,
  heart_rate: { interval: 300, items: [58, 55, null, 50, 46, 48], timestamp: "2026-10-12T23:30:00+03:00" },
  hrv: { interval: 300, items: [40, 55, 70, null, 65, 60], timestamp: "2026-10-12T23:30:00+03:00" },
  readiness: { score: 86, temperature_deviation: -0.12, contributors: { hrv_balance: 77, recovery_index: 100 } },
  readiness_score_delta: 2,
  sleep_score_delta: 1,
  low_battery_alert: false,
  // deep 10 min, light 5 min, REM 5 min, awake 5 min
  sleep_phase_5_min: "11234",
  app_sleep_phase_5_min: null,
};

export const nap: SleepPeriod = {
  ...mainSleepPeriod,
  id: "sleep-nap",
  type: "sleep",
  period: 1,
  bedtime_start: "2026-10-13T14:00:00+03:00",
  bedtime_end: "2026-10-13T14:40:00+03:00",
  time_in_bed: 2400,
  total_sleep_duration: 1800,
};

export const rejectedRest: SleepPeriod = { ...nap, id: "sleep-rest", type: "rest" };

export const activity: DailyActivity = {
  id: "a-1",
  day: DAY,
  score: 72,
  active_calories: 612,
  total_calories: 2710,
  target_calories: 500,
  steps: 11234,
  equivalent_walking_distance: 10345,
  meters_to_target: 0,
  target_meters: 9000,
  high_activity_time: 1800,
  medium_activity_time: 2700,
  low_activity_time: 10800,
  sedentary_time: 30000,
  resting_time: 28000,
  non_wear_time: 600,
  inactivity_alerts: 1,
  average_met_minutes: 1.6,
  high_activity_met_minutes: 300,
  medium_activity_met_minutes: 200,
  low_activity_met_minutes: 150,
  sedentary_met_minutes: 20,
  class_5_min: "111223344",
  met: { interval: 60, items: [0.9, 1.2], timestamp: "2026-10-13T04:00:00+03:00" },
  contributors: { meet_daily_targets: 60, move_every_hour: 95, recovery_time: 80, stay_active: 70, training_frequency: 85, training_volume: 90 },
  timestamp: "2026-10-13T04:00:00+03:00",
};

export const workout: Workout = {
  id: "w-run",
  day: DAY,
  activity: "running",
  calories: 512.4,
  distance: 8123.4,
  intensity: "hard",
  label: null,
  source: "confirmed",
  start_datetime: "2026-10-13T17:00:00+03:00",
  end_datetime: "2026-10-13T17:45:30+03:00",
};

export const swim: Workout = {
  ...workout,
  id: "w-swim",
  activity: "swimming",
  distance: 1500,
  intensity: "moderate",
  start_datetime: "2026-10-13T07:00:00+03:00",
  end_datetime: "2026-10-13T07:40:00+03:00",
};

export const session: Session = {
  id: "s-1",
  day: DAY,
  type: "breathing",
  mood: "good",
  start_datetime: "2026-10-13T12:00:00+03:00",
  end_datetime: "2026-10-13T12:10:00+03:00",
  heart_rate: { interval: 60, items: [70, 66, 62], timestamp: "2026-10-13T12:00:00+03:00" },
  heart_rate_variability: { interval: 60, items: [40, 50, 60], timestamp: "2026-10-13T12:00:00+03:00" },
  motion_count: null,
};

export const stress: DailyStress = { id: "st-1", day: DAY, day_summary: "normal", stress_high: 5400, recovery_high: 3600 };
export const resilience: DailyResilience = {
  id: "re-1",
  day: DAY,
  level: "solid",
  contributors: { sleep_recovery: 70.5, daytime_recovery: 40.1, stress: 55 },
};
export const spo2: DailySpO2 = { id: "sp-1", day: DAY, spo2_percentage: { average: 96.543 }, breathing_disturbance_index: 4 };
export const sleepTime: SleepTime = {
  id: "t-1",
  day: DAY,
  // 22:30 to 23:30 local
  optimal_bedtime: { day_tz: 10800, start_offset: -5400, end_offset: -1800 },
  recommendation: "follow_optimal_bedtime",
  status: "optimal_found",
};
export const tag: Tag = { id: "tag-1", day: DAY, text: "late dinner", timestamp: "2026-10-13T21:00:00+03:00", tags: ["tag_generic_late_meal"] };
export const enhancedTag: EnhancedTag = {
  id: "et-1",
  tag_type_code: "tag_generic_alcohol",
  start_time: "2026-10-13T20:00:00+03:00",
  end_time: null,
  start_day: DAY,
  end_day: null,
  comment: "2 glasses",
  custom_name: null,
};
export const ring: RingConfiguration = {
  id: "ring-1",
  color: "stealth_black",
  design: "horizon",
  firmware_version: "2.9.1",
  hardware_type: "gen4",
  set_up_at: "2025-01-02T10:00:00Z",
  size: 10,
};

export const heartRate: HeartRateSample[] = [
  { timestamp: "2026-10-13T04:00:00Z", bpm: 50, source: "sleep" },
  { timestamp: "2026-10-13T04:05:00Z", bpm: 54, source: "sleep" },
  { timestamp: "2026-10-13T05:00:00Z", bpm: 70, source: "awake" },
  { timestamp: "2026-10-13T05:30:00Z", bpm: 150, source: "workout" },
];

const COLLECTIONS: Record<string, unknown[]> = {
  daily_readiness: [readiness],
  daily_sleep: [dailySleep],
  daily_activity: [activity],
  sleep: [mainSleepPeriod, nap, rejectedRest],
  workout: [workout, swim],
  session: [session],
  daily_stress: [stress],
  daily_resilience: [resilience],
  daily_spo2: [spo2],
  daily_cardiovascular_age: [{ id: "c-1", day: DAY, vascular_age: 31, pulse_wave_velocity: 6.1 }],
  vO2_max: [{ id: "v-1", day: DAY, vo2_max: 49, timestamp: "2026-10-13T08:00:00+03:00" }],
  sleep_time: [sleepTime],
  tag: [tag],
  enhanced_tag: [enhancedTag],
  rest_mode_period: [],
  ring_configuration: [ring],
  heartrate: heartRate,
  ring_battery_level: [{ timestamp: "2026-10-13T09:00:00Z", level: 64, charging: false, in_charger: false }],
};

/**
 * Serves the fixtures the way the Oura API would, filtering day-keyed documents by
 * start_date (inclusive) and end_date (exclusive). `deny` makes those types answer 403.
 */
export function ouraApi(opts: { deny?: string[] } = {}) {
  return fakeFetch((url) => {
    const m = /^\/v2\/usercollection\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return json({ detail: "Not Found" }, 404);
    const [, type, id] = m as unknown as [string, string, string | undefined];
    if (opts.deny?.includes(type)) return json({ detail: "Forbidden" }, 403);
    if (type === "personal_info") {
      return json({ id: "u-1", age: 38, weight: 72.5, height: 1.8, biological_sex: "male", email: "me@example.com" });
    }
    const docs = COLLECTIONS[type];
    if (!docs) return json({ detail: "Not Found" }, 404);
    if (id) {
      const doc = docs.find((d) => (d as { id?: string }).id === id);
      return doc ? json(doc) : json({ detail: "Not Found" }, 404);
    }
    const start = url.searchParams.get("start_date");
    const end = url.searchParams.get("end_date");
    const data = docs.filter((d) => {
      const day = (d as { day?: string; start_day?: string }).day ?? (d as { start_day?: string }).start_day;
      return !day || ((!start || day >= start) && (!end || day < end));
    });
    return json({ data, next_token: null });
  });
}
