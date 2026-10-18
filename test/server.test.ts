import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OuraClient } from "../src/client.js";
import { createServer, parseInstant, toDayRange } from "../src/server.js";
import { DAY, fakeFetch, json, ouraApi, staticTokens } from "./helpers.js";

async function connect(oura: OuraClient) {
  const server = createServer(oura, "test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (res.content[0] as { text: string }).text;
  return { isError: res.isError ?? false, text, data: res.isError ? undefined : JSON.parse(text) };
}

// Pin "today" to the fixture day (local noon, so any machine timezone agrees on the date).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 13, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

const api = (opts?: { deny?: string[] }) => {
  const fetch = ouraApi(opts);
  return { fetch, client: new OuraClient(staticTokens, { fetch }) };
};

describe("MCP server", () => {
  it("exposes only read-only tools", async () => {
    const client = await connect(api().client);
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_daily_overview",
      "get_heart_rate",
      "get_profile",
      "get_sleep_period",
      "get_trends",
      "list_daily_activity",
      "list_daily_health",
      "list_daily_readiness",
      "list_daily_sleep",
      "list_rest_mode_periods",
      "list_sessions",
      "list_sleep_periods",
      "list_tags",
      "list_workouts",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.description, tool.name).toBeTruthy();
    }
  });

  it("get_profile combines personal info, rings and battery", async () => {
    const client = await connect(api().client);
    const { data } = await call(client, "get_profile");

    expect(data.personal_info).toMatchObject({ age: 38, email: "me@example.com" });
    expect(data.rings).toEqual([expect.objectContaining({ hardware_type: "gen4", size: 10 })]);
    expect(data.battery).toEqual({ level_pct: 64, charging: false, as_of: "2026-10-13T09:00:00Z" });
    expect(data.sandbox).toBeUndefined();
  });

  it("get_daily_overview gathers the whole day", async () => {
    const client = await connect(api().client);
    const { data } = await call(client, "get_daily_overview", { date: DAY });

    expect(data.day).toBe(DAY);
    expect(data.readiness).toMatchObject({ score: 86, zone: "optimal" });
    expect(data.sleep).toMatchObject({ score: 68, zone: "pay_attention", main: { sleep_id: "sleep-main", asleep_h: 6.5 } });
    expect(data.sleep.naps.map((n: { sleep_id: string }) => n.sleep_id)).toEqual(["sleep-nap"]);
    expect(data.activity).toMatchObject({ score: 72, steps: 11234 });
    expect(data.stress).toEqual({ summary: "normal", stress_high_min: 90, recovery_high_min: 60 });
    expect(data.resilience.level).toBe("solid");
    expect(data.spo2).toEqual({ avg_pct: 96.5, breathing_disturbance_index: 4 });
    expect(data.cardiovascular_age).toBe(31);
    expect(data.vo2_max).toBe(49);
    expect(data.bedtime.optimal_bedtime).toBe("22:30-23:30");
    expect(data.workouts.map((w: { activity: string }) => w.activity)).toEqual(["running", "swimming"]);
    expect(data.sessions).toHaveLength(1);
    expect(data.tags).toHaveLength(2);
    expect(data.unavailable).toBeUndefined();
  });

  it("get_daily_overview defaults to the latest scored day", async () => {
    vi.setSystemTime(new Date(2026, 9, 14, 8, 0, 0)); // the next morning, before the ring synced
    const client = await connect(api().client);
    const { data } = await call(client, "get_daily_overview");
    expect(data.day).toBe(DAY);
  });

  it("skips data types the user didn't grant instead of failing", async () => {
    const client = await connect(api({ deny: ["daily_spo2", "daily_stress"] }).client);
    const { isError, data } = await call(client, "get_daily_overview", { date: DAY });

    expect(isError).toBe(false);
    expect(data.readiness.score).toBe(86);
    expect(data.spo2).toBeUndefined();
    expect(data.unavailable).toEqual(["daily_spo2 (403)", "daily_stress (403)"]);
  });

  it("explains an empty day", async () => {
    const client = await connect(api().client);
    const { data } = await call(client, "get_daily_overview", { date: "2026-01-01" });
    expect(data.message).toMatch(/No Oura data/);
  });

  it("get_trends builds a day table with averages", async () => {
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 0));
    const client = await connect(api().client);
    const { data } = await call(client, "get_trends", { days: 3 });

    expect(data.period).toEqual({ days: 3, from: "2026-10-12", to: "2026-10-14" });
    expect(data.days).toHaveLength(1);
    expect(data.days[0]).toMatchObject({
      day: DAY,
      readiness: 86,
      readiness_zone: "optimal",
      sleep_score: 68,
      asleep_h: 6.5,
      hrv_ms: 61,
      lowest_hr_bpm: 46,
      steps: 11234,
      stress_high_min: 90,
      resilience: "solid",
      workouts: ["running", "swimming"],
    });
    expect(data.days[0].in_progress).toBeUndefined();
    expect(data.averages.readiness).toEqual({ avg: 86, min: 86, max: 86, days: 1 });
    expect(data.averages.steps).toEqual({ avg: 11234, min: 11234, max: 11234, days: 1 });
    expect(data.readiness_zones).toEqual({ optimal: 1, good: 0, pay_attention: 0 });
    expect(data.total_workouts).toBe(2);
  });

  it("get_trends keeps today's partial activity out of the averages", async () => {
    const client = await connect(api().client);
    const { data } = await call(client, "get_trends", { days: 1 });
    expect(data.days[0].in_progress).toBe(true);
    expect(data.averages.steps).toBeNull();
    expect(data.averages.readiness.avg).toBe(86);
  });

  it("list tools summarize by default and return raw objects on request", async () => {
    const client = await connect(api().client);

    const readiness = await call(client, "list_daily_readiness", { days: 3 });
    expect(readiness.data.records[0]).toMatchObject({ day: DAY, score: 86, zone: "optimal" });

    const raw = await call(client, "list_daily_readiness", { days: 3, raw: true });
    expect(raw.data.records[0]).toHaveProperty("timestamp");

    const sleep = await call(client, "list_daily_sleep", { start: DAY, end: DAY });
    expect(sleep.data.records).toEqual([expect.objectContaining({ score: 68 })]);

    const act = await call(client, "list_daily_activity", { days: 1 });
    expect(act.data.records[0]).toMatchObject({ steps: 11234 });

    const sessions = await call(client, "list_sessions", {});
    expect(sessions.data.records[0]).toMatchObject({ type: "breathing", duration_min: 10, heart_rate_bpm: { avg: 66 } });
  });

  it("list_sleep_periods drops rejected rest periods and can drop naps", async () => {
    const client = await connect(api().client);
    const all = await call(client, "list_sleep_periods", {});
    expect(all.data.records.map((r: { sleep_id: string }) => r.sleep_id)).toEqual(["sleep-main", "sleep-nap"]);
    const main = await call(client, "list_sleep_periods", { include_naps: false });
    expect(main.data.records.map((r: { sleep_id: string }) => r.sleep_id)).toEqual(["sleep-main"]);
  });

  it("get_sleep_period returns the hypnogram and curves", async () => {
    const client = await connect(api().client);
    const { data } = await call(client, "get_sleep_period", { sleep_id: "sleep-main" });
    expect(data.hypnogram[0]).toMatchObject({ stage: "deep", minutes: 10 });
    expect(data.heart_rate.stats.min).toBe(46);

    const missing = await call(client, "get_sleep_period", { sleep_id: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/404/);
  });

  it("list_workouts filters by activity", async () => {
    const client = await connect(api().client);
    const { data } = await call(client, "list_workouts", { activity: "SWIM" });
    expect(data.records).toEqual([expect.objectContaining({ workout_id: "w-swim", distance_km: 1.5 })]);
  });

  it("list_daily_health joins per-day metrics", async () => {
    const client = await connect(api().client);
    const { data } = await call(client, "list_daily_health", { days: 7 });
    expect(data.records).toEqual([
      {
        day: DAY,
        stress: { summary: "normal", stress_high_min: 90, recovery_high_min: 60 },
        resilience: { level: "solid", contributors: { sleep_recovery: 70.5, daytime_recovery: 40.1, stress: 55 } },
        spo2: { avg_pct: 96.5, breathing_disturbance_index: 4 },
        cardiovascular_age: 31,
        vo2_max: 49,
        bedtime: { status: "optimal_found", recommendation: "follow_optimal_bedtime", optimal_bedtime: "22:30-23:30" },
      },
    ]);
  });

  it("list_tags merges classic and enhanced tags in time order", async () => {
    const client = await connect(api().client);
    const { data } = await call(client, "list_tags", { days: 1 });
    expect(data.records).toEqual([
      { day: DAY, time: "2026-10-13T20:00:00+03:00", tag: "tag_generic_alcohol", text: "2 glasses" },
      { day: DAY, time: "2026-10-13T21:00:00+03:00", tags: ["tag_generic_late_meal"], text: "late dinner" },
    ]);
  });

  it("list_rest_mode_periods defaults to the last 90 days", async () => {
    const { client: oura, fetch } = api();
    const client = await connect(oura);
    const { data } = await call(client, "list_rest_mode_periods");
    expect(data.records).toEqual([]);
    expect(fetch.calls[0].url.searchParams.get("start_date")).toBe("2026-07-15");
  });

  it("get_heart_rate aggregates and filters by source", async () => {
    const { client: oura, fetch } = api();
    const client = await connect(oura);
    const { data } = await call(client, "get_heart_rate", { start: DAY, end: DAY, resolution: "day", source: "sleep" });

    expect(data.stats).toMatchObject({ avg_bpm: 52, samples: 2 });
    expect(data.buckets).toHaveLength(1);
    const url = fetch.calls[0].url;
    expect(url.pathname).toBe("/v2/usercollection/heartrate");
    expect(url.searchParams.get("start_datetime")).toBe(new Date(2026, 9, 13).toISOString());
    expect(url.searchParams.get("end_datetime")).toBe(new Date(2026, 9, 14).toISOString());
  });

  it("get_heart_rate returns raw samples and the latest sample", async () => {
    const client = await connect(api().client);
    const raw = await call(client, "get_heart_rate", { resolution: "raw" });
    expect(raw.data.samples).toHaveLength(4);
    expect(raw.data.samples[0]).toEqual({ t: "2026-10-13T04:00:00Z", bpm: 50, source: "sleep" });

    const latest = await call(client, "get_heart_rate", { latest: true });
    expect(latest.data.latest).toMatchObject({ bpm: 150 });
  });

  it("get_heart_rate flags a range too big for one call", async () => {
    let page = 0;
    const fetch = fakeFetch(() =>
      json({ data: [{ timestamp: "2026-10-13T04:00:00Z", bpm: 50, source: "sleep" }], next_token: `page-${++page}` }),
    );
    const client = await connect(new OuraClient(staticTokens, { fetch, maxPages: 2 }));
    const hourly = await call(client, "get_heart_rate", {});
    expect(hourly.data.truncated).toBe(true);
    expect(hourly.data).not.toHaveProperty("next_token");
    const raw = await call(client, "get_heart_rate", { resolution: "raw" });
    expect(raw.data.truncated).toBe(true);
  });

  it("get_heart_rate refuses ranges over 30 days", async () => {
    const client = await connect(api().client);
    const res = await call(client, "get_heart_rate", { start: "2026-08-01", end: "2026-10-01" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/at most 30 days/);
  });

  it("reports invalid arguments as tool errors", async () => {
    const client = await connect(api().client);
    const bad = await call(client, "list_daily_sleep", { start: "2026-02-30" });
    expect(bad.isError).toBe(true);
    const reversed = await call(client, "list_daily_sleep", { start: "2026-10-12", end: "2026-10-10" });
    expect(reversed.text).toMatch(/start must be on or before end/);
  });

  it("marks sandbox data as such", async () => {
    const client = await connect(new OuraClient(staticTokens, { fetch: ouraApi(), sandbox: true }));
    const { data } = await call(client, "get_profile");
    expect(data.sandbox).toMatch(/sample data/);
  });
});

