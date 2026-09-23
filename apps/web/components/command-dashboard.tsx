"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { useInterpolatedFleet } from "@/hooks/use-interpolated-fleet";
import { emitWithAck } from "@/lib/socket";
import { fetchAdvisor, fetchRouteOptions } from "@/lib/api";
import type { AdvisorSuggestion, Alert, HistorySnapshot, Position, RestrictedZone, RouteCandidate, RouteStrategy } from "@/lib/types";
import { FleetMap } from "./fleet-map";
import { StatusPill } from "./status-pill";
import { Metric } from "./metric";

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function beep(): void {
  try {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioContextCtor();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.18);
  } catch { /* browser may block audio until interaction */ }
}

function AlertCard({ alert, onAck }: { alert: Alert; onAck: (id: string) => void }) {
  return (
    <article className={`alert-card severity-${alert.severity} ${alert.acknowledged ? "acknowledged" : ""}`}>
      <div className="alert-head">
        <span className="severity-label">{alert.severity}</span>
        <span className="muted">{relativeTime(alert.createdAt)}</span>
      </div>
      <strong>{alert.title}</strong>
      <p>{alert.message}</p>
      <div className="alert-foot">
        <span>{alert.shipIds.join(" · ")}</span>
        {!alert.acknowledged && !alert.resolved ? <button onClick={() => onAck(alert.id)}>Acknowledge</button> : null}
      </div>
    </article>
  );
}

