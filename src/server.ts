import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DayRange, OuraClient } from "./client.js";
import {
  aggregateHeartRate,
  heartRateStats,
  isRealSleep,
  sleepPeriodDetail,
  summarizeActivity,
  summarizeDailySleep,
  summarizeEnhancedTag,
  summarizeHealth,
  summarizeReadiness,
  summarizeRestMode,
  summarizeSession,
  summarizeSleepPeriod,
  summarizeTag,
  summarizeWorkout,
  type Resolution,
} from "./format.js";
import { Collector, dailyOverview, orNull, trends } from "./insights.js";
import type { HeartRateSample } from "./types.js";
import { addDays, daysBetween, today } from "./util.js";

const INSTRUCTIONS = `Read-only access to the user's Oura Ring data (readiness, sleep, activity, stress, heart rate, workouts, tags).
- For "today", "last night" or one specific day, start with get_daily_overview.
- For "this week", "last month" or trend questions, use get_trends.
- Use the list_* tools for history of one data type, get_sleep_period for one night's hypnogram and heart-rate curve, and get_heart_rate for the heart-rate time series.
- Oura assigns a night's sleep to the day you wake up, and a day's activity runs from 4 a.m. to 4 a.m.
- Scores are 0-100: 85+ is optimal, 70-84 good, below 70 "pay attention" (Oura's own bands).
- HRV is the average RMSSD during sleep in ms; temperature deviation is relative to the user's baseline in °C.
- Data appears only after the ring syncs through the Oura app, so today's data may be missing or partial.
- A data type listed under "unavailable" was not granted on Oura's consent page or isn't supported for this account.`;

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses YYYY-MM-DD strictly: rejects dates like 2026-02-30 that Date would silently roll over. */
export function isRealDate(value: string): boolean {
  const m = DATE_ONLY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(0);
  check.setUTCFullYear(y, mo - 1, d);
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
}

const dateOnly = z.string().refine(isRealDate, "Use a real date in YYYY-MM-DD format");

const MAX_RANGE_DAYS = 400;

const rangeShape = {
  start: dateOnly.optional().describe("First day to include (YYYY-MM-DD)."),
  end: dateOnly.optional().describe("Last day to include (YYYY-MM-DD). Defaults to today."),
  days: z
    .number()
    .int()
    .min(1)
    .max(MAX_RANGE_DAYS)
    .default(7)
    .describe("Shortcut for start: the last N days up to end. Ignored when start is set."),
  next_token: z.string().optional().describe("Pass the next_token from a previous call to get the following records."),
  raw: z
    .boolean()
    .default(false)
    .describe("Return Oura's raw API objects instead of compact summaries with friendly units."),
};

interface RangeArgs {
  start?: string;
  end?: string;
  days: number;
  next_token?: string;
}

export function toDayRange(args: RangeArgs, now = Date.now()): DayRange {
  const end = args.end ?? today(now);
  const start = args.start ?? addDays(end, -(args.days - 1));
  if (start > end) throw new Error("start must be on or before end.");
  if (daysBetween(start, end) >= MAX_RANGE_DAYS) {
    throw new Error(`Ask for at most ${MAX_RANGE_DAYS} days at a time; use next_token or several calls for more.`);
  }
  return { start, end, nextToken: args.next_token };
}

async function respond(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn()) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
}

const MAX_HEART_RATE_DAYS = 30;
/** Raw heart-rate output beyond this many samples is truncated; aggregated output never is. */
const MAX_RAW_SAMPLES = 2000;

