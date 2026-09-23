import type { Position } from "../types.js";

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (degrees: number) => (degrees * Math.PI) / 180;
const toDeg = (radians: number) => (radians * 180) / Math.PI;

export function haversineKm(a: Position, b: Position): number {
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLat = lat2 - lat1;
  const dLng = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(a: Position, b: Position): number {
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLng = toRad(b[1] - a[1]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function moveToward(start: Position, end: Position, distanceKm: number): Position {
  const fullDistance = haversineKm(start, end);
  if (fullDistance <= distanceKm || fullDistance < 1e-9) return [...end] as Position;

  const bearing = toRad(bearingDegrees(start, end));
  const angularDistance = distanceKm / EARTH_RADIUS_KM;
  const lat1 = toRad(start[0]);
  const lng1 = toRad(start[1]);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return [toDeg(lat2), ((toDeg(lng2) + 540) % 360) - 180];
}

export function pointInPolygon(point: Position, polygon: Position[]): boolean {
  if (polygon.length < 3) return false;
  const y = point[0];
  const x = point[1];
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i][0];
    const xi = polygon[i][1];
    const yj = polygon[j][0];
    const xj = polygon[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function orientation(a: Position, b: Position, c: Position): number {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) < 1e-10) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a: Position, b: Position, c: Position): boolean {
  return (
    b[1] <= Math.max(a[1], c[1]) + 1e-10 &&
    b[1] >= Math.min(a[1], c[1]) - 1e-10 &&
    b[0] <= Math.max(a[0], c[0]) + 1e-10 &&
    b[0] >= Math.min(a[0], c[0]) - 1e-10
  );
}

export function segmentsIntersect(p1: Position, q1: Position, p2: Position, q2: Position): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

export function segmentIntersectsPolygon(a: Position, b: Position, polygon: Position[]): boolean {
  if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return true;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    if (segmentsIntersect(a, b, p, q)) return true;
  }
  return false;
}

export function pathIntersectsPolygon(path: Position[], polygon: Position[]): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    if (segmentIntersectsPolygon(path[i], path[i + 1], polygon)) return true;
  }
  return false;
}

export function polylineDistanceKm(path: Position[], startIndex = 0): number {
  let total = 0;
  for (let i = Math.max(0, startIndex); i < path.length - 1; i++) {
    total += haversineKm(path[i], path[i + 1]);
  }
  return total;
}

export function interpolate(a: Position, b: Position, t: number): Position {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function isFinitePosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}
