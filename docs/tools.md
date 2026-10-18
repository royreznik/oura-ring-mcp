# Tool reference

All tools are read-only (`readOnlyHint: true`). Times are shown with the offset Oura recorded (your local time when the data was captured). Durations are hours (`_h`) or minutes (`_min`), distances in km, energy in kcal.

Concepts:

- **Day.** A night's sleep belongs to the day you wake up. Daily activity runs 4 a.m. to 4 a.m.
- **Scores** (readiness, sleep, activity) are 0-100. `zone` uses Oura's bands: `optimal` (85+), `good` (70-84), `pay_attention` (<70).
- **HRV** is the average RMSSD during sleep, in ms. **Temperature deviation** is relative to your baseline, in °C.
- **unavailable** lists data types Oura refused (`403`: not granted on the consent page or no membership; `426`: app update needed). The rest of the answer is still returned.

## Common arguments for list tools

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `start` | `YYYY-MM-DD` | `end - days + 1` | First day, inclusive |
| `end` | `YYYY-MM-DD` | today | Last day, inclusive |
| `days` | 1-400 | 7 | Shortcut for `start` |
| `next_token` | string | | Continue a previous call that returned `next_token` |
| `raw` | boolean | false | Return Oura's original objects |

## get_daily_overview

`date?: YYYY-MM-DD` (defaults to the latest day with a sleep or readiness score).

```json
{
  "day": "2026-10-13",
  "readiness": { "score": 86, "zone": "optimal", "temperature_deviation_c": -0.12, "contributors": { "hrv_balance": 77, "resting_heart_rate": 95 } },
  "sleep": {
    "score": 68, "zone": "pay_attention", "contributors": { "total_sleep": 55, "rem_sleep": 60 },
    "main": { "sleep_id": "…", "bedtime_start": "2026-10-12T23:30:00+03:00", "asleep_h": 6.5, "deep_h": 1.5, "rem_h": 1.5, "efficiency_pct": 90, "lowest_hr_bpm": 46, "avg_hrv_ms": 61 },
    "naps": []
  },
  "activity": { "score": 72, "steps": 11234, "active_kcal": 612, "high_activity_min": 30 },
  "stress": { "summary": "normal", "stress_high_min": 90, "recovery_high_min": 60 },
  "resilience": { "level": "solid", "contributors": { "sleep_recovery": 70.5, "daytime_recovery": 40.1, "stress": 55 } },
  "spo2": { "avg_pct": 96.5, "breathing_disturbance_index": 4 },
  "cardiovascular_age": 31,
  "vo2_max": 49,
  "bedtime": { "status": "optimal_found", "recommendation": "follow_optimal_bedtime", "optimal_bedtime": "22:30-23:30" },
  "workouts": [{ "activity": "running", "duration_min": 46, "calories_kcal": 512, "distance_km": 8.12, "intensity": "hard" }],
  "sessions": [],
  "tags": [{ "time": "2026-10-13T20:00:00+03:00", "tag": "tag_generic_alcohol", "text": "2 glasses" }]
}
```

## get_trends

`days: 1-90` (default 14), counting today. Returns `period`, `averages` (each `{avg, min, max, days}`), `readiness_zones`, `total_workouts` and `days` (one row per day with data). Today's row has `in_progress: true`, and its steps, calories and stress are left out of the averages.

## get_profile

Personal info, `rings` (hardware, size, color, design, firmware, setup date) and `battery` (`level_pct`, `charging`, `as_of`).

## list_daily_readiness / list_daily_sleep / list_daily_activity

Day-keyed score documents with contributors. Activity adds steps, calories, walking-equivalent km, activity minutes by intensity, sedentary/resting/non-wear hours and inactivity alerts.

## list_sleep_periods

Extra argument `include_naps` (default true). Periods Oura marked as `rest` (a nap you rejected) or `deleted` are always dropped. `type` is `long_sleep` (a night), `sleep` (short confirmed nap) or `late_nap` (counts toward the next day).

## get_sleep_period

`sleep_id` from `list_sleep_periods` or `get_daily_overview`. Adds:

- `hypnogram`: `[{start, end, stage: deep|light|rem|awake, minutes}]`
- `heart_rate`, `hrv`: `{interval_s, stats: {avg, min, max}, points: [{t, v}]}` downsampled to at most 120 points
- `readiness`: the readiness score and contributors this sleep produced

## list_workouts

Extra argument `activity` (case-insensitive substring, e.g. `"run"`). Returns activity, label, intensity, source (`autodetected`, `confirmed`, `manual`, ...), start/end, duration, calories, distance.

## list_sessions

Meditation, breathing, relaxation, nap, rest and body-status sessions with mood, duration and heart-rate / HRV stats.

## list_daily_health

`start`, `end`, `days`. One row per day joining stress, resilience, SpO2, cardiovascular age, VO2 max and bedtime guidance.

## list_tags

`start`, `end`, `days`. Classic tags (`tags`, `text`) and enhanced tags (`tag`, `text`, optional `end`), sorted by time.

## list_rest_mode_periods

Defaults to the last 90 days. Each period has `start_day`, `end_day` (or `ongoing: true`) and `episodes` with the symptom tags logged.

## get_heart_rate

| Argument | Default | Meaning |
| --- | --- | --- |
| `start` | 24h before `end` | Date (local midnight) or ISO date-time |
| `end` | now | Date (whole day included) or ISO date-time |
| `resolution` | `hour` | `5min`, `15min`, `hour`, `day` or `raw` (max 2000 samples) |
| `source` | all | `awake`, `rest`, `sleep`, `workout`, `session`, `live` |
| `latest` | false | Only the most recent sample |

Range is limited to 30 days per call. Buckets are aligned to local wall-clock time: `{start, avg_bpm, min_bpm, max_bpm, samples, source}`. `stats` has overall and `by_source` avg/min/max.
