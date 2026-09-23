export type Position = [number, number];
export type Severity = "info" | "warning" | "high" | "critical";
export type RouteStrategy = "fast" | "safe" | "efficient";

export interface WeatherInfo {
  condition: "normal" | "moderate" | "adverse" | "severe";
  windKnots: number;
  gustKnots: number;
  precipitationMm: number;
  weatherCode: number;
  fuelMultiplier: number;
  source: "open-meteo" | "fallback";
  sampledAt: string;
}
export interface WeatherCell extends WeatherInfo { id: string; position: Position }
export interface Reachability { reachable: boolean; routeDistanceKm: number; estimatedFuelTons: number; fuelRemainingAtArrival: number }
export interface ShipState {
  shipId: string;
  name: string;
  position: Position;
  speed: number;
  cruiseSpeed: number;
  heading: number;
  destination: string;
  destinationLabel: string;
  destinationPosition: Position;
  fuel: number;
  cargo: string;
  status: string;
  route: Position[];
  routeIndex: number;
  routeStrategy: RouteStrategy;
  holdPosition: boolean;
  weather: WeatherInfo;
  reachability: Reachability;
  updatedAt: string;
}
export interface Port { id: string; name: string; position: Position }
export interface RestrictedZone { id: string; name: string; points: Position[]; createdAt: string; updatedAt: string }
export interface Alert {
  id: string; sourceKey: string; type: string; severity: Severity; title: string; message: string; shipIds: string[];
  createdAt: string; updatedAt: string; acknowledged: boolean; acknowledgedAt?: string; resolved: boolean; resolvedAt?: string;
  metadata?: Record<string, unknown>;
}
export interface Directive {
  id: string; shipId: string; type: "REROUTE_PORT" | "DIVERT_WAYPOINT" | "HOLD_POSITION" | "RESUME";
  payload: { portId?: string; waypoint?: Position; strategy?: RouteStrategy; note?: string };
  status: "pending" | "accepted" | "escalated" | "applied"; createdAt: string; respondedAt?: string; responseMessage?: string;
}
export interface AssistanceRequest {
  id: string; fromShipId: string; toShipId: string; kind: "fuel" | "medical" | "escort" | "cargo_offload";
  message?: string; distanceKm: number; status: "pending" | "accepted" | "declined"; createdAt: string; respondedAt?: string;
}
export interface HistorySnapshot { timestamp: string; ships: ShipState[]; alerts: Alert[]; keyEvents: Array<{ type: string; message: string; timestamp: string }> }
export interface RouteCandidate { strategy: RouteStrategy; path: Position[]; distanceKm: number; estimatedFuelTons: number; adverseExposureKm: number; reachable: boolean }
export interface AdvisorSuggestion { id: string; severity: Severity; title: string; reasoning: string; actions: string[]; shipIds: string[]; source: "openai" | "rules" }
export interface Bootstrap {
  scenario: { name: string; description: string };
  boundingBox: { north: number; south: number; east: number; west: number };
  navigableWater: Position[];
  ports: Port[];
  ships: ShipState[];
  zones: RestrictedZone[];
  alerts: Alert[];
  directives: Directive[];
  assistance: AssistanceRequest[];
  weather: WeatherCell[];
  history: HistorySnapshot[];
  serverTime: string;
}
