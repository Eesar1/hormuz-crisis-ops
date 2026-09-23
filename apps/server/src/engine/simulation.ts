import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  AdvisorSuggestion,
  Alert,
  AssistanceKind,
  AssistanceRequest,
  Directive,
  DirectiveType,
  FleetConfig,
  HistorySnapshot,
  Position,
  RestrictedZone,
  RouteCandidate,
  RouteStrategy,
  ShipState,
  WeatherCell,
} from "../types.js";
import { GridRouter } from "../routing/grid-router.js";
import { WeatherService } from "../services/weather.js";
import { AIService } from "../ai/distress.js";
import { AlertStore } from "./alerts.js";
import {
  bearingDegrees,
  haversineKm,
  isFinitePosition,
  moveToward,
  pathIntersectsPolygon,
  pointInPolygon,
  polylineDistanceKm,
} from "../utils/geo.js";

interface SimulationEvents {
  "fleet:update": [ShipState[]];
  "alert:new": [Alert];
  "alert:update": [Alert];
  "zone:update": [RestrictedZone[]];
  "directive:new": [Directive];
  "directive:update": [Directive];
  "assistance:new": [AssistanceRequest];
  "assistance:update": [AssistanceRequest];
  "weather:update": [WeatherCell[]];
  "history:update": [HistorySnapshot];
}

type TypedEventEmitter = {
  on<K extends keyof SimulationEvents>(event: K, listener: (...args: SimulationEvents[K]) => void): SimulationEngine;
  emit<K extends keyof SimulationEvents>(event: K, ...args: SimulationEvents[K]): boolean;
};

const clone = <T>(value: T): T => structuredClone(value);

export class SimulationEngine extends (EventEmitter as { new (): EventEmitter }) implements TypedEventEmitter {
  private ships = new Map<string, ShipState>();
  private zones = new Map<string, RestrictedZone>();
  private directives = new Map<string, Directive>();
  private assistance = new Map<string, AssistanceRequest>();
  private alerts = new AlertStore();
  private history: HistorySnapshot[] = [];
  private eventBuffer: HistorySnapshot["keyEvents"] = [];
  private pendingAcceptedDirectives = new Set<string>();
  private timer?: NodeJS.Timeout;
  private historyTimer?: NodeJS.Timeout;
  private lastTick = Date.now();
  private router: GridRouter;

  constructor(
    readonly config: FleetConfig,
    readonly weatherService: WeatherService,
    private readonly ai: AIService,
    private readonly tickMs: number,
    private readonly historyIntervalMs: number,
  ) {
    super();
    this.router = new GridRouter(config, weatherService);
    this.initializeShips();
  }

