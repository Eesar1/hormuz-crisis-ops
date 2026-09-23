import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GridRouter } from "../src/routing/grid-router.js";
import type { FleetConfig, Position, WeatherInfo } from "../src/types.js";

const config = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "../../data/fleet.json"), "utf8"),
) as FleetConfig;

const normalWeather = {
  at(_position: Position): WeatherInfo {
    return {
      condition: "normal",
      windKnots: 8,
      gustKnots: 12,
      precipitationMm: 0,
      weatherCode: 0,
      fuelMultiplier: 1,
      source: "fallback",
      sampledAt: new Date().toISOString(),
    };
  },
};

describe("GridRouter", () => {
  it("applies exactly 30% extra fuel burn in adverse weather", () => {
    const router = new GridRouter(config, normalWeather);
    expect(router.fuelBurnPerKm(15, 1.3) / router.fuelBurnPerKm(15, 1)).toBeCloseTo(1.3, 10);
  });

  it("finds a valid initial route for all 15 supplied ships", () => {
    const router = new GridRouter(config, normalWeather);
    for (const ship of config.fleet) {
      const port = config.ports.find((item) => item.id === ship.destination)!;
      const route = router.route(ship.position, port.position, [], "safe");
      expect(route, ship.shipId).not.toBeNull();
      expect(route!.length, ship.shipId).toBeGreaterThanOrEqual(2);
      expect(route!.at(-1)).toEqual(port.position);
    }
  });

  it("returns no path when a restricted zone covers the destination", () => {
    const router = new GridRouter(config, normalWeather);
    const ship = config.fleet.find((item) => item.shipId === "MV-1")!;
    const port = config.ports.find((item) => item.id === ship.destination)!;
    const [lat, lng] = port.position;
    const zone = {
      id: "goal-block",
      name: "Goal block",
      points: [
        [lat - 0.1, lng - 0.1],
        [lat + 0.1, lng - 0.1],
        [lat + 0.1, lng + 0.1],
        [lat - 0.1, lng + 0.1],
      ] as Position[],
      createdAt: "",
      updatedAt: "",
    };
    expect(router.route(ship.position, port.position, [zone], "safe")).toBeNull();
  });

  it("can route a ship out of a zone drawn around its current position", () => {
    const router = new GridRouter(config, normalWeather);
    const ship = config.fleet.find((item) => item.shipId === "MV-1")!;
    const port = config.ports.find((item) => item.id === ship.destination)!;
    const [lat, lng] = ship.position;
    const zone = {
      id: "start-trap",
      name: "Start trap",
      points: [
        [lat - 0.05, lng - 0.05],
        [lat + 0.05, lng - 0.05],
        [lat + 0.05, lng + 0.05],
        [lat - 0.05, lng + 0.05],
      ] as Position[],
      createdAt: "",
      updatedAt: "",
    };
    const route = router.route(ship.position, port.position, [zone], "safe");
    expect(route).not.toBeNull();
    expect(route!.length).toBeGreaterThanOrEqual(2);
  });
});
