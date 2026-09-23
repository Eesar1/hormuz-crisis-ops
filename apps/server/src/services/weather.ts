import type { FleetConfig, Position, WeatherCell, WeatherInfo } from "../types.js";
import { haversineKm, pointInPolygon } from "../utils/geo.js";

const NORMAL: Omit<WeatherInfo, "sampledAt"> = {
  condition: "normal",
  windKnots: 8,
  gustKnots: 12,
  precipitationMm: 0,
  weatherCode: 0,
  fuelMultiplier: 1,
  source: "fallback",
};

function conditionFor(windKnots: number, gustKnots: number, precipitationMm: number, weatherCode: number): WeatherInfo["condition"] {
  const thunder = weatherCode >= 95;
  if (thunder || windKnots >= 34 || gustKnots >= 45 || precipitationMm >= 10) return "severe";
  if (windKnots >= 25 || gustKnots >= 35 || precipitationMm >= 5 || (weatherCode >= 80 && weatherCode <= 94)) return "adverse";
  if (windKnots >= 17 || gustKnots >= 25 || precipitationMm >= 1) return "moderate";
  return "normal";
}

export class WeatherService {
  private cells: WeatherCell[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly config: FleetConfig, private readonly refreshMs: number) {
    this.cells = this.fallbackCells();
  }

  getCells(): WeatherCell[] {
    return this.cells;
  }

  at(position: Position): WeatherInfo {
    const nearest = this.cells.reduce<WeatherCell | undefined>((best, cell) => {
      if (!best) return cell;
      return haversineKm(position, cell.position) < haversineKm(position, best.position) ? cell : best;
    }, undefined);
    if (!nearest) return { ...NORMAL, sampledAt: new Date().toISOString() };
    const { id: _id, position: _position, ...weather } = nearest;
    return weather;
  }

  async start(onUpdate?: (cells: WeatherCell[]) => void): Promise<void> {
    await this.refresh();
    onUpdate?.(this.cells);
    this.timer = setInterval(async () => {
      await this.refresh();
      onUpdate?.(this.cells);
    }, this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private samplePoints(): Position[] {
    const points: Position[] = [];
    const { south, north, west, east } = this.config.boundingBox;
    for (let r = 1; r <= 5; r++) {
      for (let c = 1; c <= 7; c++) {
        const p: Position = [south + ((north - south) * r) / 6, west + ((east - west) * c) / 8];
        if (pointInPolygon(p, this.config.navigableWater)) points.push(p);
      }
    }
    return points;
  }

  private fallbackCells(): WeatherCell[] {
    const now = new Date().toISOString();
    return this.samplePoints().map((position, index) => {
      const wave = Math.abs(Math.sin(position[0] * 0.75 + position[1] * 0.31));
      const condition: WeatherInfo["condition"] = wave > 0.92 ? "adverse" : wave > 0.72 ? "moderate" : "normal";
      const windKnots = condition === "adverse" ? 27 : condition === "moderate" ? 19 : 10;
      return {
        id: `wx-${index}`,
        position,
        condition,
        windKnots,
        gustKnots: windKnots + 7,
        precipitationMm: condition === "adverse" ? 5.5 : condition === "moderate" ? 1.5 : 0,
        weatherCode: condition === "adverse" ? 82 : condition === "moderate" ? 61 : 1,
        fuelMultiplier: condition === "adverse" ? 1.3 : 1,
        source: "fallback",
        sampledAt: now,
      };
    });
  }

  private async refresh(): Promise<void> {
    const points = this.samplePoints();
    if (!points.length) return;
    const latitudes = points.map((p) => p[0]).join(",");
    const longitudes = points.map((p) => p[1]).join(",");
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", latitudes);
    url.searchParams.set("longitude", longitudes);
    url.searchParams.set("current", "wind_speed_10m,wind_gusts_10m,precipitation,weather_code");
    url.searchParams.set("wind_speed_unit", "kn");

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
      const json = (await response.json()) as unknown;
      const rows = Array.isArray(json) ? json : [json];
      if (rows.length !== points.length) throw new Error("Unexpected Open-Meteo response shape");
      const now = new Date().toISOString();
      this.cells = rows.map((row: any, index) => {
        const current = row.current ?? {};
        const windKnots = Number(current.wind_speed_10m ?? 0);
        const gustKnots = Number(current.wind_gusts_10m ?? windKnots);
        const precipitationMm = Number(current.precipitation ?? 0);
        const weatherCode = Number(current.weather_code ?? 0);
        const condition = conditionFor(windKnots, gustKnots, precipitationMm, weatherCode);
        return {
          id: `wx-${index}`,
          position: points[index],
          condition,
          windKnots,
          gustKnots,
          precipitationMm,
          weatherCode,
          fuelMultiplier: condition === "adverse" || condition === "severe" ? 1.3 : 1,
          source: "open-meteo",
          sampledAt: now,
        };
      });
    } catch (error) {
      console.warn("Weather refresh failed; retaining/falling back to deterministic local weather:", (error as Error).message);
      if (!this.cells.length || this.cells.every((cell) => cell.source === "fallback")) this.cells = this.fallbackCells();
    }
  }
}
