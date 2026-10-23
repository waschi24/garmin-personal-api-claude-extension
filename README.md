# Garmin Personal API – Claude Desktop extension

Read-only bridge between Claude Desktop and Garmin's official Connect Personal API.
Unofficial, by Garmin School. Not affiliated with Garmin.

## For viewers (the 4 steps)

1. Garmin Connect on the web → **Settings → Personal API Key → Create Key**. Pick an expiry (one year is easiest) and copy the key. Garmin shows it only once.
2. Download `garmin-personal-api.mcpb`.
3. Drag the file onto the Claude Desktop window (or double-click it) → **Install** → paste the key → **Save**. Make sure the extension is switched on.
4. Start a new chat: *"How did I sleep this week, and how does my HRV compare to last week?"*

The key is stored in your computer's secure keychain by Claude Desktop. Data goes Garmin → your computer → Claude. Nobody else (including Garmin School) sees the key or your data.

**Key expired?** Garmin emails you a week before. Create a new key, then Claude Desktop → Settings → Extensions → Garmin Personal API → Configure → paste → Save.

**Limits:** read-only (no workouts to the watch), Claude Desktop only (not the phone app). The Personal API has no training readiness, training status, training load, VO2max, badges or gear.

## Tools (21)

check_connection, get_sleep, get_sleep_range, get_hrv, get_hrv_range, get_daily_summaries, get_heart_rate, get_spo2, get_body_battery, get_stress, get_steps, search_activities, get_activity, get_activity_workouts, get_weight, get_fitness_age, get_hydration, get_food_log, get_heart_rate_zones, get_menstrual_cycle, get_endpoint (advanced raw GET)

Long per-sample timelines (minute-level heart rate, sleep stages, stress) are summarised by default; tools that return them accept `detail: true`.

## Build

```bash
npm install          # dependencies were pinned with --before=2026-10-09
npm run build        # esbuild → server/index.js (single file, no node_modules needed)
npx mcpb validate manifest.json
npx mcpb pack . garmin-personal-api.mcpb
node test/mock-and-client.mjs   # end-to-end test against a local mock of the Garmin API
```

`GARMIN_PERSONAL_API_BASE` overrides the API host (used only by the test).
