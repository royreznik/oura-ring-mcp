// Oura API v2 response shapes (https://cloud.ouraring.com/v2/docs), limited to what this server reads.
// Most fields are nullable in practice: Oura omits scores it hasn't computed yet.

/** Date-time strings carry the user's local offset, e.g. "2026-10-13T07:12:00+03:00". */
export type LocalDateTime = string;
/** Calendar day, YYYY-MM-DD. */
export type IsoDate = string;

export interface Sample {
  /** Seconds between items. */
  interval: number;
  items: (number | null)[];
  timestamp: LocalDateTime;
}

export interface PersonalInfo {
  id: string;
  age?: number | null;
  weight?: number | null;
  height?: number | null;
  biological_sex?: string | null;
  email?: string | null;
}

export type Contributors = Record<string, number | null>;

export interface DailyReadiness {
  id: string;
  day: IsoDate;
  score: number | null;
  temperature_deviation?: number | null;
  temperature_trend_deviation?: number | null;
  contributors: Contributors;
  timestamp: LocalDateTime;
}

export interface DailySleep {
  id: string;
  day: IsoDate;
  score: number | null;
  contributors: Contributors;
  timestamp: LocalDateTime;
}

export interface DailyActivity {
  id: string;
  day: IsoDate;
  score: number | null;
  active_calories: number;
  total_calories: number;
  target_calories: number;
  steps: number;
  equivalent_walking_distance: number;
  meters_to_target: number;
  target_meters: number;
  high_activity_time: number;
  medium_activity_time: number;
  low_activity_time: number;
  sedentary_time: number;
  resting_time: number;
  non_wear_time: number;
  inactivity_alerts: number;
  average_met_minutes: number;
  high_activity_met_minutes: number;
  medium_activity_met_minutes: number;
  low_activity_met_minutes: number;
  sedentary_met_minutes: number;
  class_5_min?: string | null;
  met?: Sample | null;
  contributors: Contributors;
  timestamp: LocalDateTime;
}

export type SleepType = "deleted" | "sleep" | "long_sleep" | "late_nap" | "rest";

export interface SleepPeriod {
  id: string;
  day: IsoDate;
  type: SleepType | null;
  period: number;
  bedtime_start: LocalDateTime;
  bedtime_end: LocalDateTime;
  /** All durations are in seconds. */
  time_in_bed: number;
  total_sleep_duration: number | null;
  awake_time: number | null;
  light_sleep_duration: number | null;
  deep_sleep_duration: number | null;
  rem_sleep_duration: number | null;
  latency: number | null;
  efficiency: number | null;
  restless_periods: number | null;
  average_breath: number | null;
  average_heart_rate: number | null;
  lowest_heart_rate: number | null;
  average_hrv: number | null;
  heart_rate?: Sample | null;
  hrv?: Sample | null;
  low_battery_alert?: boolean;
  readiness?: {
    score: number | null;
    temperature_deviation?: number | null;
    temperature_trend_deviation?: number | null;
    contributors: Contributors;
  } | null;
  readiness_score_delta?: number | null;
  sleep_score_delta?: number | null;
  movement_30_sec?: string | null;
  sleep_phase_5_min?: string | null;
  sleep_phase_30_sec?: string | null;
  app_sleep_phase_5_min?: string | null;
  sleep_algorithm_version?: string | null;
}

export interface Workout {
  id: string;
  day: IsoDate;
  activity: string;
  calories: number | null;
  /** Meters. */
  distance: number | null;
  intensity: "easy" | "moderate" | "hard";
  label: string | null;
  source: string;
  start_datetime: LocalDateTime;
  end_datetime: LocalDateTime;
}

export interface Session {
  id: string;
  day: IsoDate;
  type: string;
  mood: string | null;
  start_datetime: LocalDateTime;
  end_datetime: LocalDateTime;
  heart_rate?: Sample | null;
  heart_rate_variability?: Sample | null;
  motion_count?: Sample | null;
}

export interface DailyStress {
  id: string;
  day: IsoDate;
  day_summary: "restored" | "normal" | "stressful" | null;
  /** Seconds. */
  stress_high: number | null;
  /** Seconds. */
  recovery_high: number | null;
}

export interface DailyResilience {
  id: string;
  day: IsoDate;
  level: "limited" | "adequate" | "solid" | "strong" | "exceptional";
  contributors: { sleep_recovery: number; daytime_recovery: number; stress: number };
}

export interface DailySpO2 {
  id: string;
  day: IsoDate;
  spo2_percentage: { average: number | null } | null;
  breathing_disturbance_index: number | null;
}

export interface DailyCardiovascularAge {
  id: string;
  day: IsoDate;
  vascular_age: number | null;
  pulse_wave_velocity?: number | null;
}

export interface VO2Max {
  id: string;
  day: IsoDate;
  vo2_max: number | null;
  timestamp: LocalDateTime;
}

export interface SleepTime {
  id: string;
  day: IsoDate;
  optimal_bedtime: { day_tz: number; start_offset: number; end_offset: number } | null;
  recommendation: string | null;
  status: string | null;
}

export interface Tag {
  id: string;
  day: IsoDate;
  text: string | null;
  timestamp: string;
  tags: string[];
}

export interface EnhancedTag {
  id: string;
  tag_type_code: string | null;
  start_time: string;
  end_time: string | null;
  start_day: IsoDate;
  end_day: IsoDate | null;
  comment: string | null;
  custom_name: string | null;
}

export interface RestModePeriod {
  id: string;
  start_day: IsoDate;
  end_day: IsoDate | null;
  start_time: LocalDateTime | null;
  end_time: LocalDateTime | null;
  episodes: { tags: string[]; timestamp: LocalDateTime }[];
}

export interface RingConfiguration {
  id: string;
  color: string | null;
  design: string | null;
  firmware_version: string | null;
  hardware_type: string | null;
  set_up_at: string | null;
  size: number | null;
}

export interface HeartRateSample {
  /** UTC. */
  timestamp: string;
  bpm: number;
  source: "awake" | "workout" | "rest" | "sleep" | "live" | "session";
}

export interface BatteryLevelSample {
  timestamp: string;
  level: number;
  charging: boolean | null;
  in_charger: boolean | null;
}

export interface Page<T> {
  data: T[];
  next_token: string | null;
}

/** Day-keyed document collections, mapped to their element types. */
export interface DocumentTypes {
  daily_activity: DailyActivity;
  daily_cardiovascular_age: DailyCardiovascularAge;
  daily_readiness: DailyReadiness;
  daily_resilience: DailyResilience;
  daily_sleep: DailySleep;
  daily_spo2: DailySpO2;
  daily_stress: DailyStress;
  enhanced_tag: EnhancedTag;
  rest_mode_period: RestModePeriod;
  session: Session;
  sleep: SleepPeriod;
  sleep_time: SleepTime;
  tag: Tag;
  vO2_max: VO2Max;
  workout: Workout;
}

export type DocumentType = keyof DocumentTypes;

/** Time-series collections, queried by date-time instead of day. */
export interface TimeSeriesTypes {
  heartrate: HeartRateSample;
  ring_battery_level: BatteryLevelSample;
}

export type TimeSeriesType = keyof TimeSeriesTypes;
