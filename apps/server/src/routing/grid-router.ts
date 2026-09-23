import type { FleetConfig, Position, RestrictedZone, RouteCandidate, RouteStrategy, WeatherInfo } from "../types.js";
import { haversineKm, interpolate, pointInPolygon, polylineDistanceKm, segmentIntersectsPolygon } from "../utils/geo.js";
import { MinHeap } from "../utils/min-heap.js";

interface GridNode {
  r: number;
  c: number;
}

interface RouterWeather {
  at(position: Position): WeatherInfo;
}

const GRID_STEP = 0.05;
const FUEL_TONS_PER_KM_BASE = 1.4;

const STRATEGY_WEATHER_WEIGHT: Record<RouteStrategy, number> = {
  fast: 0.35,
  safe: 7.0,
  efficient: 2.5,
};

function lineIntersection(a: Position, b: Position, c: Position, d: Position): Position | null {
  const x1 = a[1], y1 = a[0], x2 = b[1], y2 = b[0];
  const x3 = c[1], y3 = c[0], x4 = d[1], y4 = d[0];
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denominator) < 1e-12) return null;
  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denominator;
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denominator;
  const within = (value: number, p: number, q: number) => value >= Math.min(p, q) - 1e-9 && value <= Math.max(p, q) + 1e-9;
  if (!within(px, x1, x2) || !within(py, y1, y2) || !within(px, x3, x4) || !within(py, y3, y4)) return null;
  return [py, px];
}

function findBoundarySelfIntersections(ring: Position[]): Position[] {
  const points: Position[] = [];
  const segmentCount = Math.max(0, ring.length - 1);
  for (let i = 0; i < segmentCount; i++) {
    for (let j = i + 1; j < segmentCount; j++) {
      if (Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === segmentCount - 1) continue;
      const hit = lineIntersection(ring[i], ring[i + 1], ring[j], ring[j + 1]);
      if (hit && !points.some((p) => haversineKm(p, hit) < 0.5)) points.push(hit);
    }
  }
  return points;
}

export class GridRouter {
  private readonly rows: number;
  private readonly cols: number;
  private readonly waterRepairPoints: Position[];

  constructor(
    private readonly config: FleetConfig,
    private readonly weather: RouterWeather,
  ) {
    this.rows = Math.ceil((config.boundingBox.north - config.boundingBox.south) / GRID_STEP) + 1;
    this.cols = Math.ceil((config.boundingBox.east - config.boundingBox.west) / GRID_STEP) + 1;
    this.waterRepairPoints = findBoundarySelfIntersections(config.navigableWater);
  }

