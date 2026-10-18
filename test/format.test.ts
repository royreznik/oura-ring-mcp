import { describe, expect, it } from "vitest";
import {
  aggregateHeartRate,
  compactSeries,
  formatLocal,
  heartRateStats,
  hypnogram,
  offsetMinutes,
  round,
  scoreZone,
  sleepPeriodDetail,
  summarizeActivity,
  summarizeReadiness,
  summarizeSleepPeriod,
  summarizeSleepTime,
  summarizeWorkout,
} from "../src/format.js";
import { mainSleep } from "../src/insights.js";
import { activity, heartRate, mainSleepPeriod, nap, readiness, rejectedRest, sleepTime, workout } from "./helpers.js";

describe("units and helpers", () => {
  it("rounds and drops missing values", () => {
    expect(round(1.25, 1)).toBe(1.3);
    expect(round(null)).toBeUndefined();
    expect(round(Number.NaN)).toBeUndefined();
  });

  it("uses Oura's score bands", () => {
    expect(scoreZone(85)).toBe("optimal");
    expect(scoreZone(70)).toBe("good");
    expect(scoreZone(69)).toBe("pay_attention");
    expect(scoreZone(null)).toBeUndefined();
  });

  it("parses offsets and renders local time", () => {
    expect(offsetMinutes("2026-10-13T07:00:00+03:00")).toBe(180);
    expect(offsetMinutes("2026-10-13T07:00:00-0530")).toBe(-330);
    expect(offsetMinutes("2026-10-13T07:00:00Z")).toBe(0);
    expect(formatLocal(Date.parse("2026-10-13T04:00:00Z"), 180)).toBe("2026-10-13T07:00:00+03:00");
    expect(formatLocal(Date.parse("2026-10-13T04:00:00Z"), 0)).toBe("2026-10-13T04:00:00Z");
  });
});

describe("summaries", () => {
  it("summarizes readiness, dropping null contributors", () => {
    expect(summarizeReadiness(readiness)).toEqual({
      day: "2026-10-13",
      score: 86,
      zone: "optimal",
      temperature_deviation_c: -0.12,
      temperature_trend_deviation_c: 0.05,
      contributors: {
        activity_balance: 81,
        body_temperature: 98,
        hrv_balance: 77,
        previous_day_activity: 90,
        previous_night: 88,
        recovery_index: 100,
        resting_heart_rate: 95,
        sleep_balance: 84,
      },
    });
  });

  it("converts sleep seconds to hours and minutes", () => {
    expect(summarizeSleepPeriod(mainSleepPeriod)).toMatchObject({
      sleep_id: "sleep-main",
      type: "long_sleep",
      in_bed_h: 7.25,
      asleep_h: 6.5,
      deep_h: 1.5,
      rem_h: 1.5,
      light_h: 3.5,
      awake_h: 0.75,
      latency_min: 10,
      efficiency_pct: 90,
      avg_hr_bpm: 52.4,
      lowest_hr_bpm: 46,
      avg_hrv_ms: 61,
      avg_breath_per_min: 14.6,
      readiness_score: 86,
    });
    expect(summarizeSleepPeriod(mainSleepPeriod).low_battery_alert).toBeUndefined();
  });

  it("summarizes activity in friendly units", () => {
    expect(summarizeActivity(activity)).toMatchObject({
      steps: 11234,
      active_kcal: 612,
      walking_equivalent_km: 10.35,
      high_activity_min: 30,
      medium_activity_min: 45,
      low_activity_min: 180,
      sedentary_h: 8.33,
      non_wear_h: 0.17,
    });
  });

  it("summarizes workouts with duration and km", () => {
    expect(summarizeWorkout(workout)).toEqual({
      workout_id: "w-run",
      day: "2026-10-13",
      activity: "running",
      label: undefined,
      intensity: "hard",
      source: "confirmed",
      start: "2026-10-13T17:00:00+03:00",
      end: "2026-10-13T17:45:30+03:00",
      duration_min: 46,
      calories_kcal: 512,
      distance_km: 8.12,
    });
  });

  it("renders the optimal bedtime window as local clock times", () => {
    expect(summarizeSleepTime(sleepTime)).toEqual({
      status: "optimal_found",
      recommendation: "follow_optimal_bedtime",
      optimal_bedtime: "22:30-23:30",
    });
  });
});