export function CommandDashboard() {
  const live = useRealtime("command");
  const interpolated = useInterpolatedFleet(live.ships);
  const [selectedShipId, setSelectedShipId] = useState<string>();
  const [destination, setDestination] = useState<string>();
  const [waypointLat, setWaypointLat] = useState("25.80");
  const [waypointLng, setWaypointLng] = useState("56.80");
  const [routeOptions, setRouteOptions] = useState<RouteCandidate[]>([]);
  const [advisor, setAdvisor] = useState<AdvisorSuggestion[]>([]);
  const [advisorDecisions, setAdvisorDecisions] = useState<Record<string, "accepted" | "rejected">>({});
  const [busy, setBusy] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [playbackIndex, setPlaybackIndex] = useState<number | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const lastAlertIds = useRef(new Set<string>());

  const activeAlerts = useMemo(
    () => live.alerts.filter((a) => !a.resolved).sort((a, b) => {
      const rank = { critical: 4, high: 3, warning: 2, info: 1 } as const;
      return rank[b.severity] - rank[a.severity] || b.createdAt.localeCompare(a.createdAt);
    }),
    [live.alerts],
  );

  useEffect(() => {
    const newCritical = activeAlerts.find((a) => a.severity === "critical" && !a.acknowledged && !lastAlertIds.current.has(a.id));
    if (newCritical && audioEnabled) beep();
    lastAlertIds.current = new Set(live.alerts.map((a) => a.id));
  }, [activeAlerts, live.alerts, audioEnabled]);

  useEffect(() => {
    if (!selectedShipId && live.ships[0]) setSelectedShipId(live.ships[0].shipId);
  }, [selectedShipId, live.ships]);

  const playback: HistorySnapshot | undefined = playbackIndex === null ? undefined : live.history[playbackIndex];
  const displayShips = playback ? playback.ships : interpolated;
  const selectedShip = displayShips.find((s) => s.shipId === selectedShipId) ?? displayShips[0];
  const selectedLiveShip = live.ships.find((s) => s.shipId === selectedShip?.shipId);
  const ports = live.bootstrap?.ports ?? [];

  useEffect(() => {
    if (selectedLiveShip) setDestination(selectedLiveShip.destination.startsWith("WAYPOINT") ? ports[0]?.id : selectedLiveShip.destination);
  }, [selectedLiveShip?.shipId, selectedLiveShip?.destination, ports]);

  useEffect(() => {
    if (!live.bootstrap) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const suggestions = await fetchAdvisor();
        if (!cancelled) setAdvisor(suggestions);
      } catch {
        // Command remains fully functional if the optional advisor endpoint/provider is unavailable.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 60000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [live.bootstrap]);

  const run = async (label: string, task: () => Promise<unknown>) => {
    setBusy(label);
    setToast(undefined);
    try {
      await task();
      setToast(`${label} completed`);
      setTimeout(() => setToast(undefined), 2600);
    } catch (error) {
      setToast((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const sendDirective = async (type: string, payload: Record<string, unknown>) => {
    if (!selectedLiveShip) return;
    await emitWithAck(live.socket, "directive:send", { shipId: selectedLiveShip.shipId, type, payload });
  };

  const loadOptions = async () => {
    if (!selectedLiveShip) return;
    await run("Route analysis", async () => setRouteOptions(await fetchRouteOptions(selectedLiveShip.shipId, destination)));
  };

  const loadAdvisor = async () => {
    await run("Advisor refresh", async () => setAdvisor(await fetchAdvisor()));
  };

  const createZone = async (name: string, points: Position[]) => {
    await run("Zone creation", () => emitWithAck(live.socket, "zone:create", { name, points }));
  };
  const updateZone = async (id: string, points: Position[]) => {
    await run("Zone update", () => emitWithAck(live.socket, "zone:update", { id, points }));
  };
  const deleteZone = async (id: string) => {
    await run("Zone deletion", () => emitWithAck(live.socket, "zone:delete", { id }));
  };

  if (!live.bootstrap) {
    return (
      <main className="loading-screen">
        <div className="radar-loader" />
        <h1>Connecting to Crisis Ops</h1>
        <p>{live.error ?? "Waiting for authoritative fleet state…"}</p>
      </main>
    );
  }

  const weatherSource = live.weather.some((w) => w.source === "open-meteo") ? "OPEN-METEO LIVE" : "LOCAL FALLBACK";
  const criticalCount = activeAlerts.filter((a) => a.severity === "critical").length;
  const adverseShips = live.ships.filter((s) => ["adverse", "severe"].includes(s.weather.condition)).length;

  return (
    <main className="ops-page">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">H</span>
          <div><strong>HORMUZ CRISIS OPS</strong><small>Fleet Command · Strait of Hormuz</small></div>
        </div>
        <div className="top-metrics">
          <div><span>FLEET</span><strong>{live.ships.length}/15</strong></div>
          <div><span>CRITICAL</span><strong className={criticalCount ? "danger-text" : ""}>{criticalCount}</strong></div>
          <div><span>WEATHER</span><strong>{adverseShips} adverse</strong></div>
          <div><span>FEED</span><strong className="live-text"><i /> {live.connected ? "LIVE" : "RECONNECTING"}</strong></div>
        </div>
        <div className="top-actions">
          <button className={`ghost-link alarm-toggle ${audioEnabled ? "enabled" : ""}`} onClick={() => { setAudioEnabled(true); beep(); }}>Alarm {audioEnabled ? "ON" : "ENABLE"}</button>
          <a className="ghost-link" href="/captain/MV-1">Captain View</a>
          <span className="weather-source">{weatherSource}</span>
        </div>
      </header>

      {toast ? <div className="toast">{toast}</div> : null}

      <section className="command-grid">
        <aside className="fleet-sidebar panel">
          <div className="panel-heading"><div><span className="eyebrow">ACTIVE ASSETS</span><h2>Fleet</h2></div><span className="count-badge">{live.ships.length}</span></div>
          <div className="fleet-list">
            {live.ships.map((ship) => (
              <button key={ship.shipId} className={`fleet-row ${selectedShipId === ship.shipId ? "active" : ""}`} onClick={() => { setSelectedShipId(ship.shipId); setRouteOptions([]); setPlaybackIndex(null); }}>
                <span className={`fleet-signal ${["distressed", "zone_breach", "out_of_fuel", "stranded"].includes(ship.status) ? "danger" : ship.status === "insufficient_fuel" ? "warning" : ""}`} />
                <span className="fleet-copy"><strong>{ship.name}</strong><small>{ship.shipId} · {ship.cargo}</small></span>
                <span className="fleet-right"><b>{ship.speed.toFixed(0)} kn</b><small>{Math.max(0, ship.fuel).toFixed(0)} t</small></span>
              </button>
            ))}
          </div>
        </aside>

        <section className="map-column panel">
          <FleetMap
            ships={displayShips}
            zones={live.zones}
            weather={live.weather}
            navigableWater={live.bootstrap.navigableWater}
            selectedShipId={selectedShip?.shipId}
            onSelectShip={(id) => { setSelectedShipId(id); setPlaybackIndex(null); }}
            commandMode
            onCreateZone={createZone}
            onUpdateZone={updateZone}
            onDeleteZone={deleteZone}
          />
          <div className="timeline-bar">
            <div className="timeline-title"><span className="eyebrow">PLAYBACK</span><strong>{playback ? new Date(playback.timestamp).toLocaleTimeString() : "Live state"}</strong></div>
            <input
              aria-label="Fleet history timeline"
              type="range"
              min={0}
              max={Math.max(0, live.history.length)}
              value={playbackIndex === null ? live.history.length : playbackIndex}
              onChange={(e) => {
                const value = Number(e.target.value);
                setPlaybackIndex(value >= live.history.length ? null : value);
              }}
            />
            <button className={playbackIndex === null ? "live-chip" : ""} onClick={() => setPlaybackIndex(null)}>● LIVE</button>
            <span className="history-note">{live.history.length} snapshots / last hour</span>
          </div>
        </section>

        <aside className="alerts-sidebar panel">
          <div className="panel-heading"><div><span className="eyebrow">PRIORITY PIPELINE</span><h2>Alerts</h2></div><span className="count-badge alert">{activeAlerts.length}</span></div>
          <div className="alerts-list">
            {activeAlerts.length ? activeAlerts.map((alert) => (
              <AlertCard key={alert.id} alert={alert} onAck={(id) => run("Alert acknowledgement", () => emitWithAck(live.socket, "alert:ack", { id }))} />
            )) : <div className="empty-state"><span>✓</span><strong>No active alerts</strong><p>Geofence, proximity, distress, fuel, and assistance events appear here.</p></div>}
          </div>
          <div className="assistance-feed">
            <span className="eyebrow">ASSISTANCE ACTIVITY</span>
            {live.assistance.length ? live.assistance.slice(0, 4).map((request) => (
              <div className="mini-row" key={request.id}>
                <span>{request.fromShipId} → {request.toShipId} · {request.kind.replace("_", " ")}</span>
                <strong className={`assistance-${request.status}`}>{request.status}</strong>
              </div>
            )) : <small className="muted">No requests yet</small>}
          </div>
        </aside>
      </section>

      <section className="lower-grid">
        <section className="panel ship-console">
          {selectedLiveShip ? (
            <>
              <div className="ship-title-row">
                <div><span className="eyebrow">SELECTED VESSEL · {selectedLiveShip.shipId}</span><h2>{selectedLiveShip.name}</h2></div>
                <StatusPill value={selectedLiveShip.status} />
              </div>
              <div className="metric-grid">
                <Metric label="Destination" value={selectedLiveShip.destinationLabel} sub={`${selectedLiveShip.reachability.routeDistanceKm.toFixed(0)} km remaining route`} />
                <Metric label="Fuel" value={`${selectedLiveShip.fuel.toFixed(0)} t`} sub={selectedLiveShip.reachability.reachable ? "Reachable on current plan" : `Projected shortfall ${Math.abs(selectedLiveShip.reachability.fuelRemainingAtArrival).toFixed(0)} t`} />
                <Metric label="Speed / Heading" value={`${selectedLiveShip.speed.toFixed(0)} kn · ${selectedLiveShip.heading.toFixed(0)}°`} sub={selectedLiveShip.routeStrategy.toUpperCase()} />
                <Metric label="Weather" value={selectedLiveShip.weather.condition} sub={`${selectedLiveShip.weather.windKnots.toFixed(0)} kn wind · ×${selectedLiveShip.weather.fuelMultiplier.toFixed(1)} fuel`} />
              </div>
              <div className="directive-grid">
                <div className="directive-box">
                  <span className="eyebrow">COMMAND DIRECTIVE</span>
                  <label>Destination port<select value={destination ?? ""} onChange={(e) => setDestination(e.target.value)}>{ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                  <div className="button-row">
                    <button className="primary-btn" disabled={!destination || !!busy} onClick={() => run("Directive sent", () => sendDirective("REROUTE_PORT", { portId: destination, strategy: "safe" }))}>Send reroute</button>
                    <button className="secondary-btn" disabled={!!busy} onClick={loadOptions}>Analyze 3 routes</button>
                  </div>
                  <div className="waypoint-row">
                    <label>Waypoint lat<input value={waypointLat} onChange={(e) => setWaypointLat(e.target.value)} /></label>
                    <label>Waypoint lng<input value={waypointLng} onChange={(e) => setWaypointLng(e.target.value)} /></label>
                    <button className="secondary-btn" onClick={() => run("Waypoint directive sent", () => sendDirective("DIVERT_WAYPOINT", { waypoint: [Number(waypointLat), Number(waypointLng)] as Position, strategy: "safe" }))}>Divert</button>
                  </div>
                  <div className="button-row compact">
                    <button className="secondary-btn" onClick={() => run("Hold directive sent", () => sendDirective("HOLD_POSITION", {}))}>Hold position</button>
                    <button className="secondary-btn" onClick={() => run("Resume directive sent", () => sendDirective("RESUME", {}))}>Resume</button>
                  </div>
                </div>

                <div className="route-options-box">
                  <span className="eyebrow">ROUTE OPTIONS BONUS</span>
                  {routeOptions.length ? routeOptions.map((route) => (
                    <div className="route-option" key={route.strategy}>
                      <div><strong>{route.strategy.toUpperCase()}</strong><small>{route.distanceKm.toFixed(0)} km · {route.estimatedFuelTons.toFixed(0)} t fuel · {route.adverseExposureKm.toFixed(0)} km adverse</small></div>
                      <div className="route-option-actions"><span className={route.reachable ? "good-text" : "danger-text"}>{route.reachable ? "reachable" : "short fuel"}</span><button onClick={() => run(`${route.strategy} route directive sent`, () => sendDirective("REROUTE_PORT", { portId: destination, strategy: route.strategy as RouteStrategy }))}>Send</button></div>
                    </div>
                  )) : <p className="muted block-copy">Generate fast, weather-safe, and fuel-efficient candidate routes before issuing a captain directive.</p>}
                </div>
              </div>
            </>
          ) : null}
        </section>

        <section className="panel advisor-panel">
          <div className="panel-heading"><div><span className="eyebrow">PROACTIVE OPERATIONS</span><h2>AI Fleet Advisor</h2></div><button className="secondary-btn" onClick={loadAdvisor} disabled={!!busy}>Refresh</button></div>
          <p className="muted block-copy">Uses the configured AI provider when available and a deterministic operational rules fallback when offline.</p>
          <div className="advisor-list">
            {advisor.length ? advisor.map((item) => (
              <article key={item.id} className={`advisor-card severity-${item.severity}`}>
                <div className="advisor-top"><strong>{item.title}</strong><span>{item.source.toUpperCase()}</span></div>
                <p>{item.reasoning}</p>
                <ul>{item.actions.map((action) => <li key={action}>{action}</li>)}</ul>
                <div className="advisor-actions">
                  <button className={advisorDecisions[item.id] === "accepted" ? "accepted" : ""} onClick={() => { setAdvisorDecisions((old) => ({ ...old, [item.id]: "accepted" })); setToast(`Accepted advisor suggestion: ${item.title}`); }}>Accept</button>
                  <button className={advisorDecisions[item.id] === "rejected" ? "rejected" : ""} onClick={() => { setAdvisorDecisions((old) => ({ ...old, [item.id]: "rejected" })); setToast(`Rejected advisor suggestion: ${item.title}`); }}>Reject</button>
                  {advisorDecisions[item.id] ? <span>{advisorDecisions[item.id]}</span> : null}
                </div>
              </article>
            )) : <div className="empty-state small"><span>◇</span><strong>Advisor standing by</strong><p>Refresh to evaluate live fleet status and active alerts.</p></div>}
          </div>
        </section>
      </section>
    </main>
  );
}