  route(start: Position, goal: Position, zones: RestrictedZone[], strategy: RouteStrategy = "safe"): Position[] | null {
    // A destination inside a restricted area is intentionally unreachable. The start may be
    // inside a newly drawn zone so the ship can compute an escape route out of it.
    if (!this.isInsideNavigableWater(goal) || zones.some((zone) => pointInPolygon(goal, zone.points))) return null;
    const containingZones = zones.filter((zone) => pointInPolygon(start, zone.points));
    if (containingZones.length) {
      const otherZones = zones.filter((zone) => !containingZones.includes(zone));
      for (const escape of this.escapeCandidates(start, goal, zones)) {
        if (!this.lineIsNavigable(start, escape, otherZones)) continue;
        const remainder = this.route(escape, goal, zones, strategy);
        if (remainder) return [start, ...remainder];
      }
      return null;
    }
    const direct = this.lineIsNavigable(start, goal, zones);
    if (direct) return [start, goal];

    const startNode = this.nearestNavigableNode(start, zones);
    const goalNode = this.nearestNavigableNode(goal, zones);
    if (!startNode || !goalNode) return null;

    const startKey = this.key(startNode);
    const goalKey = this.key(goalNode);
    const open = new MinHeap<GridNode>();
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[startKey, 0]]);
    const nodes = new Map<string, GridNode>([[startKey, startNode], [goalKey, goalNode]]);
    const closed = new Set<string>();

    open.push({ priority: this.heuristic(startNode, goalNode), value: startNode });

    while (open.size) {
      const current = open.pop()!.value;
      const currentKey = this.key(current);
      if (closed.has(currentKey)) continue;
      if (currentKey === goalKey) {
        const nodePath = this.reconstructPath(cameFrom, nodes, currentKey);
        const raw = [start, ...nodePath.map((node) => this.nodeToPosition(node)), goal];
        return this.smoothPath(raw, zones);
      }
      closed.add(currentKey);

      for (const neighbor of this.neighbors(current)) {
        const neighborKey = this.key(neighbor);
        if (closed.has(neighborKey) || !this.nodeIsNavigable(neighbor, zones)) continue;
        const a = this.nodeToPosition(current);
        const b = this.nodeToPosition(neighbor);
        if (!this.lineIsNavigable(a, b, zones)) continue;

        const base = haversineKm(a, b);
        const condition = this.weather.at(b).condition;
        const weatherRisk = condition === "severe" ? 1 : condition === "adverse" ? 0.65 : condition === "moderate" ? 0.2 : 0;
        const cost = base * (1 + weatherRisk * STRATEGY_WEATHER_WEIGHT[strategy]);
        const tentative = (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + cost;
        if (tentative >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) continue;

        cameFrom.set(neighborKey, currentKey);
        gScore.set(neighborKey, tentative);
        nodes.set(neighborKey, neighbor);
        open.push({ priority: tentative + this.heuristic(neighbor, goalNode), value: neighbor });
      }
    }

    return null;
  }

  candidates(start: Position, goal: Position, zones: RestrictedZone[], fuelTons: number, speedKnots: number): RouteCandidate[] {
    const strategies: RouteStrategy[] = ["fast", "safe", "efficient"];
    return strategies.map((strategy) => {
      const path = this.route(start, goal, zones, strategy) ?? [];
      const distanceKm = path.length ? polylineDistanceKm(path) : 0;
      const adverseExposureKm = this.adverseExposure(path);
      const weatherPenalty = distanceKm > 0 ? adverseExposureKm / distanceKm : 0;
      const speedFactor = Math.max(0.72, Math.pow(Math.max(1, speedKnots) / 15, 1.35));
      const estimatedFuelTons = distanceKm * FUEL_TONS_PER_KM_BASE * speedFactor * (1 + weatherPenalty * 0.3);
      return {
        strategy,
        path,
        distanceKm,
        estimatedFuelTons,
        adverseExposureKm,
        reachable: path.length > 0 && fuelTons >= estimatedFuelTons,
      };
    });
  }

  estimateFuel(path: Position[], speedKnots: number): { distanceKm: number; fuelTons: number; adverseExposureKm: number } {
    const distanceKm = polylineDistanceKm(path);
    const adverseExposureKm = this.adverseExposure(path);
    const speedFactor = Math.max(0.72, Math.pow(Math.max(1, speedKnots) / 15, 1.35));
    const weatherPenalty = distanceKm > 0 ? adverseExposureKm / distanceKm : 0;
    const fuelTons = distanceKm * FUEL_TONS_PER_KM_BASE * speedFactor * (1 + weatherPenalty * 0.3);
    return { distanceKm, fuelTons, adverseExposureKm };
  }

  fuelBurnPerKm(speedKnots: number, weatherMultiplier: number): number {
    const speedFactor = Math.max(0.72, Math.pow(Math.max(1, speedKnots) / 15, 1.35));
    return FUEL_TONS_PER_KM_BASE * speedFactor * weatherMultiplier;
  }

  private adverseExposure(path: Position[]): number {
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const midpoint = interpolate(path[i], path[i + 1], 0.5);
      const condition = this.weather.at(midpoint).condition;
      if (condition === "adverse" || condition === "severe") total += haversineKm(path[i], path[i + 1]);
    }
    return total;
  }

  private nearestNavigableNode(position: Position, zones: RestrictedZone[]): GridNode | null {
    const approx = this.positionToNode(position);
    const maxRadius = 12;
    for (let radius = 0; radius <= maxRadius; radius++) {
      let best: GridNode | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (radius > 0 && Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
          const node = { r: approx.r + dr, c: approx.c + dc };
          if (!this.nodeIsNavigable(node, zones)) continue;
          const distance = haversineKm(position, this.nodeToPosition(node));
          if (distance < bestDistance) {
            best = node;
            bestDistance = distance;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  private escapeCandidates(start: Position, goal: Position, zones: RestrictedZone[]): Position[] {
    const center = this.positionToNode(start);
    const candidates: Position[] = [];
    for (let radius = 1; radius <= 12; radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
          const node = { r: center.r + dr, c: center.c + dc };
          if (this.nodeIsNavigable(node, zones)) candidates.push(this.nodeToPosition(node));
        }
      }
    }
    return candidates.sort((a, b) => haversineKm(a, goal) - haversineKm(b, goal)).slice(0, 16);
  }

  private positionToNode(position: Position): GridNode {
    return {
      r: Math.round((position[0] - this.config.boundingBox.south) / GRID_STEP),
      c: Math.round((position[1] - this.config.boundingBox.west) / GRID_STEP),
    };
  }

  private nodeToPosition(node: GridNode): Position {
    return [
      this.config.boundingBox.south + node.r * GRID_STEP,
      this.config.boundingBox.west + node.c * GRID_STEP,
    ];
  }

  private nodeIsNavigable(node: GridNode, zones: RestrictedZone[]): boolean {
    if (node.r < 0 || node.c < 0 || node.r >= this.rows || node.c >= this.cols) return false;
    const point = this.nodeToPosition(node);
    if (!this.isInsideNavigableWater(point)) return false;
    return !zones.some((zone) => pointInPolygon(point, zone.points));
  }

  private lineIsNavigable(a: Position, b: Position, zones: RestrictedZone[]): boolean {
    if (zones.some((zone) => segmentIntersectsPolygon(a, b, zone.points))) return false;
    const distanceDeg = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    const samples = Math.max(2, Math.ceil(distanceDeg / (GRID_STEP / 2)));
    for (let i = 0; i <= samples; i++) {
      const point = interpolate(a, b, i / samples);
      if (!this.isInsideNavigableWater(point)) return false;
      if (zones.some((zone) => pointInPolygon(point, zone.points))) return false;
    }
    return true;
  }

  private isInsideNavigableWater(point: Position): boolean {
    if (pointInPolygon(point, this.config.navigableWater)) return true;
    // The supplied simplified water ring contains a tiny self-crossing at the Strait throat.
    // Treat a small radius around each detected boundary crossing as water so the two intended
    // lobes remain connected, while all normal routing still obeys the supplied polygon.
    return this.waterRepairPoints.some((crossing) => haversineKm(point, crossing) <= 18);
  }

  private smoothPath(path: Position[], zones: RestrictedZone[]): Position[] {
    if (path.length <= 2) return path;
    const result: Position[] = [path[0]];
    let anchor = 0;
    while (anchor < path.length - 1) {
      let furthest = anchor + 1;
      for (let candidate = path.length - 1; candidate > anchor + 1; candidate--) {
        if (this.lineIsNavigable(path[anchor], path[candidate], zones)) {
          furthest = candidate;
          break;
        }
      }
      result.push(path[furthest]);
      anchor = furthest;
    }
    return result;
  }

  private neighbors(node: GridNode): GridNode[] {
    const offsets = [
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1],            [0, 1],
      [1, -1],  [1, 0],  [1, 1],
    ];
    return offsets.map(([dr, dc]) => ({ r: node.r + dr, c: node.c + dc }));
  }

  private heuristic(a: GridNode, b: GridNode): number {
    return haversineKm(this.nodeToPosition(a), this.nodeToPosition(b));
  }

  private key(node: GridNode): string {
    return `${node.r}:${node.c}`;
  }

  private reconstructPath(cameFrom: Map<string, string>, nodes: Map<string, GridNode>, currentKey: string): GridNode[] {
    const keys = [currentKey];
    while (cameFrom.has(currentKey)) {
      currentKey = cameFrom.get(currentKey)!;
      keys.push(currentKey);
    }
    keys.reverse();
    return keys.map((key) => nodes.get(key)!).filter(Boolean);
  }
}
