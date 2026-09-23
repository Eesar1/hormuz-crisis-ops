"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { SERVER_URL } from "@/lib/api";
import type {
  Alert,
  AssistanceRequest,
  Bootstrap,
  Directive,
  HistorySnapshot,
  RestrictedZone,
  ShipState,
  WeatherCell,
} from "@/lib/types";

interface RealtimeState {
  connected: boolean;
  error?: string;
  bootstrap?: Bootstrap;
  ships: ShipState[];
  zones: RestrictedZone[];
  alerts: Alert[];
  directives: Directive[];
  assistance: AssistanceRequest[];
  weather: WeatherCell[];
  history: HistorySnapshot[];
  socket?: Socket;
}

function replaceById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((x) => x.id === item.id);
  if (index === -1) return [item, ...items];
  const next = [...items];
  next[index] = item;
  return next;
}

export function useRealtime(role: "command" | "captain", shipId?: string): RealtimeState {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [ships, setShips] = useState<ShipState[]>([]);
  const [zones, setZones] = useState<RestrictedZone[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [assistance, setAssistance] = useState<AssistanceRequest[]>([]);
  const [weather, setWeather] = useState<WeatherCell[]>([]);
  const [history, setHistory] = useState<HistorySnapshot[]>([]);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(SERVER_URL, {
      transports: ["websocket"],
      auth: { role, shipId },
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
    socketRef.current = socket;
    socket.on("connect", () => { setConnected(true); setError(undefined); });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => setError(err.message));
    socket.on("session:error", (payload: { message: string }) => setError(payload.message));
    socket.on("bootstrap", (data: Bootstrap) => {
      setBootstrap(data);
      setShips(data.ships);
      setZones(data.zones);
      setAlerts(data.alerts);
      setDirectives(data.directives);
      setAssistance(data.assistance);
      setWeather(data.weather);
      setHistory(data.history);
    });
    socket.on("fleet:update", (data: ShipState[]) => setShips(data));
    socket.on("zone:update", (data: RestrictedZone[]) => setZones(data));
    socket.on("alert:new", (data: Alert) => setAlerts((old) => replaceById(old, data)));
    socket.on("alert:update", (data: Alert) => setAlerts((old) => replaceById(old, data)));
    socket.on("directive:new", (data: Directive) => setDirectives((old) => replaceById(old, data)));
    socket.on("directive:update", (data: Directive) => setDirectives((old) => replaceById(old, data)));
    socket.on("assistance:new", (data: AssistanceRequest) => setAssistance((old) => replaceById(old, data)));
    socket.on("assistance:update", (data: AssistanceRequest) => setAssistance((old) => replaceById(old, data)));
    socket.on("weather:update", (data: WeatherCell[]) => setWeather(data));
    socket.on("history:update", (data: HistorySnapshot) => {
      setHistory((old) => [...old, data].filter((x) => Date.now() - new Date(x.timestamp).getTime() <= 3600000));
    });
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [role, shipId]);

  return useMemo(() => ({
    connected,
    error,
    bootstrap,
    ships,
    zones,
    alerts,
    directives,
    assistance,
    weather,
    history,
    socket: socketRef.current ?? undefined,
  }), [connected, error, bootstrap, ships, zones, alerts, directives, assistance, weather, history]);
}