describe("argument parsing", () => {
  const now = new Date(2026, 9, 13, 12).getTime();

  it("turns days into an inclusive range ending today", () => {
    expect(toDayRange({ days: 7 }, now)).toEqual({ start: "2026-10-07", end: "2026-10-13", nextToken: undefined });
    expect(toDayRange({ days: 7, end: "2026-10-01" }, now)).toMatchObject({ start: "2026-09-25", end: "2026-10-01" });
    expect(toDayRange({ days: 7, start: "2026-10-10", next_token: "t" }, now)).toEqual({
      start: "2026-10-10",
      end: "2026-10-13",
      nextToken: "t",
    });
  });

  it("caps the range length", () => {
    expect(() => toDayRange({ days: 7, start: "2020-01-01", end: "2026-01-01" }, now)).toThrow(/at most 400 days/);
  });

  it("parses dates as local days and accepts ISO date-times", () => {
    expect(parseInstant("2026-10-13", "start")).toBe(new Date(2026, 9, 13).toISOString());
    expect(parseInstant("2026-10-13", "end")).toBe(new Date(2026, 9, 14).toISOString());
    expect(parseInstant("2026-10-13T05:00:00+03:00", "start")).toBe("2026-10-13T02:00:00.000Z");
    expect(() => parseInstant("2026-02-30", "start")).toThrow(/no such date/);
    expect(() => parseInstant("yesterday", "end")).toThrow(/Invalid end/);
  });
});
