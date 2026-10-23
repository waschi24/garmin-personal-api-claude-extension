import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
let tokenCalls = 0, failNextData = true;
const seen = [];

const mock = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`);
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
  if (req.headers.accept === "application/json") return send(406, { error: "Not Acceptable" });
  if (req.url.startsWith("/personalapitoken-service")) {
    tokenCalls++;
    if (req.headers.authorization !== "ApiKey good-key") return send(401, { error: "bad key" });
    return send(200, { access_token: jwt, token_type: "Bearer", expires_in: 86400 });
  }
  if (req.headers.authorization !== `Bearer ${jwt}`) return send(401, {});
  if (req.url.startsWith("/userprofile-service") && failNextData) { failNextData = false; return send(401, {}); } // simulate revoked token -> retry
  if (req.url.startsWith("/sleep-service/sleep/dailySleep?"))
    return send(200, { dailySleepDTO: { sleepTimeSeconds: 27000, averageRespirationValue: 14.2, restingHeartRate: 48 },
      sleepLevels: Array.from({ length: 200 }, (_, i) => ({ startGMT: i, endGMT: i + 1, activityLevel: 1 })) });
  if (req.url.startsWith("/usersummary-service/v2/dailysummaries"))
    return send(200, Array.from({ length: 40 }, (_, i) => ({ calendarDate: `d${i}`, restingHeartRate: 50, totalSteps: 9000, a: 1, b: 2, c: 3 })));
  if (req.url.startsWith("/hrv-service/hrv/2026")) return send(404, {});
  if (req.url.startsWith("/userprofile-service")) return send(200, { measurementSystem: "metric", timeZone: "Europe/Brussels" });
  if (req.url.startsWith("/activitylist-service")) return send(200, [{ activityId: 1, activityName: "Run", distance: 10000 }]);
  send(204);
});
await new Promise((r) => mock.listen(0, r));
const base = `http://127.0.0.1:${mock.address().port}`;

async function run(key) {
  const transport = new StdioClientTransport({ command: "node", args: ["server/index.js"],
    env: { ...process.env, GARMIN_PERSONAL_API_KEY: key, GARMIN_PERSONAL_API_BASE: base }, stderr: "pipe" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const c = await run("good-key");
const { tools } = await c.listTools();
console.log("tools:", tools.length, tools.map((t) => t.name).join(", "));
console.log("all read-only:", tools.every((t) => t.annotations?.readOnlyHint === true));
const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return (r.isError ? "ERROR: " : "") + r.content[0].text; };

console.log("\ncheck_connection (401 then retry):", (await call("check_connection")).replace(/\s+/g, " "));
const sleep = await call("get_sleep", { date: "2026-10-22" });
console.log("\nget_sleep compact:", sleep.replace(/\s+/g, " ").slice(0, 300));
console.log("get_sleep detail length:", (await call("get_sleep", { date: "2026-10-22", detail: true })).length);
const ds = JSON.parse(await call("get_daily_summaries", { start_date: "2026-09-01", end_date: "2026-10-10" }));
console.log("\ndaily summaries kept all days:", ds.length);
console.log("hrv 404:", await call("get_hrv", { date: "2026-10-22" }));
console.log("stress too long:", await call("get_stress", { start_date: "2026-08-01", end_date: "2026-10-01" }));
console.log("bad date:", (await call("get_sleep", { date: "22/10/2026" })).slice(0, 120));
console.log("204:", await call("get_heart_rate_zones"));
console.log("bad path:", (await call("get_endpoint", { path: "https://evil.com/x" })).slice(0, 80));
console.log("token calls so far:", tokenCalls);
await c.close();

const bad = await run("wrong-key");
console.log("\nwrong key:", await (async () => { const r = await bad.callTool({ name: "check_connection", arguments: {} }); return r.content[0].text; })());
await bad.close();
const none = await run("");
console.log("no key:", (await none.callTool({ name: "get_sleep", arguments: {} })).content[0].text.slice(0, 60));
await none.close();
console.log("\nrequests seen:", seen.length, seen.filter(s=>s.includes("dailysummaries"))[0]);
mock.close();
