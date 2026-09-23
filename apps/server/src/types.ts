export type Position = [number, number]; // [lat, lng]

export type ShipStatus =
  | "normal"
  | "rerouting"
  | "distressed"
  | "stopped"
  | "stranded"
  | "insufficient_fuel"
  | "out_of_fuel"
  | "zone_breach"
  | "arrived";

export type RouteStrategy = "fast" | "safe" | "efficient";

export interface Port {
  id: string;
  name: string;
  position: Position;
}

export interface FleetConfigShip {
  shipId: string;
  name: string;
  position: Position;
  speed: number;
  heading: number;
  destination: string;
  fuel: number;
  cargo: string;
  status: ShipStatus;
}

export interface FleetConfig {
  scenario: { name: string; description: string };
  coordinateFormat: string;
  units: { speed: string; fuel: string; heading: string };
  boundingBox: { north: number; south: number; east: number; west: number };
  navigableWater: Position[];
  ports: Port[];
  fleet: FleetConfigShip[];
}

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

export interface WeatherCell extends WeatherInfo {
  id: string;
  position: Position;
}

export interface Reachability {
  reachable: boolean;
  routeDistanceKm: number;
  estimatedFuelTons: number;
  fuelRemainingAtArrival: number;
}

export interface ShipState extends FleetConfigShip {
  cruiseSpeed: number;
  destinationLabel: string;
  destinationPosition: Position;
  route: Position[];
  routeIndex: number;
  routeStrategy: RouteStrategy;
  holdPosition: boolean;
  weather: WeatherInfo;
  reachability: Reachability;
  updatedAt: string;
}

export interface RestrictedZone {
  id: string;
  name: string;
  points: Position[];
  createdAt: string;
  updatedAt: string;
}

export type AlertType =
  | "GEOFENCE_BREACH"
  | "PROXIMITY"
  | "DISTRESS"
  | "STRANDED"
  | "INSUFFICIENT_FUEL"
  | "OUT_OF_FUEL"
  | "PREDICTIVE_FUEL"
  | "ASSISTANCE";

export type Severity = "info" | "warning" | "high" | "critical";

export interface Alert {
  id: string;
  sourceKey: string;
  type: AlertType;
  severity: Severity;
  title: string;
  message: string;
  shipIds: string[];
  createdAt: string;
  updatedAt: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
  resolved: boolean;
  resolvedAt?: string;
  metadata?: Record<string, unknown>;
}

export type DirectiveType = "REROUTE_PORT" | "DIVERT_WAYPOINT" | "HOLD_POSITION" | "RESUME";
export type DirectiveStatus = "pending" | "accepted" | "escalated" | "applied";

export interface Directive {
  id: string;
  shipId: string;
  type: DirectiveType;
  payload: {
    portId?: string;
    waypoint?: Position;
    strategy?: RouteStrategy;
    note?: string;
  };
  status: DirectiveStatus;
  createdAt: string;
  respondedAt?: string;
  responseMessage?: string;
}

export interface DistressAnalysis {
  severity: Severity;
  incidentType: string[];
  injuries?: number;
  damageEstimate?: string;
  quantifiableImpact: string[];
  summary: string;
  recommendedPriority: number;
  provider: "openai" | "heuristic";
}

export type AssistanceKind = "fuel" | "medical" | "escort" | "cargo_offload";
export type AssistanceStatus = "pending" | "accepted" | "declined";

export interface AssistanceRequest {
  id: string;
  fromShipId: string;
  toShipId: string;
  kind: AssistanceKind;
  message?: string;
  distanceKm: number;
  status: AssistanceStatus;
  createdAt: string;
  respondedAt?: string;
}

export interface HistorySnapshot {
  timestamp: string;
  ships: ShipState[];
  alerts: Alert[];
  keyEvents: Array<{ type: string; message: string; timestamp: string }>;
}

export interface RouteCandidate {
  strategy: RouteStrategy;
  path: Position[];
  distanceKm: number;
  estimatedFuelTons: number;
  adverseExposureKm: number;
  reachable: boolean;
}

export interface AdvisorSuggestion {
  id: string;
  severity: Severity;
  title: string;
  reasoning: string;
  actions: string[];
  shipIds: string[];
  source: "openai" | "rules";
}
