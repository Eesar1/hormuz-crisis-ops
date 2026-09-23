"use client";

import { useEffect, useMemo, useState } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { useInterpolatedFleet } from "@/hooks/use-interpolated-fleet";
import { emitWithAck } from "@/lib/socket";
import type { AssistanceRequest, Directive } from "@/lib/types";
import { FleetMap } from "./fleet-map";
import { StatusPill } from "./status-pill";
import { Metric } from "./metric";

export function CaptainDashboard({ shipId }: { shipId: string }) {
  const live = useRealtime("captain", shipId);
  const interpolated = useInterpolatedFleet(live.ships);
  const ship = interpolated.find((item) => item.shipId === shipId);
  const liveShip = live.ships.find((item) => item.shipId === shipId);
  const [distress, setDistress] = useState("");
  const [escalationMessages, setEscalationMessages] = useState<Record<string, string>>({});
  const [assistanceKind, setAssistanceKind] = useState<"fuel" | "medical" | "escort" | "cargo_offload">("fuel");
  const [assistMessage, setAssistMessage] = useState("");
  const [toast, setToast] = useState<string>();
  const [busy, setBusy] = useState(false);

  const directives = useMemo(
    () => live.directives.filter((item) => item.shipId === shipId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [live.directives, shipId],
  );
  const pendingDirectives = directives.filter((item) => item.status === "pending");
  const relevantAlerts = useMemo(
    () => live.alerts.filter((a) => !a.resolved && a.shipIds.includes(shipId)),
    [live.alerts, shipId],
  );
  const incomingAssistance = useMemo(
    () => live.assistance.filter((request) => request.toShipId === shipId && request.status === "pending"),
    [live.assistance, shipId],
  );
  const handledIncomingAssistance = useMemo(
    () => live.assistance.filter((request) => request.toShipId === shipId && request.status !== "pending").slice(0, 4),
    [live.assistance, shipId],
  );
  const outgoingAssistance = useMemo(
    () => live.assistance.filter((request) => request.fromShipId === shipId).slice(0, 4),
    [live.assistance, shipId],
  );

  useEffect(() => {
    if (live.error) setToast(live.error);
  }, [live.error]);

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await fn();
      setToast(success);
      setTimeout(() => setToast(undefined), 2500);
    } catch (error) {
      setToast((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const respondDirective = async (directive: Directive, response: "ACCEPT" | "ESCALATE_DISTRESS") => {
    const message = escalationMessages[directive.id] ?? "";
    await run(
      () => emitWithAck(live.socket, "directive:respond", { directiveId: directive.id, response, message }),
      response === "ACCEPT" ? "Directive accepted. Course change will apply on the next simulation tick." : "Directive escalated as distress.",
    );
  };

  const respondAssistance = async (request: AssistanceRequest, response: "ACCEPT" | "DECLINE") => {
    await run(
      () => emitWithAck(live.socket, "assistance:respond", { id: request.id, response }),
      `Assistance request ${response.toLowerCase()}ed.`,
    );
  };

  if (!live.bootstrap || !ship || !liveShip) {
    return (
      <main className="loading-screen">
        <div className="radar-loader" />
        <h1>Captain Console</h1>
        <p>{live.error ?? `Connecting to ${shipId}…`}</p>
      </main>
    );
  }

  return (
    <main className="captain-page">
      <header className="topbar captain-topbar">
        <div className="brand-lockup">
          <span className="brand-mark">C</span>
          <div><strong>CAPTAIN CONSOLE</strong><small>{liveShip.name} · {liveShip.shipId}</small></div>
        </div>
        <div className="captain-header-state"><StatusPill value={liveShip.status} /><span className="live-text"><i /> {live.connected ? "COMMAND LINK LIVE" : "RECONNECTING"}</span></div>
        <a className="ghost-link" href="/command">Command View</a>
      </header>

      {toast ? <div className="toast">{toast}</div> : null}

      <section className="captain-grid">
        <section className="panel captain-map-panel">
          <FleetMap
            ships={[ship]}
            zones={live.zones}
            weather={live.weather}
            navigableWater={live.bootstrap.navigableWater}
            selectedShipId={shipId}
          />
          <div className="captain-metrics">
            <Metric label="Destination" value={liveShip.destinationLabel} sub={`${liveShip.reachability.routeDistanceKm.toFixed(0)} km on active route`} />
            <Metric label="Fuel" value={`${liveShip.fuel.toFixed(0)} t`} sub={liveShip.reachability.reachable ? "Projected reachable" : `Short ${Math.abs(liveShip.reachability.fuelRemainingAtArrival).toFixed(0)} t`} />
            <Metric label="Speed / Heading" value={`${liveShip.speed.toFixed(0)} kn · ${liveShip.heading.toFixed(0)}°`} sub={liveShip.routeStrategy.toUpperCase()} />
            <Metric label="Weather" value={liveShip.weather.condition} sub={`${liveShip.weather.windKnots.toFixed(0)} kn wind · fuel ×${liveShip.weather.fuelMultiplier.toFixed(1)}`} />
          </div>
        </section>

        <aside className="captain-side">
          <section className="panel captain-card directive-panel">
            <div className="panel-heading"><div><span className="eyebrow">COMMAND CHANNEL</span><h2>Directives</h2></div><span className="count-badge">{pendingDirectives.length}</span></div>
            {pendingDirectives.length ? pendingDirectives.map((directive) => (
              <article className="directive-ticket" key={directive.id}>
                <span className="ticket-tag">NEW DIRECTIVE</span>
                <strong>{directive.type.replaceAll("_", " ")}</strong>
                <p>
                  {directive.type === "REROUTE_PORT" ? `Reroute to ${live.bootstrap!.ports.find((p) => p.id === directive.payload.portId)?.name ?? directive.payload.portId}.` : null}
                  {directive.type === "DIVERT_WAYPOINT" ? `Divert to waypoint ${directive.payload.waypoint?.map((x) => x.toFixed(3)).join(", ")}.` : null}
                  {directive.type === "HOLD_POSITION" ? "Hold current position." : null}
                  {directive.type === "RESUME" ? "Resume navigation on the current mission." : null}
                </p>
                {directive.payload.strategy ? <small>Requested route strategy: {directive.payload.strategy}</small> : null}
                <div className="button-row"><button className="primary-btn" disabled={busy} onClick={() => respondDirective(directive, "ACCEPT")}>Accept</button></div>
                <label>Unsafe to comply? Explain and escalate<textarea rows={2} value={escalationMessages[directive.id] ?? ""} onChange={(e) => setEscalationMessages((old) => ({ ...old, [directive.id]: e.target.value }))} placeholder="e.g. Main engine overheating; cannot safely increase load." /></label>
                <button className="danger-btn" disabled={busy || !(escalationMessages[directive.id] ?? "").trim()} onClick={() => respondDirective(directive, "ESCALATE_DISTRESS")}>Escalate distress</button>
              </article>
            )) : <div className="empty-state small"><span>✓</span><strong>No pending directives</strong><p>Command orders appear here immediately.</p></div>}
          </section>

          <section className="panel captain-card">
            <div className="panel-heading"><div><span className="eyebrow">FREE-FORM NLP</span><h2>Distress</h2></div></div>
            <textarea className="large-textarea" rows={4} value={distress} onChange={(e) => setDistress(e.target.value)} placeholder="Describe the incident naturally: injuries, damage, propulsion, flooding, security risk…" />
            <button className="danger-btn full" disabled={busy || !distress.trim()} onClick={() => run(async () => {
              await emitWithAck(live.socket, "distress:send", { message: distress });
              setDistress("");
            }, "Distress transmitted and structured by the alert pipeline.")}>Transmit distress</button>
          </section>

          <section className="panel captain-card">
            <div className="panel-heading"><div><span className="eyebrow">SHIP-TO-SHIP BONUS</span><h2>Assistance</h2></div></div>
            <label>Assistance type<select value={assistanceKind} onChange={(e) => setAssistanceKind(e.target.value as typeof assistanceKind)}><option value="fuel">Fuel transfer</option><option value="medical">Medical aid</option><option value="escort">Escort</option><option value="cargo_offload">Cargo offload</option></select></label>
            <label>Message<input value={assistMessage} onChange={(e) => setAssistMessage(e.target.value)} placeholder="Optional operational detail" /></label>
            <button className="secondary-btn full" disabled={busy} onClick={() => run(async () => {
              await emitWithAck(live.socket, "assistance:request", { kind: assistanceKind, message: assistMessage });
              setAssistMessage("");
            }, "Nearest suitable vessel has received the assistance request.")}>Request nearest vessel</button>
            {outgoingAssistance.map((request) => <div className="mini-row" key={request.id}><span>{request.kind.replace("_", " ")} → {request.toShipId}</span><strong>{request.status}</strong></div>)}
          </section>
        </aside>
      </section>

      <section className="captain-lower-grid">
        <section className="panel captain-card">
          <div className="panel-heading"><div><span className="eyebrow">YOUR SHIP</span><h2>Active alerts</h2></div><span className="count-badge alert">{relevantAlerts.length}</span></div>
          {relevantAlerts.length ? relevantAlerts.map((alert) => (
            <article className={`alert-card severity-${alert.severity}`} key={alert.id}>
              <div className="alert-head"><span className="severity-label">{alert.severity}</span><span className="muted">{alert.type.replaceAll("_", " ")}</span></div>
              <strong>{alert.title}</strong><p>{alert.message}</p>
              {!alert.acknowledged ? <button onClick={() => run(() => emitWithAck(live.socket, "alert:ack", { id: alert.id }), "Alert acknowledged.")}>Acknowledge</button> : <small>Acknowledged</small>}
            </article>
          )) : <div className="empty-state small"><span>✓</span><strong>No active alerts for {shipId}</strong></div>}
        </section>

        <section className="panel captain-card">
          <div className="panel-heading"><div><span className="eyebrow">NEARBY SUPPORT</span><h2>Incoming assistance</h2></div><span className="count-badge" title="Pending requests">{incomingAssistance.length} pending</span></div>
          {incomingAssistance.length ? incomingAssistance.map((request) => (
            <article className="directive-ticket" key={request.id}>
              <span className="ticket-tag">ASSISTANCE REQUEST</span>
              <strong>{request.fromShipId} needs {request.kind.replace("_", " ")}</strong>
              <p>{request.message || `Requesting support from approximately ${request.distanceKm.toFixed(1)} km away.`}</p>
              <div className="button-row"><button className="primary-btn" onClick={() => respondAssistance(request, "ACCEPT")}>Accept</button><button className="secondary-btn" onClick={() => respondAssistance(request, "DECLINE")}>Decline</button></div>
            </article>
          )) : <div className="empty-state small"><span>◇</span><strong>No pending assistance requests</strong></div>}
          {handledIncomingAssistance.map((request) => (
            <div className="mini-row" key={request.id}>
              <span>{request.fromShipId} · {request.kind.replace("_", " ")}</span>
              <strong className={`assistance-${request.status}`}>{request.status}</strong>
            </div>
          ))}
        </section>
      </section>
    </main>
  );
}
