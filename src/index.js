// Garmin Personal API extension for Claude Desktop (MCP Bundle).
// Read-only bridge to Garmin's official Connect Personal API.
// Unofficial project by Garmin School; not affiliated with Garmin.
//
// The key is supplied by Claude Desktop via the GARMIN_PERSONAL_API_KEY env var
// (stored in the OS keychain because the manifest marks it "sensitive").
// It never leaves this machine except to call Garmin.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "1.0.1";
const BASE = (process.env.GARMIN_PERSONAL_API_BASE || "https://personal.connectapi.garmin.com").replace(/\/$/, "");
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const API_KEY = (process.env.GARMIN_PERSONAL_API_KEY || "").trim();
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 150_000;
const ARRAY_LIMIT = 30; // arrays longer than this are summarised unless detail=true

const log = (...a) => console.error("[garmin-personal-api]", ...a); // stdout is reserved for MCP

const KEY_HELP =
  "Create a new key in Garmin Connect on the web (Settings → Personal API Key), then in Claude Desktop open " +
  "Settings → Extensions → Garmin Personal API → Configure, paste the new key and save.";

class UserError extends Error {}

// ---------------------------------------------------------------- auth

let cachedToken = null; // { token, expiresAt (ms) }

function jwtExpiryMs(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function getToken(force = false) {
  if (!API_KEY) throw new UserError("No Personal API key is configured. " + KEY_HELP);
  const oneHour = 60 * 60 * 1000;
  if (!force && cachedToken && cachedToken.expiresAt - Date.now() > oneHour) return cachedToken.token;

  const res = await fetch(BASE + TOKEN_PATH, {
    method: "POST",
    // Only the Authorization header, exactly like Garmin's documented curl example.
    // v1.0.0 also sent "Accept: application/json" and a custom User-Agent and got HTTP 406.
    headers: { Authorization: `ApiKey ${API_KEY}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new UserError("Garmin rejected the Personal API key: it may have expired or been deleted. " + KEY_HELP);
  }
  if (!res.ok) {
    log("token request failed:", res.status, res.headers.get("content-type"), text.slice(0, 500));
    throw new UserError(`Step 1 (getting an access token) failed with HTTP ${res.status}. Garmin said: ${text.slice(0, 300) || "(empty response)"}`);
  }

  // Accept the token in whichever shape Garmin returns it.
  let token = null;
  let expiresIn = null;
  try {
    const body = JSON.parse(text);
    if (typeof body === "string") token = body;
    else {
      token = body.access_token ?? body.accessToken ?? body.token ?? null;
      expiresIn = body.expires_in ?? body.expiresIn ?? null;
    }
  } catch {
    token = text.trim();
  }
  if (!token) throw new UserError("Garmin returned an unexpected token response.");

  const expiresAt = jwtExpiryMs(token) ?? (expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 23 * oneHour);
  cachedToken = { token, expiresAt };
  log("obtained access token, expires", new Date(expiresAt).toISOString());
  return token;
}

// ---------------------------------------------------------------- http

async function garminGet(path, params = {}, { retried = false } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));

  const token = await getToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 401 && !retried) {
    log("401 on", path, "- refreshing token and retrying once");
    await getToken(true);
    return garminGet(path, params, { retried: true });
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new UserError("Garmin refused access. " + KEY_HELP);
  if (res.status === 404) throw new UserError("Garmin returned 'not found': this data isn't available through the Personal API, or there is no data for that day.");
  if (res.status === 429) throw new UserError("Garmin is rate-limiting requests right now. Wait a few minutes and try again, or ask for a shorter date range.");
  if (res.status === 400) throw new UserError(`Garmin rejected the request (HTTP 400). Check the dates and range limits. Details: ${text.slice(0, 300)}`);
  if (!res.ok) {
    log("data request failed:", path, res.status, res.headers.get("content-type"), text.slice(0, 500));
    throw new UserError(`Step 2 (reading ${path}) failed with HTTP ${res.status}. Garmin said: ${text.slice(0, 300) || "(empty response)"}`);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------- output shaping

// Long per-minute/per-sample arrays (heart rate, sleep stages, stress and Body
// Battery timelines) can overwhelm a conversation. By default they are replaced
// by a short note. "Sample" arrays are long lists of numbers, numeric tuples or
// tiny records (<= 4 fields); lists of full records such as days or activities
// are always kept.
function isSampleArray(arr) {
  if (arr.length <= ARRAY_LIMIT) return false;
  return arr.slice(0, 50).every(
    (el) => el === null || typeof el !== "object" || Array.isArray(el) || Object.keys(el).length <= 4
  );
}

function compact(value) {
  if (Array.isArray(value)) {
    if (isSampleArray(value)) {
      return { _omitted: `${value.length} samples omitted to keep the answer short; call again with detail=true to include them` };
    }
    return value.map(compact);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = compact(v);
    return out;
  }
  return value;
}

function toResult(data, detail) {
  if (data === null || data === undefined) return { content: [{ type: "text", text: "No data returned by Garmin for this request." }] };
  const shaped = detail ? data : compact(data);
  let text = typeof shaped === "string" ? shaped : JSON.stringify(shaped, null, 1);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + `\n…[truncated at ${MAX_OUTPUT_CHARS} characters; use a shorter date range${detail ? " or detail=false" : ""}]`;
  }
  return { content: [{ type: "text", text }] };
}

function toError(err) {
  const msg =
    err instanceof UserError
      ? err.message
      : err?.name === "TimeoutError"
        ? "Garmin didn't respond in time. Try again in a moment."
        : `Unexpected error talking to Garmin: ${err?.message || err}`;
  if (!(err instanceof UserError)) log(err);
  return { isError: true, content: [{ type: "text", text: msg }] };
}

// ---------------------------------------------------------------- dates

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time
const dateArg = (what) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional().describe(`${what} (YYYY-MM-DD, local date). Defaults to today.`);
const detailArg = z.boolean().optional().describe("Include long per-sample arrays (minute-level data). Default false.");

function range(start, end, maxDays) {
  const e = end || today();
  const s = start || e;
  const days = Math.round((Date.parse(e) - Date.parse(s)) / 86_400_000) + 1;
  if (Number.isNaN(days)) throw new UserError("Dates must be in YYYY-MM-DD format.");
  if (days < 1) throw new UserError("start_date must be on or before end_date.");
  if (maxDays && days > maxDays) throw new UserError(`Garmin allows at most ${maxDays} days per request for this data. Split the range into smaller chunks.`);
  return [s, e];
}

// ---------------------------------------------------------------- server

const server = new McpServer(
  { name: "garmin-personal-api", version: VERSION },
  {
    instructions:
      "Read-only access to the user's own Garmin Connect data via Garmin's official Personal API. " +
      "Dates are YYYY-MM-DD in the user's local time. Prefer the *_range tools over many single-day calls. " +
      "Sleep data is attributed to the morning the user woke up. Overnight respiration, resting heart rate and sleep stress " +
      "usually appear inside the sleep response; resting heart rate also appears in daily summaries. " +
      "This API cannot create, schedule or send workouts, and does not expose training readiness, training status, " +
      "training load, VO2max, badges or gear. Say so plainly if asked. This is not medical advice.",
  }
);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function tool(name, title, description, schema, handler) {
  server.registerTool(name, { title, description, inputSchema: schema, annotations: { ...RO, title } }, async (args) => {
    try {
      const { data, detail } = await handler(args || {});
      return toResult(data, detail);
    } catch (err) {
      return toError(err);
    }
  });
}

tool("check_connection", "Check Garmin connection",
  "Verify the Personal API key works and return basic profile settings (units, time zone). Use this first if anything fails.",
  {},
  async () => ({ data: { status: "connected", profile: await garminGet("/userprofile-service/userprofile/settings") } }));

tool("get_sleep", "Sleep for one night",
  "Detailed sleep for one night: duration, stages, sleep score and feedback, and usually overnight respiration, resting heart rate, SpO2 and sleep stress. The date is the morning you woke up.",
  { date: dateArg("Wake-up date"), detail: detailArg },
  async ({ date, detail }) => ({ data: await garminGet("/sleep-service/sleep/dailySleep", { date: date || today() }), detail }));

tool("get_sleep_range", "Sleep over several nights",
  "Sleep summaries for a range of nights (max 31 days). Good for trends and weekly reviews.",
  { start_date: dateArg("First wake-up date"), end_date: dateArg("Last wake-up date"), detail: detailArg },
  async ({ start_date, end_date, detail }) => {
    const [s, e] = range(start_date, end_date, 31);
    return { data: await garminGet("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: s, endDate: e }), detail };
  });

tool("get_hrv", "HRV for one night",
  "Overnight heart rate variability for one night: nightly average, 7-day average, baseline and HRV status.",
  { date: dateArg("Wake-up date"), detail: detailArg },
  async ({ date, detail }) => ({ data: await garminGet(`/hrv-service/hrv/${date || today()}`), detail }));

tool("get_hrv_range", "HRV over several nights",
  "Daily HRV summaries for a date range. Use for HRV trends and baseline comparisons.",
  { start_date: dateArg("Start date"), end_date: dateArg("End date") },
  async ({ start_date, end_date }) => {
    const [s, e] = range(start_date, end_date);
    return { data: await garminGet(`/hrv-service/hrv/daily/${s}/${e}`) };
  });

tool("get_daily_summaries", "Daily summaries",
  "Per-day totals for a range (up to one year): resting heart rate, steps, calories, intensity minutes, stress, Body Battery, floors and more.",
  { start_date: dateArg("Start date"), end_date: dateArg("End date") },
  async ({ start_date, end_date }) => {
    const [s, e] = range(start_date, end_date, 366);
    return { data: await garminGet("/usersummary-service/v2/dailysummaries", { startDate: s, endDate: e }) };
  });

tool("get_heart_rate", "Heart rate for one day",
  "All-day heart rate for one day: resting, min, max, and (with detail=true) the full sample timeline.",
  { date: dateArg("Date"), detail: detailArg },
  async ({ date, detail }) => ({ data: await garminGet("/wellness-service/wellness/dailyHeartRate", { date: date || today() }), detail }));

tool("get_spo2", "Blood oxygen (SpO2)",
  "Pulse Ox / SpO2 for one day, including sleep averages and altitude acclimation where available.",
  { date: dateArg("Date"), detail: detailArg },
  async ({ date, detail }) => ({ data: await garminGet(`/wellness-service/wellness/daily/spo2acclimation/${date || today()}`), detail }));

tool("get_body_battery", "Body Battery",
  "Body Battery reports per day for a date range: charged, drained, highest and lowest values.",
  { start_date: dateArg("Start date"), end_date: dateArg("End date"), detail: detailArg },
  async ({ start_date, end_date, detail }) => {
    const [s, e] = range(start_date, end_date);
    return { data: await garminGet("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: s, endDate: e }), detail };
  });

tool("get_stress", "Stress per day",
  "Daily stress levels for a date range (max 28 days).",
  { start_date: dateArg("Start date"), end_date: dateArg("End date") },
  async ({ start_date, end_date }) => {
    const [s, e] = range(start_date, end_date, 28);
    return { data: await garminGet(`/usersummary-service/stats/stress/daily/${s}/${e}`) };
  });

tool("get_steps", "Steps per day",
  "Daily step counts and step goals for a date range (max 28 days).",
  { start_date: dateArg("Start date"), end_date: dateArg("End date") },
  async ({ start_date, end_date }) => {
    const [s, e] = range(start_date, end_date, 28);
    return { data: await garminGet(`/usersummary-service/stats/steps/daily/${s}/${e}`) };
  });

tool("search_activities", "Find activities",
  "List recorded activities (runs, rides, strength, etc.), newest first, with key stats. Use the returned activityId with get_activity.",
  {
    start_date: dateArg("Only activities on or after this date").describe("Only activities on or after this date (YYYY-MM-DD). Optional."),
    end_date: dateArg("Only activities on or before this date").describe("Only activities on or before this date (YYYY-MM-DD). Optional."),
    activity_type: z.string().optional().describe("Garmin activity type key, e.g. running, cycling, strength_training, lap_swimming. Optional."),
    limit: z.number().int().min(1).max(100).optional().describe("How many activities to return (1-100). Default 20."),
    start: z.number().int().min(0).optional().describe("Offset for paging. Default 0."),
  },
  async ({ start_date, end_date, activity_type, limit, start }) => ({
    data: await garminGet("/activitylist-service/activities/search/activities", {
      start: start ?? 0, limit: limit ?? 20, startDate: start_date, endDate: end_date, activityType: activity_type,
    }),
  }));

tool("get_activity", "Activity details",
  "Full details for one activity: distance, pace/speed, heart rate, power, cadence, training effect, elevation and more.",
  { activity_id: z.number().int().positive().describe("activityId from search_activities"), detail: detailArg },
  async ({ activity_id, detail }) => ({ data: await garminGet(`/activity-service/activity/${activity_id}`), detail }));

tool("get_activity_workouts", "Planned workout for an activity",
  "The structured workout (steps and targets) that was followed during an activity, if any.",
  { activity_id: z.number().int().positive().describe("activityId from search_activities") },
  async ({ activity_id }) => ({ data: await garminGet(`/activity-service/activity/${activity_id}/workouts`) }));

tool("get_weight", "Weight and body composition",
  "Weight measurements (and body composition from a smart scale, if any) for a date range, plus active weight goals.",
  { start_date: dateArg("Start date"), end_date: dateArg("End date") },
  async ({ start_date, end_date }) => {
    const [s, e] = range(start_date, end_date);
    const [measurements, goals] = await Promise.all([
      garminGet(`/weight-service/weight/range/${s}/${e}`, { includeAll: "true" }),
      garminGet(`/goal-service/goal/user/effective/weightgoal/${s}/${e}`).catch(() => null),
    ]);
    return { data: { measurements, goals } };
  });

tool("get_fitness_age", "Fitness age",
  "Garmin Fitness Age for a date, with the factors that drive it.",
  { date: dateArg("Date") },
  async ({ date }) => ({ data: await garminGet(`/fitnessage-service/fitnessage/v2/${date || today()}`) }));

tool("get_hydration", "Hydration",
  "Logged fluid intake per day for a date range.",
  { start_date: dateArg("Start date"), end_date: dateArg("End date") },
  async ({ start_date, end_date }) => {
    const [s, e] = range(start_date, end_date, 28);
    return { data: await garminGet(`/usersummary-service/stats/hydration/daily/${s}/${e}`) };
  });

tool("get_food_log", "Food log",
  "Foods and meals logged in Garmin Connect for one day, with calories and macros.",
  { date: dateArg("Date") },
  async ({ date }) => ({ data: await garminGet(`/nutrition-service/food/logs/${date || today()}`) }));

tool("get_heart_rate_zones", "Heart rate zones",
  "The heart rate zone settings saved in Garmin Connect, per sport.",
  {},
  async () => ({ data: await garminGet("/biometric-service/heartRateZones/v2") }));

tool("get_menstrual_cycle", "Menstrual cycle",
  "Menstrual cycle summary and day view for a date, if cycle tracking is set up in Garmin Connect.",
  { date: dateArg("Date") },
  async ({ date }) => {
    const d = date || today();
    const [summary, day] = await Promise.all([
      garminGet(`/periodichealth-service/menstrualcycle/summary/${d}`),
      garminGet(`/periodichealth-service/menstrualcycle/dayview/${d}`, { todayDate: today() }).catch(() => null),
    ]);
    return { data: { summary, day } };
  });

tool("get_endpoint", "Other Personal API data (advanced)",
  "Advanced: read any other Personal API endpoint by path, e.g. /wellnessactivity-service/activity/summary/range/2026-10-01/2026-10-07. GET only. Use the dedicated tools first.",
  {
    path: z.string().regex(/^\/[A-Za-z0-9_\-./{}]+$/, "Path only, starting with /").describe("Endpoint path from Garmin's Personal API reference, starting with /"),
    query: z.record(z.string(), z.string()).optional().describe("Optional query parameters"),
    detail: detailArg,
  },
  async ({ path, query, detail }) => {
    if (path.includes("..") || path.includes("//")) throw new UserError("Invalid path.");
    return { data: await garminGet(path, query || {}), detail };
  });

// ---------------------------------------------------------------- start

const transport = new StdioServerTransport();
await server.connect(transport);
log(`v${VERSION} running${API_KEY ? "" : " (no API key configured yet)"}`);
