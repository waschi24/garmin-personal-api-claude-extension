# Garmin Personal API – Claude Desktop extension

Let Claude read **your own** Garmin Connect data (sleep, HRV, heart rate, activities and more) using Garmin's official [Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-faq/). No Garmin password, no scraping: you paste a key you created yourself, and you can delete it any time.

Free and open source, by [Garmin School](https://garmin.vaw.be). Unofficial: not affiliated with or endorsed by Garmin.

## Install (4 steps)

1. **Create a key.** In Garmin Connect on the web, go to **Settings → Personal API Key → Create Key**. Choose an expiry (one year is easiest) and copy the key straight away: Garmin shows it only once. Tip: save it in your password manager.
2. **Download** `garmin-personal-api.mcpb` from the [latest release](https://github.com/wimva/garmin-personal-api-claude-extension/releases/latest).
3. **Install it in Claude Desktop.** Drag the file onto the Claude window or double-click it. If that doesn't open the installer, go to **Settings → Extensions → Advanced settings → Install Extension…** and pick the file. Paste your key, save, and make sure the extension is switched on.
4. **Ask Claude**, in a new chat: *"How did I sleep this week, and how does my HRV compare to last week?"*

Claude Desktop may say the extension is unverified. That's normal for extensions installed from a file instead of Anthropic's directory. You can read every line of the code in this repository.

**Key expired?** Garmin emails you a week before. Create a new key, then go to **Settings → Extensions → Garmin Personal API → Configure**, paste it and save.

## What Claude can read

Sleep (stages, score, overnight respiration), HRV, all-day heart rate, resting heart rate, SpO2, Body Battery, stress, steps, activities, weight, fitness age, hydration, food log, heart rate zones and menstrual cycle data.

## Limits

- **Read-only.** It can't create workouts or send them to your watch.
- **Claude Desktop only.** It runs on your computer, so it isn't available in the Claude phone app or on claude.ai in the browser.
- **Garmin's Personal API doesn't include** training readiness, training status, training load, VO2max, badges or gear.
- Not medical advice.

## Privacy

This extension collects nothing.

- **What it handles:** your Garmin Personal API key and the Garmin data Claude asks for.
- **Where your key is stored:** by Claude Desktop, on your own computer, in the secure storage Claude Desktop uses for sensitive extension settings. The extension only sends it to Garmin (`personal.connectapi.garmin.com`) to get a temporary access token, which is kept in memory only and expires within 24 hours.
- **Where your data goes:** from Garmin to the extension on your computer, then to Claude in your conversation, like any other connector. Your conversations are handled by Anthropic under [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy); your Garmin data under [Garmin's privacy policy](https://www.garmin.com/privacy).
- **Third parties:** none. No analytics, no tracking, no servers of mine. I (Garmin School) never see your key or your data.
- **Retention:** the extension stores nothing on disk. Uninstall it in Claude Desktop to remove the key, and delete the key in Garmin Connect to revoke access completely.
- **Contact:** [open an issue](https://github.com/wimva/garmin-personal-api-claude-extension/issues) or reach out via [garmin.vaw.be](https://garmin.vaw.be).

## Tools (21)

`check_connection`, `get_sleep`, `get_sleep_range`, `get_hrv`, `get_hrv_range`, `get_daily_summaries`, `get_heart_rate`, `get_spo2`, `get_body_battery`, `get_stress`, `get_steps`, `search_activities`, `get_activity`, `get_activity_workouts`, `get_weight`, `get_fitness_age`, `get_hydration`, `get_food_log`, `get_heart_rate_zones`, `get_menstrual_cycle`, `get_endpoint` (advanced, read-only GET of any other Personal API endpoint)

Long per-sample timelines (minute-level heart rate, sleep stages, stress) are summarised by default; tools that return them accept `detail: true`.

## Build from source

Requires Node 18+.

```bash
npm install
npm run build                     # esbuild → server/index.js (single file, no node_modules needed at runtime)
node test/mock-and-client.mjs     # end-to-end test against a local mock of the Garmin API
npx mcpb validate manifest.json
npx mcpb pack . garmin-personal-api.mcpb
```

`GARMIN_PERSONAL_API_BASE` overrides the API host (used only by the test).

## Deploy on Fly.io

This repository now includes a `Dockerfile`, so Fly.io can detect and build it directly.

```bash
fly launch
fly secrets set GARMIN_PERSONAL_API_KEY=your_personal_api_key
fly deploy
```

## License

[MIT](LICENSE)
