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

/** Behavior shared by the day-range list tools; appended to their descriptions. */
const RANGE_NOTE =
  "Range: the last 7 days by default; set start and end (inclusive, YYYY-MM-DD) or days (up to 400, ignored when start is set). " +
  "Returns { records, next_token }, oldest first. Days without data are absent, and today's data appears only after the ring syncs. " +
  "If next_token is not null, call again with it for the rest. raw: true returns Oura's original objects.";

/** The same for tools that merge several data types and so return everything in one call. */
const MERGED_RANGE_NOTE =
  "Range: the last 7 days by default; set start and end (inclusive, YYYY-MM-DD) or days (up to 400, ignored when start is set). " +
  "Returns { records } oldest first, plus `unavailable` listing any data type the user didn't grant.";

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
        "Get the user's Oura profile and ring hardware: age, height, weight, biological sex and email; each ring's model, size, color, firmware and setup date; and the latest battery level with its timestamp. Use it for questions about the person or the device, or to put scores in context (e.g. age next to VO2 max or cardiovascular age). Takes no arguments. A part Oura won't share (scope not granted) comes back as an error field while the rest still returns.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    (_args, { signal }) =>
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
        "Get everything Oura recorded for one day in a single call: readiness (score, contributors, temperature deviation), sleep score and the night's main sleep (stages, HRV, lowest heart rate, efficiency), naps, activity (score, steps, calories), stress, resilience, SpO2, cardiovascular age, VO2 max, bedtime guidance, workouts, sessions and tags. Start here for 'today', 'last night' or any single date; use get_trends for multi-day questions and the list_* tools for one data type over a range. Omit date for the latest day with a sleep or readiness score. Data types the user didn't grant are listed under `unavailable` instead of failing the call.",
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
        "Summarize the last N days (default 14, up to 90, including today) as a day-by-day table plus avg/min/max for readiness, sleep and activity scores, sleep hours and stages, HRV, lowest heart rate, temperature deviation, steps, active calories and stress, with readiness-zone counts and workouts per day. Use it for week or month comparisons and 'how am I trending' questions; use get_daily_overview for a single day and the list_* tools for full detail on one data type. Days without data are omitted; today is flagged in_progress and its partial activity is left out of the averages.",
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
        "List daily readiness scores (0-100, with Oura's zone: optimal 85+, good 70-84, pay_attention below 70) and their contributors: HRV balance, resting heart rate, recovery index, body temperature, sleep balance, previous night, previous-day activity, activity balance and sleep regularity, plus temperature deviation from baseline in °C. Use it to see how readiness and its drivers changed over a range; for a single day use get_daily_overview, and for readiness next to sleep and activity use get_trends. " + RANGE_NOTE,
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
        "List daily sleep scores (0-100, with Oura's zone) and the contributors behind them: total sleep, efficiency, restfulness, REM, deep sleep, latency and timing. Use it for 'how well did I sleep' over a range; for hours, stages, HRV and heart rate use list_sleep_periods, and for one night's hypnogram use get_sleep_period. " + RANGE_NOTE,
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
        "List individual sleep periods (nights and, by default, naps) with bedtime, hours in bed and asleep, deep/REM/light/awake hours, latency, efficiency, average and lowest heart rate, average HRV, breathing rate and the readiness score each produced. Use it for sleep duration, stages and overnight HRV or heart rate across days; use list_daily_sleep for scores only, and pass a sleep_id to get_sleep_period for the full hypnogram. Periods the user rejected or deleted are left out, and each period belongs to the day the user woke up. " + RANGE_NOTE,
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
        "Get one sleep period in full detail by its sleep_id: the same summary as list_sleep_periods plus a hypnogram (deep/light/REM/awake segments at 5-minute resolution, in local time), heart-rate and HRV curves through the night (downsampled to at most 120 points, with avg/min/max), and the readiness contributors it produced. Use it to explain one specific night; get the id from list_sleep_periods or get_daily_overview first. An unknown id returns a 404 error; raw: true returns Oura's original object.",
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
        "List daily activity: activity score (0-100) and contributors, steps, active, total and target calories, walking-equivalent distance in km, minutes of high/medium/low activity, sedentary, resting and non-wear hours, and inactivity alerts. Use it for movement, step and calorie questions over a range; individual workouts are in list_workouts. An Oura activity day runs 4 a.m. to 4 a.m., so today's row is partial. " + RANGE_NOTE,
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
        "List workouts, auto-detected by the ring or added manually, with activity type, label, intensity (easy/moderate/hard), source, start and end time, duration in minutes, calories and distance in km. Use it for training questions such as 'how many runs this month'; narrow it with activity, a case-insensitive substring like 'run' or 'swim'. For whole-day movement use list_daily_activity, and for heart rate during a workout call get_heart_rate with its start and end and source 'workout'. " + RANGE_NOTE,
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
        "List mindfulness sessions recorded in the Oura app (meditation, breathing, relaxation, nap, rest, body status) with mood, start and end time, duration, and heart-rate and HRV stats (avg/min/max). Use it for questions about guided practice and how it affected heart rate or HRV; sleep is in list_sleep_periods and exercise in list_workouts. " + RANGE_NOTE,
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
        "List per-day health metrics joined by date: stress (day summary, minutes of high stress and high recovery), resilience level and contributors, average SpO2 and breathing disturbance index, cardiovascular age, VO2 max, and bedtime guidance (Oura's optimal bedtime window). Use it for stress, resilience, breathing and cardio-fitness trends; readiness, sleep and activity scores have their own list_* tools. Each field appears only on days Oura computed it (VO2 max and cardiovascular age update occasionally). " + MERGED_RANGE_NOTE,
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
        "List the tags and notes the user logged in the Oura app (e.g. alcohol, caffeine, late meal, sickness, travel, custom tags) with their time, end time if any, and comments, merging classic and enhanced tags into one list sorted by time. Use it to explain unusual readiness or sleep, then cross-check the tagged days with get_daily_overview or get_trends. " + MERGED_RANGE_NOTE,
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
      description:
        "List Rest Mode periods, which the user turns on when sick, injured or recovering, with start and end day (an ongoing period has no end) and the symptom tags logged during each. Use it to explain dips in readiness or activity, or to check whether the user was unwell on given days. Covers the last 90 days by default; set start and end (inclusive, YYYY-MM-DD) or days. A period that overlaps the range is included. Returns { records, next_token }; raw: true returns Oura's original objects.",
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
      description:
        `Get the heart-rate time series between two times, aggregated into buckets aligned to local time (5min, 15min, hour or day) with avg/min/max bpm and the dominant source, plus overall and per-source stats (awake, rest, sleep, workout, session, live). Use it for heart rate at particular times, during a workout or across a day; for overnight averages, lowest heart rate and HRV prefer list_sleep_periods. Defaults to the last 24 hours at hourly resolution; ranges are limited to ${MAX_HEART_RATE_DAYS} days per call. resolution 'raw' returns individual samples (the first ${MAX_RAW_SAMPLES}); latest: true returns only the most recent sample and ignores the other arguments. truncated: true means the range held more samples than one call fetches, so narrow it.`,
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
            truncated: samples.length > MAX_RAW_SAMPLES || res.next_token !== null || undefined,
          };
        }
        return {
          ...base,
          resolution,
          buckets: aggregateHeartRate(samples, resolution as Resolution),
          // There is no next_token input: a range too big for one call is narrowed instead.
          truncated: res.next_token !== null || undefined,
        };
      }),
  );

  return server;
}
