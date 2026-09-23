"use client";

import { useEffect, useRef, useState } from "react";
import type { ShipState } from "@/lib/types";

interface FrameState {
  previous: ShipState[];
  target: ShipState[];
  receivedAt: number;
  intervalMs: number;
}

export function useInterpolatedFleet(ships: ShipState[]): ShipState[] {
  const [renderShips, setRenderShips] = useState<ShipState[]>(ships);
  const frame = useRef<FrameState>({ previous: ships, target: ships, receivedAt: typeof performance !== "undefined" ? performance.now() : 0, intervalMs: 250 });
  const lastReceive = useRef<number>(typeof performance !== "undefined" ? performance.now() : 0);

  useEffect(() => {
    const now = performance.now();
    const intervalMs = Math.min(1000, Math.max(100, now - lastReceive.current));
    lastReceive.current = now;
    frame.current = {
      previous: frame.current.target.length ? frame.current.target : ships,
      target: ships,
      receivedAt: now,
      intervalMs,
    };
  }, [ships]);

  useEffect(() => {
    let raf = 0;
    let lastPaint = 0;
    const animate = (timestamp: number) => {
      if (timestamp - lastPaint < 33) {
        raf = requestAnimationFrame(animate);
        return;
      }
      lastPaint = timestamp;
      const current = frame.current;
      const t = Math.min(1, Math.max(0, (timestamp - current.receivedAt) / current.intervalMs));
      const byId = new Map(current.previous.map((ship) => [ship.shipId, ship]));
      const next = current.target.map((target) => {
        const previous = byId.get(target.shipId);
        if (!previous) return target;
        return {
          ...target,
          position: [
            previous.position[0] + (target.position[0] - previous.position[0]) * t,
            previous.position[1] + (target.position[1] - previous.position[1]) * t,
          ] as [number, number],
        };
      });
      setRenderShips(next);
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, []);

  return renderShips;
}