/** Converts a date (local midnight; an end date includes the whole day) or date-time into an ISO instant. */
export function parseInstant(value: string, kind: "start" | "end"): string {
  if (DATE_ONLY.test(value)) {
    if (!isRealDate(value)) throw new Error(`Invalid ${kind} "${value}": no such date.`);
    const [y, m, d] = value.split("-").map(Number) as [number, number, number];
    const local = new Date(2000, 0, 1);
    local.setFullYear(y, m - 1, kind === "end" ? d + 1 : d);
    return local.toISOString();
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Invalid ${kind} "${value}". Use YYYY-MM-DD or an ISO 8601 date-time.`);
  return new Date(ms).toISOString();
}

export function createServer(client: OuraClient, version = "0.0.0"): McpServer {
  const server = new McpServer({ name: "oura-ring-mcp", version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_profile",
    {
      title: "Get Oura profile",
      description:
        "The user's Oura profile (age, height, weight, biological sex, email), their ring(s) (model, size, color, firmware, setup date) and the latest ring battery level.",
      annotations: READ_ONLY,
    },
    ({ signal }) =>
      respond(async () => {
        const oura = client.withSignal(signal);
        const [info, rings, battery] = await Promise.all([
          orNull(oura.getPersonalInfo()).catch((err: Error) => ({ error: err.message })),
          oura.listRingConfigurations().catch((err: Error) => ({ error: err.message })),
          oura
            .timeSeries("ring_battery_level", { latest: true })
            .then((r) => r.data.at(-1) ?? null)
            .catch(() => null),
        ]);
        return {
          ...(client.sandbox ? { sandbox: "Oura sandbox sample data, not a real account." } : {}),
          personal_info: info,
          rings,
          battery: battery && {
            level_pct: battery.level,
            charging: battery.charging ?? undefined,
            as_of: battery.timestamp,
          },
        };
      }),
  );

  server.registerTool(
    "get_daily_overview",
    {
      title: "Daily overview",
      description:
        "Everything Oura has for one day: readiness (score, contributors, temperature), sleep score and last night's main sleep (stages, HRV, lowest HR, efficiency), naps, activity (score, steps, calories), stress, resilience, SpO2, cardiovascular age, VO2 max, bedtime guidance, workouts, sessions and tags. Omit date for the latest scored day.",
      inputSchema: {
        date: dateOnly
          .optional()
          .describe("Day to show (YYYY-MM-DD); a night's sleep belongs to the day you woke up. Defaults to the latest day."),
      },
      annotations: READ_ONLY,
    },
    ({ date }, { signal }) => respond(() => dailyOverview(client.withSignal(signal), date)),
  );

  server.registerTool(
    "get_trends",
    {
      title: "Trends",
      description:
        "Day-by-day table and averages (avg/min/max) over the last N days for readiness, sleep score, activity score, sleep hours and stages, HRV, lowest heart rate, temperature deviation, steps, active calories and stress, plus readiness zone counts and workouts per day.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(14).describe("How many days to look back, including today (1-90)."),
      },
      annotations: READ_ONLY,
    },
    ({ days }, { signal }) => respond(() => trends(client.withSignal(signal), days)),
  );

  server.registerTool(
    "list_daily_readiness",
    {
      title: "List daily readiness",
      description:
        "Daily readiness scores with contributors (HRV balance, resting heart rate, recovery index, body temperature, sleep balance, previous night, activity balance, sleep regularity) and temperature deviation.",
      inputSchema: rangeShape,
      annotations: READ_ONLY,
    },
    ({ raw, ...args }, { signal }) =>
      respond(async () => {
        const res = await client.withSignal(signal).documents("daily_readiness", toDayRange(args));
        return { records: raw ? res.data : res.data.map(summarizeReadiness), next_token: res.next_token };
      }),
  );

  server.registerTool(
    "list_daily_sleep",
    {
      title: "List daily sleep scores",
      description:
        "Daily sleep scores with contributors (total sleep, efficiency, restfulness, REM, deep sleep, latency, timing). For durations, stages, HRV and heart rate use list_sleep_periods.",
      inputSchema: rangeShape,
      annotations: READ_ONLY,
    },
    ({ raw, ...args }, { signal }) =>
      respond(async () => {
        const res = await client.withSignal(signal).documents("daily_sleep", toDayRange(args));
        return { records: raw ? res.data : res.data.map(summarizeDailySleep), next_token: res.next_token };
      }),
  );

  server.registerTool(
    "list_sleep_periods",
    {
      title: "List sleep periods",
      description:
        "Detailed sleep periods (nights and naps): bedtime, time asleep, deep/REM/light/awake hours, latency, efficiency, average and lowest heart rate, average HRV, breathing rate and the readiness they produced.",
      inputSchema: {
        ...rangeShape,
        include_naps: z.boolean().default(true).describe("Set false to return only long (main) sleeps."),
      },
      annotations: READ_ONLY,
    },
    ({ raw, include_naps, ...args }, { signal }) =>
      respond(async () => {
        const res = await client.withSignal(signal).documents("sleep", toDayRange(args));
        const records = res.data.filter((s) => isRealSleep(s) && (include_naps || s.type === "long_sleep"));
        return { records: raw ? records : records.map(summarizeSleepPeriod), next_token: res.next_token };
      }),
  );

  server.registerTool(
    "get_sleep_period",
    {
      title: "Get sleep period",
      description:
        "One sleep period by id with its hypnogram (stage segments in 5-minute resolution), heart-rate and HRV curves through the night, and readiness contributors.",
      inputSchema: {
        sleep_id: z.string().min(1).max(200).describe("Sleep period id (from list_sleep_periods or get_daily_overview)."),
        raw: rangeShape.raw,
      },
      annotations: READ_ONLY,
    },
    ({ sleep_id, raw }, { signal }) =>
      respond(async () => {
        const sleep = await client.withSignal(signal).getDocument("sleep", sleep_id);
        return raw ? sleep : sleepPeriodDetail(sleep);
      }),
  );

  server.registerTool(
    "list_daily_activity",
    {
      title: "List daily activity",
      description:
        "Daily activity: activity score and contributors, steps, active/total/target calories, walking-equivalent distance, minutes of high/medium/low activity, sedentary and resting hours, inactivity alerts. Days run 4 a.m. to 4 a.m.",
      inputSchema: rangeShape,
      annotations: READ_ONLY,
    },
    ({ raw, ...args }, { signal }) =>
      respond(async () => {
        const res = await client.withSignal(signal).documents("daily_activity", toDayRange(args));
        return { records: raw ? res.data : res.data.map(summarizeActivity), next_token: res.next_token };
      }),
  );

  server.registerTool(
    "list_workouts",
    {
      title: "List workouts",
      description:
        "Workouts (auto-detected and manually added): activity, intensity, start/end, duration, calories and distance.",
      inputSchema: {
        ...rangeShape,
        activity: z
          .string()
          .max(100)
          .optional()
          .describe('Only return workouts whose activity contains this text (case-insensitive), e.g. "running".'),
      },
      annotations: READ_ONLY,
    },
    ({ raw, activity, ...args }, { signal }) =>
      respond(async () => {
        const res = await client.withSignal(signal).documents("workout", toDayRange(args));
        const needle = activity?.toLowerCase();
        const records = needle ? res.data.filter((w) => w.activity.toLowerCase().includes(needle)) : res.data;
        return { records: raw ? records : records.map(summarizeWorkout), next_token: res.next_token };
      }),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      description:
        "Guided and unguided sessions recorded in the Oura app (meditation, breathing, relaxation, naps, rest, body status) with mood, duration, heart rate and HRV.",
      inputSchema: rangeShape,
      annotations: READ_ONLY,
    },
    ({ raw, ...args }, { signal }) =>
      respond(async () => {
        const res = await client.withSignal(signal).documents("session", toDayRange(args));
        return { records: raw ? res.data : res.data.map(summarizeSession), next_token: res.next_token };
      }),
  );

  server.registerTool(
    "list_daily_health",
    {
      title: "List daily health metrics",
      description:
        "Per-day health metrics joined by date: stress (summary, minutes of high stress and high recovery), resilience level, average SpO2 and breathing disturbance index, cardiovascular age, VO2 max, and bedtime guidance (optimal bedtime window).",
      inputSchema: {
        start: rangeShape.start,
        end: rangeShape.end,
        days: rangeShape.days,
      },
      annotations: READ_ONLY,
    },
    (args, { signal }) =>
      respond(async () => {
        const range = toDayRange(args);
        const c = new Collector(client.withSignal(signal));
        const [stress, resilience, spo2, cardio, vo2, sleepTime] = await Promise.all([
          c.docs("daily_stress", range),
          c.docs("daily_resilience", range),
          c.docs("daily_spo2", range),
          c.docs("daily_cardiovascular_age", range),
          c.docs("vO2_max", range),
          c.docs("sleep_time", range),
        ]);
        const find = <T extends { day: string }>(docs: T[], day: string) => docs.find((d) => d.day === day);
        const days = new Set([...stress, ...resilience, ...spo2, ...cardio, ...vo2, ...sleepTime].map((d) => d.day));
        const records = [...days].sort().map((day) =>
          summarizeHealth(day, {
            stress: find(stress, day),
            resilience: find(resilience, day),
            spo2: find(spo2, day),
            cardiovascular: find(cardio, day),
            vo2max: find(vo2, day),
            sleepTime: find(sleepTime, day),
          }),
        );
        return { records, ...c.report() };
      }),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description:
        "Tags and notes the user added in the Oura app (e.g. alcohol, caffeine, sickness, travel, custom tags), with their times and comments.",
      inputSchema: { start: rangeShape.start, end: rangeShape.end, days: rangeShape.days },
      annotations: READ_ONLY,
    },
    (args, { signal }) =>
      respond(async () => {
        const range = toDayRange(args);
        const c = new Collector(client.withSignal(signal));
        const [tags, enhanced] = await Promise.all([c.docs("tag", range), c.docs("enhanced_tag", range)]);
        const records = [...tags.map(summarizeTag), ...enhanced.map(summarizeEnhancedTag)].sort((a, b) =>
          String(a.time).localeCompare(String(b.time)),
        );
        return { records, ...c.report() };
      }),
  );

  server.registerTool(
    "list_rest_mode_periods",
    {
      title: "List rest mode periods",
      description: "Periods when the user turned on Rest Mode (e.g. while sick or recovering), with the symptom tags logged.",
      inputSchema: {
        start: rangeShape.start,
        end: rangeShape.end,
        days: z.number().int().min(1).max(MAX_RANGE_DAYS).default(90).describe("The last N days up to end. Ignored when start is set."),
        raw: rangeShape.raw,
      },
      annotations: READ_ONLY,
    },
    ({ raw, ...args }, { signal }) =>
      respond(async () => {
        const res = await client.withSignal(signal).documents("rest_mode_period", toDayRange(args));
        return { records: raw ? res.data : res.data.map(summarizeRestMode), next_token: res.next_token };
      }),
  );

  server.registerTool(
    "get_heart_rate",
    {
      title: "Get heart rate",
      description: `Heart-rate time series (daytime, sleep, workouts, sessions) aggregated into buckets with avg/min/max bpm, plus overall and per-source stats. Covers at most ${MAX_HEART_RATE_DAYS} days per call.`,
      inputSchema: {
        start: z
          .string()
          .optional()
          .describe("Start: a date (YYYY-MM-DD, local midnight) or ISO 8601 date-time. Defaults to 24 hours ago."),
        end: z
          .string()
          .optional()
          .describe("End: a date (includes that whole day) or ISO 8601 date-time. Defaults to now."),
        resolution: z
          .enum(["raw", "5min", "15min", "hour", "day"])
          .default("hour")
          .describe(`Bucket size. "raw" returns individual samples (truncated after ${MAX_RAW_SAMPLES}).`),
        source: z
          .enum(["awake", "rest", "sleep", "workout", "session", "live"])
          .optional()
          .describe("Only include samples recorded in this context."),
        latest: z.boolean().default(false).describe("Return only the most recent sample; other arguments are ignored."),
      },
      annotations: READ_ONLY,
    },
    ({ start, end, resolution, source, latest }, { signal }) =>
      respond(async () => {
        const oura = client.withSignal(signal);
        if (latest) {
          const res = await oura.timeSeries("heartrate", { latest: true });
          return { latest: res.data.at(-1) ?? null };
        }
        const now = Date.now();
        const endIso = end ? parseInstant(end, "end") : new Date(now).toISOString();
        const startIso = start ? parseInstant(start, "start") : new Date(Date.parse(endIso) - 86_400_000).toISOString();
        if (startIso >= endIso) throw new Error("start must be before end.");
        if (Date.parse(endIso) - Date.parse(startIso) > MAX_HEART_RATE_DAYS * 86_400_000) {
          throw new Error(`Ask for at most ${MAX_HEART_RATE_DAYS} days of heart rate at a time.`);
        }
        const res = await oura.timeSeries("heartrate", { start: startIso, end: endIso });
        const samples: HeartRateSample[] = source ? res.data.filter((s) => s.source === source) : res.data;
        const base = { from: startIso, to: endIso, stats: heartRateStats(samples) ?? null };
        if (resolution === "raw") {
          return {
            ...base,
            samples: samples.slice(0, MAX_RAW_SAMPLES).map((s) => ({ t: s.timestamp, bpm: s.bpm, source: s.source })),
            truncated: samples.length > MAX_RAW_SAMPLES || undefined,
            next_token: res.next_token,
          };
        }
        return { ...base, resolution, buckets: aggregateHeartRate(samples, resolution as Resolution), next_token: res.next_token };
      }),
  );

  return server;
}
