import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import type { FleetConfig } from "./types.js";

for (const envPath of [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")]) {
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath, override: false });
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  webOrigins: (process.env.WEB_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((x: string) => x.trim())
    .filter(Boolean),
  tickMs: Math.max(100, Number(process.env.TICK_MS ?? 250)),
  historyIntervalMs: Math.max(1000, Number(process.env.HISTORY_INTERVAL_MS ?? 10000)),
  weatherRefreshMs: Math.max(60000, Number(process.env.WEATHER_REFRESH_MS ?? 600000)),
  aiMode: process.env.AI_MODE ?? "auto",
  openAiKey: process.env.OPENAI_API_KEY ?? "",
  openAiModel: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  openAiBaseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
};

export function loadFleetConfig(): FleetConfig {
  const configured = process.env.FLEET_PATH;
  const candidates = [
    configured,
    path.resolve(process.cwd(), "../../data/fleet.json"),
    path.resolve(process.cwd(), "data/fleet.json"),
    "/app/data/fleet.json",
  ].filter(Boolean) as string[];

  const fleetPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!fleetPath) {
    throw new Error(`fleet.json not found. Checked: ${candidates.join(", ")}`);
  }

  const parsed = JSON.parse(fs.readFileSync(fleetPath, "utf8")) as FleetConfig;
  if (!Array.isArray(parsed.fleet) || parsed.fleet.length !== 15) {
    throw new Error(`Expected exactly 15 ships; received ${parsed.fleet?.length ?? 0}`);
  }
  return parsed;
}