describe("sleep detail", () => {
  it("turns the 5-minute phase string into stage segments", () => {
    expect(hypnogram(mainSleepPeriod)).toEqual([
      { start: "2026-10-12T23:30:00+03:00", end: "2026-10-12T23:40:00+03:00", stage: "deep", minutes: 10 },
      { start: "2026-10-12T23:40:00+03:00", end: "2026-10-12T23:45:00+03:00", stage: "light", minutes: 5 },
      { start: "2026-10-12T23:45:00+03:00", end: "2026-10-12T23:50:00+03:00", stage: "rem", minutes: 5 },
      { start: "2026-10-12T23:50:00+03:00", end: "2026-10-12T23:55:00+03:00", stage: "awake", minutes: 5 },
    ]);
  });

  it("prefers the app-aligned phase string when present", () => {
    expect(hypnogram({ ...mainSleepPeriod, app_sleep_phase_5_min: "44" })).toEqual([
      expect.objectContaining({ stage: "awake", minutes: 10 }),
    ]);
  });

  it("downsamples series and skips gaps", () => {
    const series = compactSeries(mainSleepPeriod.heart_rate, 3);
    expect(series).toEqual({
      interval_s: 600,
      stats: { avg: 51.4, min: 46, max: 58 },
      points: [
        { t: "2026-10-12T23:30:00+03:00", v: 56.5 },
        { t: "2026-10-12T23:40:00+03:00", v: 50 },
        { t: "2026-10-12T23:50:00+03:00", v: 47 },
      ],
    });
  });

  it("includes readiness contributors, hypnogram and curves", () => {
    const detail = sleepPeriodDetail(mainSleepPeriod);
    expect(detail.readiness).toEqual({ score: 86, contributors: { hrv_balance: 77, recovery_index: 100 } });
    expect(detail.hypnogram).toHaveLength(4);
    expect(detail.heart_rate?.points).toHaveLength(5);
    expect(detail.hrv?.stats).toEqual({ avg: 58, min: 40, max: 70 });
  });

  it("picks the long sleep as the night's main sleep, ignoring rejected rest", () => {
    expect(mainSleep([nap, rejectedRest, mainSleepPeriod])?.id).toBe("sleep-main");
    expect(mainSleep([rejectedRest, nap])?.id).toBe("sleep-nap");
    expect(mainSleep([rejectedRest])).toBeUndefined();
  });
});

describe("heart rate", () => {
  it("aggregates samples into local-time buckets", () => {
    const buckets = aggregateHeartRate(heartRate, "day");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ avg_bpm: 81, min_bpm: 50, max_bpm: 150, samples: 4, source: "sleep" });
  });

  it("reports overall and per-source stats", () => {
    expect(heartRateStats(heartRate)).toEqual({
      avg_bpm: 81,
      min_bpm: 50,
      max_bpm: 150,
      samples: 4,
      by_source: {
        sleep: { avg_bpm: 52, min_bpm: 50, max_bpm: 54, samples: 2 },
        awake: { avg_bpm: 70, min_bpm: 70, max_bpm: 70, samples: 1 },
        workout: { avg_bpm: 150, min_bpm: 150, max_bpm: 150, samples: 1 },
      },
    });
    expect(heartRateStats([])).toBeUndefined();
  });

  it("handles month-long series without overflowing the stack", () => {
    const big = Array.from({ length: 300_000 }, (_, i) => ({
      timestamp: new Date(Date.UTC(2026, 9, 1) + i * 5000).toISOString(),
      bpm: 50 + (i % 50),
      source: "awake" as const,
    }));
    expect(heartRateStats(big)).toMatchObject({ min_bpm: 50, max_bpm: 99, samples: 300_000 });
  });
});