  async start(): Promise<void> {
    await this.weatherService.start((cells) => {
      this.refreshShipWeather();
      this.emit("weather:update", clone(cells));
    });
    this.computeInitialRoutes();
    this.captureHistory();
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    this.historyTimer = setInterval(() => this.captureHistory(), this.historyIntervalMs);
    this.historyTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.historyTimer) clearInterval(this.historyTimer);
    this.weatherService.stop();
  }

  getShips(): ShipState[] {
    return clone([...this.ships.values()]);
  }

  getShip(shipId: string): ShipState | undefined {
    const ship = this.ships.get(shipId);
    return ship ? clone(ship) : undefined;
  }

  getZones(): RestrictedZone[] {
    return clone([...this.zones.values()]);
  }

  getAlerts(): Alert[] {
    return clone(this.alerts.list());
  }

  getDirectives(): Directive[] {
    return clone([...this.directives.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  getAssistance(): AssistanceRequest[] {
    return clone([...this.assistance.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  getHistory(): HistorySnapshot[] {
    return clone(this.history);
  }

  getWeather(): WeatherCell[] {
    return clone(this.weatherService.getCells());
  }

  getBootstrap() {
    return {
      scenario: this.config.scenario,
      boundingBox: this.config.boundingBox,
      navigableWater: this.config.navigableWater,
      ports: this.config.ports,
      ships: this.getShips(),
      zones: this.getZones(),
      alerts: this.getAlerts(),
      directives: this.getDirectives(),
      assistance: this.getAssistance(),
      weather: this.getWeather(),
      history: this.getHistory(),
      serverTime: new Date().toISOString(),
    };
  }

  createZone(name: string, points: Position[]): RestrictedZone {
    this.validateZone(points);
    const now = new Date().toISOString();
    const zone: RestrictedZone = {
      id: randomUUID(),
      name: name.trim() || `Restricted Zone ${this.zones.size + 1}`,
      points,
      createdAt: now,
      updatedAt: now,
    };
    this.zones.set(zone.id, zone);
    this.logEvent("ZONE_CREATED", `${zone.name} created`);
    this.emit("zone:update", this.getZones());
    this.handleZoneChange(zone);
    return clone(zone);
  }

  updateZone(id: string, name: string | undefined, points: Position[]): RestrictedZone {
    const existing = this.zones.get(id);
    if (!existing) throw new Error("Zone not found");
    this.validateZone(points);
    const zone: RestrictedZone = {
      ...existing,
      name: name?.trim() || existing.name,
      points,
      updatedAt: new Date().toISOString(),
    };
    this.zones.set(id, zone);
    this.logEvent("ZONE_UPDATED", `${zone.name} updated`);
    this.emit("zone:update", this.getZones());
    this.handleZoneChange(zone);
    return clone(zone);
  }

  deleteZone(id: string): void {
    const zone = this.zones.get(id);
    if (!zone) return;
    this.zones.delete(id);
    for (const ship of this.ships.values()) {
      const resolved = this.alerts.resolve(`geofence:${id}:${ship.shipId}`);
      if (resolved) this.emit("alert:update", clone(resolved));
      if (ship.status === "stranded" && ship.fuel > 0 && !ship.holdPosition) this.rerouteShip(ship, ship.routeStrategy, true);
      else this.recomputeStatus(ship);
    }
    this.logEvent("ZONE_DELETED", `${zone.name} deleted`);
    this.emit("zone:update", this.getZones());
  }

  sendDirective(shipId: string, type: DirectiveType, payload: Directive["payload"]): Directive {
    if (!this.ships.has(shipId)) throw new Error("Ship not found");
    if (type === "REROUTE_PORT" && !this.config.ports.some((p) => p.id === payload.portId)) throw new Error("Unknown destination port");
    if (type === "DIVERT_WAYPOINT") {
      if (!isFinitePosition(payload.waypoint)) throw new Error("Invalid waypoint");
      if (!pointInPolygon(payload.waypoint, this.config.navigableWater)) throw new Error("Waypoint must be inside the supplied navigable-water polygon");
    }
    const directive: Directive = {
      id: randomUUID(),
      shipId,
      type,
      payload,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.directives.set(directive.id, directive);
    this.logEvent("DIRECTIVE_SENT", `${type} sent to ${shipId}`);
    this.emit("directive:new", clone(directive));
    return clone(directive);
  }

  async respondDirective(directiveId: string, shipId: string, response: "ACCEPT" | "ESCALATE_DISTRESS", message?: string): Promise<Directive> {
    const directive = this.directives.get(directiveId);
    if (!directive || directive.shipId !== shipId) throw new Error("Directive not found for this captain");
    if (directive.status !== "pending") throw new Error("Directive already handled");
    directive.respondedAt = new Date().toISOString();
    directive.responseMessage = message;
    if (response === "ACCEPT") {
      directive.status = "accepted";
      this.pendingAcceptedDirectives.add(directive.id);
      this.logEvent("DIRECTIVE_ACCEPTED", `${shipId} accepted ${directive.type}`);
    } else {
      directive.status = "escalated";
      this.logEvent("DIRECTIVE_ESCALATED", `${shipId} escalated ${directive.type}`);
      await this.raiseDistress(shipId, message?.trim() || `Captain escalated directive ${directive.type} due to unsafe conditions.`);
    }
    this.emit("directive:update", clone(directive));
    return clone(directive);
  }

  async raiseDistress(shipId: string, message: string): Promise<Alert> {
    const ship = this.ships.get(shipId);
    if (!ship) throw new Error("Ship not found");
    if (!message.trim()) throw new Error("Distress message is required");
    const analysis = await this.ai.analyzeDistress(message.trim());
    ship.status = "distressed";
    const { alert, created } = this.alerts.upsert({
      sourceKey: `distress:${shipId}:${Date.now()}`,
      type: "DISTRESS",
      severity: analysis.severity,
      title: `Distress: ${ship.name}`,
      message: analysis.summary,
      shipIds: [shipId],
      metadata: { rawMessage: message, analysis },
    });
    this.logEvent("DISTRESS", `${ship.name}: ${analysis.summary}`);
    this.emit(created ? "alert:new" : "alert:update", clone(alert));
    return clone(alert);
  }

  acknowledgeAlert(alertId: string): Alert {
    const alert = this.alerts.acknowledge(alertId);
    if (!alert) throw new Error("Alert not found");
    this.emit("alert:update", clone(alert));
    return clone(alert);
  }

  requestAssistance(fromShipId: string, kind: AssistanceKind, message?: string): AssistanceRequest {
    const from = this.ships.get(fromShipId);
    if (!from) throw new Error("Ship not found");
    const candidates = [...this.ships.values()]
      .filter((ship) => ship.shipId !== fromShipId && ship.status !== "out_of_fuel" && ship.status !== "arrived")
      .map((ship) => ({ ship, distance: haversineKm(from.position, ship.position) }))
      .sort((a, b) => a.distance - b.distance);
    const nearest = candidates[0];
    if (!nearest) throw new Error("No assistance vessel available");
    const request: AssistanceRequest = {
      id: randomUUID(),
      fromShipId,
      toShipId: nearest.ship.shipId,
      kind,
      message,
      distanceKm: nearest.distance,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.assistance.set(request.id, request);
    this.logEvent("ASSISTANCE_REQUESTED", `${fromShipId} requested ${kind} from ${request.toShipId}`);
    const { alert, created } = this.alerts.upsert({
      sourceKey: `assistance:${request.id}`,
      type: "ASSISTANCE",
      severity: kind === "medical" ? "high" : "warning",
      title: `Assistance requested: ${kind}`,
      message: `${fromShipId} requested ${kind.replace("_", " ")} from nearby ${request.toShipId} (${request.distanceKm.toFixed(1)} km).`,
      shipIds: [fromShipId, request.toShipId],
      metadata: { assistanceId: request.id },
    });
    this.emit(created ? "alert:new" : "alert:update", clone(alert));
    this.emit("assistance:new", clone(request));
    return clone(request);
  }

  respondAssistance(id: string, respondingShipId: string, response: "ACCEPT" | "DECLINE"): AssistanceRequest {
    const request = this.assistance.get(id);
    if (!request || request.toShipId !== respondingShipId) throw new Error("Assistance request not found for this captain");
    if (request.status !== "pending") throw new Error("Assistance request already handled");
    request.status = response === "ACCEPT" ? "accepted" : "declined";
    request.respondedAt = new Date().toISOString();
    this.logEvent("ASSISTANCE_RESPONSE", `${respondingShipId} ${request.status} assistance request from ${request.fromShipId}`);
    this.emit("assistance:update", clone(request));
    const resolved = this.alerts.resolve(`assistance:${request.id}`);
    if (resolved) this.emit("alert:update", clone(resolved));
    return clone(request);
  }

  routeCandidates(shipId: string, destinationPortId?: string): RouteCandidate[] {
    const ship = this.ships.get(shipId);
    if (!ship) throw new Error("Ship not found");
    const destination = destinationPortId ? this.config.ports.find((p) => p.id === destinationPortId)?.position : ship.destinationPosition;
    if (!destination) throw new Error("Destination not found");
    return this.router.candidates(ship.position, destination, this.getZones(), ship.fuel, ship.cruiseSpeed);
  }

  async advisorSuggestions(): Promise<AdvisorSuggestion[]> {
    const fallback = this.ruleAdvisorSuggestions();
    return this.ai.advise(this.getShips(), this.getAlerts(), fallback);
  }

  private initializeShips(): void {
    const now = new Date().toISOString();
    for (const input of this.config.fleet) {
      const port = this.config.ports.find((item) => item.id === input.destination);
      if (!port) throw new Error(`Missing port ${input.destination} for ${input.shipId}`);
      const weather = this.weatherService.at(input.position);
      this.ships.set(input.shipId, {
        ...input,
        cruiseSpeed: input.speed,
        destinationLabel: port.name,
        destinationPosition: port.position,
        route: [input.position, port.position],
        routeIndex: 1,
        routeStrategy: "safe",
        holdPosition: false,
        weather,
        reachability: {
          reachable: true,
          routeDistanceKm: haversineKm(input.position, port.position),
          estimatedFuelTons: 0,
          fuelRemainingAtArrival: input.fuel,
        },
        updatedAt: now,
      });
    }
  }

  private computeInitialRoutes(): void {
    for (const ship of this.ships.values()) this.rerouteShip(ship, ship.routeStrategy, false);
  }

  private tick(): void {
    const now = Date.now();
    const dtSeconds = Math.min(2, Math.max(0.05, (now - this.lastTick) / 1000));
    this.lastTick = now;
    this.applyPendingDirectives();

    for (const ship of this.ships.values()) this.advanceShip(ship, dtSeconds);
    this.checkProximity();
    this.emit("fleet:update", this.getShips());
  }

  private applyPendingDirectives(): void {
    for (const directiveId of [...this.pendingAcceptedDirectives]) {
      const directive = this.directives.get(directiveId);
      if (!directive) {
        this.pendingAcceptedDirectives.delete(directiveId);
        continue;
      }
      const ship = this.ships.get(directive.shipId)!;
      switch (directive.type) {
        case "REROUTE_PORT": {
          const port = this.config.ports.find((p) => p.id === directive.payload.portId)!;
          ship.destination = port.id;
          ship.destinationLabel = port.name;
          ship.destinationPosition = port.position;
          ship.holdPosition = false;
          ship.speed = ship.cruiseSpeed;
          this.rerouteShip(ship, directive.payload.strategy ?? "safe", true);
          break;
        }
        case "DIVERT_WAYPOINT": {
          const waypoint = directive.payload.waypoint!;
          ship.destination = `WAYPOINT-${directive.id.slice(0, 8)}`;
          ship.destinationLabel = `Waypoint ${waypoint[0].toFixed(2)}, ${waypoint[1].toFixed(2)}`;
          ship.destinationPosition = waypoint;
          ship.holdPosition = false;
          ship.speed = ship.cruiseSpeed;
          this.rerouteShip(ship, directive.payload.strategy ?? "safe", true);
          break;
        }
        case "HOLD_POSITION":
          ship.holdPosition = true;
          ship.speed = 0;
          ship.status = "stopped";
          break;
        case "RESUME":
          ship.holdPosition = false;
          ship.speed = ship.cruiseSpeed;
          this.rerouteShip(ship, directive.payload.strategy ?? ship.routeStrategy, true);
          break;
      }
      directive.status = "applied";
      this.pendingAcceptedDirectives.delete(directiveId);
      this.emit("directive:update", clone(directive));
    }
  }

  private advanceShip(ship: ShipState, dtSeconds: number): void {
    ship.weather = this.weatherService.at(ship.position);
    if (ship.status === "arrived" || ship.status === "out_of_fuel" || ship.status === "stranded" || ship.holdPosition) {
      ship.updatedAt = new Date().toISOString();
      this.checkGeofences(ship);
      return;
    }
    if (!ship.route.length || ship.routeIndex >= ship.route.length) {
      this.arrive(ship);
      return;
    }

    const distanceBudget = ship.speed * 1.852 * (dtSeconds / 3600);
    let remaining = distanceBudget;
    let moved = 0;
    while (remaining > 0 && ship.routeIndex < ship.route.length) {
      const target = ship.route[ship.routeIndex];
      const distance = haversineKm(ship.position, target);
      if (distance < 0.003) {
        ship.position = [...target] as Position;
        ship.routeIndex++;
        continue;
      }
      ship.heading = bearingDegrees(ship.position, target);
      const step = Math.min(remaining, distance);
      ship.position = moveToward(ship.position, target, step);
      remaining -= step;
      moved += step;
      if (step >= distance - 1e-6) ship.routeIndex++;
    }

    if (moved > 0) {
      ship.fuel = Math.max(0, ship.fuel - moved * this.router.fuelBurnPerKm(ship.cruiseSpeed, ship.weather.fuelMultiplier));
      if (ship.fuel <= 0) {
        ship.fuel = 0;
        ship.speed = 0;
        ship.status = "out_of_fuel";
        const { alert, created } = this.alerts.upsert({
          sourceKey: `out-of-fuel:${ship.shipId}`,
          type: "OUT_OF_FUEL",
          severity: "critical",
          title: `${ship.name} is out of fuel`,
          message: `${ship.shipId} has stopped with zero fuel remaining.`,
          shipIds: [ship.shipId],
        });
        this.emit(created ? "alert:new" : "alert:update", clone(alert));
      }
    }

    if (ship.routeIndex >= ship.route.length && haversineKm(ship.position, ship.destinationPosition) < 0.5) this.arrive(ship);
    if (ship.routeIndex < ship.route.length && ship.status !== "out_of_fuel") this.refreshReachability(ship);
    this.checkGeofences(ship);
    this.recomputeStatus(ship);
    ship.updatedAt = new Date().toISOString();
  }

  private arrive(ship: ShipState): void {
    ship.position = [...ship.destinationPosition] as Position;
    ship.speed = 0;
    ship.status = "arrived";
    ship.routeIndex = ship.route.length;
    ship.updatedAt = new Date().toISOString();
    this.logEvent("ARRIVED", `${ship.name} arrived at ${ship.destinationLabel}`);
  }

  private checkGeofences(ship: ShipState): void {
    let insideAny = false;
    for (const zone of this.zones.values()) {
      const inside = pointInPolygon(ship.position, zone.points);
      const sourceKey = `geofence:${zone.id}:${ship.shipId}`;
      if (inside) {
        insideAny = true;
        const { alert, created } = this.alerts.upsert({
          sourceKey,
          type: "GEOFENCE_BREACH",
          severity: "critical",
          title: `Geofence breach: ${ship.name}`,
          message: `${ship.name} is inside ${zone.name}. Automatic escape reroute engaged.`,
          shipIds: [ship.shipId],
          metadata: { zoneId: zone.id, zoneName: zone.name },
        });
        this.emit(created ? "alert:new" : "alert:update", clone(alert));
        if (created && ship.status !== "out_of_fuel" && ship.status !== "stranded" && !ship.holdPosition) {
          ship.status = "zone_breach";
          this.rerouteShip(ship, "safe", true);
        }
      } else {
        const resolved = this.alerts.resolve(sourceKey);
        if (resolved) this.emit("alert:update", clone(resolved));
      }
    }
    if (!insideAny && ship.status === "zone_breach") this.recomputeStatus(ship);
  }

  private checkProximity(): void {
    const ships = [...this.ships.values()];
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        const a = ships[i];
        const b = ships[j];
        const key = [a.shipId, b.shipId].sort().join(":");
        const sourceKey = `proximity:${key}`;
        const distanceKm = haversineKm(a.position, b.position);
        if (distanceKm < 2) {
          const { alert, created } = this.alerts.upsert({
            sourceKey,
            type: "PROXIMITY",
            severity: distanceKm < 0.75 ? "critical" : "high",
            title: `Proximity warning: ${a.name} / ${b.name}`,
            message: `${a.shipId} and ${b.shipId} are ${distanceKm.toFixed(2)} km apart.`,
            shipIds: [a.shipId, b.shipId],
            metadata: { distanceKm },
          });
          this.emit(created ? "alert:new" : "alert:update", clone(alert));
        } else {
          const resolved = this.alerts.resolve(sourceKey);
          if (resolved) this.emit("alert:update", clone(resolved));
        }
      }
    }
  }

  private handleZoneChange(zone: RestrictedZone): void {
    for (const ship of this.ships.values()) {
      const inside = pointInPolygon(ship.position, zone.points);
      const remainingPath = [ship.position, ...ship.route.slice(ship.routeIndex)];
      if (ship.status === "stranded" && ship.fuel > 0 && !ship.holdPosition && !inside) {
        this.rerouteShip(ship, ship.routeStrategy, true);
      } else if (inside) {
        // Fire the breach immediately on zone creation/update; do not wait for the next tick.
        this.checkGeofences(ship);
      } else if (pathIntersectsPolygon(remainingPath, zone.points)) {
        ship.status = "rerouting";
        this.rerouteShip(ship, "safe", true);
      }
    }
  }

  private rerouteShip(ship: ShipState, strategy: RouteStrategy, announce: boolean): void {
    if (ship.status === "out_of_fuel") return;
    ship.routeStrategy = strategy;
    ship.status = "rerouting";
    ship.updatedAt = new Date().toISOString();
    if (announce) this.emit("fleet:update", this.getShips());
    const path = this.router.route(ship.position, ship.destinationPosition, this.getZones(), strategy);
    if (!path || path.length < 2) {
      ship.route = [ship.position];
      ship.routeIndex = 1;
      ship.speed = 0;
      ship.status = "stranded";
      const { alert, created } = this.alerts.upsert({
        sourceKey: `stranded:${ship.shipId}`,
        type: "STRANDED",
        severity: "critical",
        title: `${ship.name} is stranded`,
        message: `No valid navigable path exists from ${ship.name} to ${ship.destinationLabel}.`,
        shipIds: [ship.shipId],
      });
      this.emit(created ? "alert:new" : "alert:update", clone(alert));
      this.logEvent("STRANDED", `${ship.name} has no valid route`);
      return;
    }

    ship.route = path;
    ship.routeIndex = 1;
    if (!ship.holdPosition) ship.speed = ship.cruiseSpeed;
    const estimate = this.router.estimateFuel(path, ship.cruiseSpeed);
    ship.reachability = {
      reachable: ship.fuel >= estimate.fuelTons,
      routeDistanceKm: estimate.distanceKm,
      estimatedFuelTons: estimate.fuelTons,
      fuelRemainingAtArrival: ship.fuel - estimate.fuelTons,
    };
    const strandedResolved = this.alerts.resolve(`stranded:${ship.shipId}`);
    if (strandedResolved) this.emit("alert:update", clone(strandedResolved));
    this.updateFuelAlert(ship);
    this.recomputeStatus(ship);
    if (announce) this.logEvent("REROUTE", `${ship.name} rerouted (${strategy}) to ${ship.destinationLabel}`);
  }

  private refreshReachability(ship: ShipState): void {
    const remainingPath = [ship.position, ...ship.route.slice(ship.routeIndex)];
    if (remainingPath.length < 2) {
      ship.reachability = { reachable: true, routeDistanceKm: 0, estimatedFuelTons: 0, fuelRemainingAtArrival: ship.fuel };
      return;
    }
    const wasReachable = ship.reachability.reachable;
    const estimate = this.router.estimateFuel(remainingPath, ship.cruiseSpeed);
    ship.reachability = {
      reachable: ship.fuel >= estimate.fuelTons,
      routeDistanceKm: estimate.distanceKm,
      estimatedFuelTons: estimate.fuelTons,
      fuelRemainingAtArrival: ship.fuel - estimate.fuelTons,
    };
    if (wasReachable !== ship.reachability.reachable) this.updateFuelAlert(ship);
  }

  private updateFuelAlert(ship: ShipState): void {
    const sourceKey = `insufficient-fuel:${ship.shipId}`;
    const predictiveKey = `predictive-fuel:${ship.shipId}`;
    if (!ship.reachability.reachable) {
      const shortage = Math.abs(ship.reachability.fuelRemainingAtArrival);
      const { alert, created } = this.alerts.upsert({
        sourceKey,
        type: "INSUFFICIENT_FUEL",
        severity: "high",
        title: `Insufficient fuel: ${ship.name}`,
        message: `${ship.name} is projected to be short by ${shortage.toFixed(0)} t on the current route. It will continue until fuel is exhausted.`,
        shipIds: [ship.shipId],
        metadata: { reachability: ship.reachability },
      });
      this.emit(created ? "alert:new" : "alert:update", clone(alert));
      const ratio = ship.fuel / Math.max(1, ship.reachability.estimatedFuelTons);
      const projectedTravelKm = ship.reachability.routeDistanceKm * Math.min(1, ratio);
      const shortKm = Math.max(0, ship.reachability.routeDistanceKm - projectedTravelKm);
      const predictive = this.alerts.upsert({
        sourceKey: predictiveKey,
        type: "PREDICTIVE_FUEL",
        severity: "warning",
        title: `Predictive fuel warning: ${ship.name}`,
        message: `${ship.name} is projected to run out of fuel about ${shortKm.toFixed(0)} km before ${ship.destinationLabel}.`,
        shipIds: [ship.shipId],
        metadata: { projectedShortfallKm: shortKm },
      });
      this.emit(predictive.created ? "alert:new" : "alert:update", clone(predictive.alert));
    } else {
      for (const key of [sourceKey, predictiveKey]) {
        const resolved = this.alerts.resolve(key);
        if (resolved) this.emit("alert:update", clone(resolved));
      }
    }
  }

  private recomputeStatus(ship: ShipState): void {
    if (ship.fuel <= 0) ship.status = "out_of_fuel";
    else if (ship.status === "stranded" || ship.status === "arrived") return;
    else if (ship.holdPosition) ship.status = "stopped";
    else if ([...this.zones.values()].some((zone) => pointInPolygon(ship.position, zone.points))) ship.status = "zone_breach";
    else if (this.alerts.active().some((a) => a.type === "DISTRESS" && a.shipIds.includes(ship.shipId))) ship.status = "distressed";
    else if (!ship.reachability.reachable) ship.status = "insufficient_fuel";
    else ship.status = "normal";
  }

  private refreshShipWeather(): void {
    for (const ship of this.ships.values()) ship.weather = this.weatherService.at(ship.position);
  }

  private captureHistory(): void {
    const snapshot: HistorySnapshot = {
      timestamp: new Date().toISOString(),
      ships: this.getShips(),
      alerts: this.getAlerts().filter((a) => !a.resolved),
      keyEvents: clone(this.eventBuffer),
    };
    this.eventBuffer = [];
    this.history.push(snapshot);
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.history = this.history.filter((item) => new Date(item.timestamp).getTime() >= cutoff);
    this.emit("history:update", clone(snapshot));
  }

  private logEvent(type: string, message: string): void {
    this.eventBuffer.push({ type, message, timestamp: new Date().toISOString() });
    if (this.eventBuffer.length > 100) this.eventBuffer.shift();
  }

  private validateZone(points: Position[]): void {
    if (!Array.isArray(points) || points.length < 3) throw new Error("Zone requires at least 3 points");
    for (const point of points) {
      if (!isFinitePosition(point)) throw new Error("Invalid zone coordinate");
      if (
        point[0] < this.config.boundingBox.south ||
        point[0] > this.config.boundingBox.north ||
        point[1] < this.config.boundingBox.west ||
        point[1] > this.config.boundingBox.east
      ) throw new Error("Zone point is outside the operating bounding box");
    }
  }

  private ruleAdvisorSuggestions(): AdvisorSuggestion[] {
    const suggestions: AdvisorSuggestion[] = [];
    for (const ship of this.ships.values()) {
      if (!ship.reachability.reachable && ship.status !== "out_of_fuel") {
        suggestions.push({
          id: `fuel-${ship.shipId}`,
          severity: "high",
          title: `Protect ${ship.name} from fuel exhaustion`,
          reasoning: `${ship.name} has ${ship.fuel.toFixed(0)} t but the current route estimates ${ship.reachability.estimatedFuelTons.toFixed(0)} t.`,
          actions: ["Request fuel assistance from the nearest suitable vessel", "Review an efficient route option", "Consider reducing cruise speed if operationally safe"],
          shipIds: [ship.shipId],
          source: "rules",
        });
      }
    }
    const critical = this.alerts.active().filter((a) => a.severity === "critical").slice(0, 3);
    for (const alert of critical) {
      suggestions.push({
        id: `alert-${alert.id}`,
        severity: "critical",
        title: `Respond to ${alert.title}`,
        reasoning: alert.message,
        actions: ["Acknowledge the alert", "Inspect the affected ship route and nearby support vessels", "Issue a directive if course or status should change"],
        shipIds: alert.shipIds,
        source: "rules",
      });
    }
    return suggestions.slice(0, 5);
  }
}
