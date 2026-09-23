import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SimulationEngine } from "../src/engine/simulation.js";
import type { FleetConfig, Position, WeatherCell, WeatherInfo } from "../src/types.js";

const config = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "../../data/fleet.json"), "utf8"),
) as FleetConfig;

class FakeWeather {
  private cell: WeatherCell = {
    id: "normal",
    position: [26, 55],
    condition: "normal",
    windKnots: 8,
    gustKnots: 12,
    precipitationMm: 0,
    weatherCode: 0,
    fuelMultiplier: 1,
    source: "fallback",
    sampledAt: new Date().toISOString(),
  };
  at(_position: Position): WeatherInfo { return { ...this.cell }; }
  getCells(): WeatherCell[] { return [this.cell]; }
  async start(callback?: (cells: WeatherCell[]) => void): Promise<void> { callback?.([this.cell]); }
  stop(): void {}
}

class FakeAI {
  async analyzeDistress(message: string) {
    return {
      severity: "critical" as const,
      incidentType: ["engine_failure"],
      injuries: 2,
      quantifiableImpact: ["2 reported injuries"],
      summary: message,
      recommendedPriority: 1,
      provider: "heuristic" as const,
    };
  }
  async advise(_ships: unknown, _alerts: unknown, fallback: unknown) { return fallback; }
}

const running: SimulationEngine[] = [];
afterEach(() => {
  while (running.length) running.pop()!.stop();
});

async function makeEngine(fleetConfig = config): Promise<SimulationEngine> {
  const engine = new SimulationEngine(fleetConfig, new FakeWeather() as any, new FakeAI() as any, 250, 10000);
  running.push(engine);
  await engine.start();
  return engine;
}

describe("SimulationEngine", () => {
  it("starts all 15 ships and flags the supplied low-fuel edge case", async () => {
    const engine = await makeEngine();
    expect(engine.getShips()).toHaveLength(15);
    expect(engine.getShips().every((ship) => ship.route.length >= 2)).toBe(true);
    expect(engine.getShip("MV-7")!.status).toBe("insufficient_fuel");
    expect(engine.getAlerts().some((alert) => alert.type === "INSUFFICIENT_FUEL" && alert.shipIds.includes("MV-7"))).toBe(true);
  });

  it("fires a geofence alert immediately when a new zone surrounds a ship", async () => {
    const engine = await makeEngine();
    const ship = engine.getShip("MV-1")!;
    const [lat, lng] = ship.position;
    engine.createZone("Trap", [
      [lat - 0.05, lng - 0.05],
      [lat + 0.05, lng - 0.05],
      [lat + 0.05, lng + 0.05],
      [lat - 0.05, lng + 0.05],
    ]);
    expect(engine.getAlerts().some((alert) => !alert.resolved && alert.type === "GEOFENCE_BREACH" && alert.shipIds.includes("MV-1"))).toBe(true);
  });

  it("applies an accepted captain directive on the next tick", async () => {
    const engine = await makeEngine();
    const directive = engine.sendDirective("MV-2", "HOLD_POSITION", {});
    await engine.respondDirective(directive.id, "MV-2", "ACCEPT");
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(engine.getShip("MV-2")!.holdPosition).toBe(true);
    expect(engine.getShip("MV-2")!.status).toBe("stopped");
  });

  it("routes structured distress and assistance through the shared alert pipeline", async () => {
    const engine = await makeEngine();
    const distress = await engine.raiseDistress("MV-3", "Engine failure; 2 crew injured");
    expect(distress.severity).toBe("critical");
    expect((distress.metadata?.analysis as { injuries: number }).injuries).toBe(2);

    const assistance = engine.requestAssistance("MV-3", "medical", "Need a medic");
    expect(assistance.toShipId).not.toBe("MV-3");
    expect(engine.respondAssistance(assistance.id, assistance.toShipId, "ACCEPT").status).toBe("accepted");
    expect(engine.getAlerts().some((alert) => alert.type === "ASSISTANCE" && alert.shipIds.includes("MV-3") && alert.resolved)).toBe(true);
  });

  it("warns when two ships are within 2 km", async () => {
    const nearby = structuredClone(config);
    nearby.fleet[1].position = [...nearby.fleet[0].position];
    const engine = await makeEngine(nearby);
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(engine.getAlerts().some((alert) => alert.type === "PROXIMITY" && alert.shipIds.includes("MV-1") && alert.shipIds.includes("MV-2"))).toBe(true);
  });
});
