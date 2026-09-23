import { describe, expect, it } from "vitest";
import { haversineKm, pointInPolygon, segmentsIntersect } from "../src/utils/geo.js";

describe("geo helpers", () => {
  it("computes realistic short distance", () => {
    const d = haversineKm([25, 55], [25.01, 55]);
    expect(d).toBeGreaterThan(1.0);
    expect(d).toBeLessThan(1.2);
  });

  it("detects a point inside a polygon", () => {
    expect(pointInPolygon([1, 1], [[0, 0], [0, 2], [2, 2], [2, 0]])).toBe(true);
    expect(pointInPolygon([3, 3], [[0, 0], [0, 2], [2, 2], [2, 0]])).toBe(false);
  });

  it("detects segment intersection", () => {
    expect(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
  });
});
