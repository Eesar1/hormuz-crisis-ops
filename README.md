# Hormuz Crisis Ops

> Independently audited on 24 September 2026 with real dependency installs, production builds, Docker Compose, and six concurrent rendered browser clients. See [`docs/VALIDATION.md`](docs/VALIDATION.md).

A complete local-first implementation of the **Code Rush — Web Dev Track** brief: a real-time maritime crisis command system for 15 simulated commercial ships in and around the Strait of Hormuz.

## What is implemented

### Core (grading-critical)
- Exactly **15 ships** loaded from the supplied `data/fleet.json`.
- Authoritative backend simulation at **4 Hz by default** (`TICK_MS=250`).
- Persistent **Socket.IO/WebSocket** state fan-out to Command and Captain clients.
- Client-side interpolation between authoritative updates for smooth motion.
- Interactive maritime map with all ships, routes, supplied navigable-water boundary, weather cells, and runtime restricted zones.
- **Command-only zone creation, editing, and deletion**.
- Automatic route invalidation/rerouting when a zone intersects a route.
- Immediate geofence alert when a ship is inside a restricted zone, including the case where a new zone is drawn around the ship.
- A* grid routing constrained to supplied navigable water and runtime restricted zones.
- `stranded` handling when no route can be found.
- Fuel reachability forecasting plus `insufficient_fuel`, predictive shortfall, and `out_of_fuel` alerts.
- Open-Meteo weather sampling with the required **30% adverse-weather fuel multiplier**.
- Weather-aware route cost; safer routes strongly penalize adverse/severe weather.
- Pairwise proximity warnings below **2 km** through the same alert pipeline.
- Command → Captain directives: reroute to port, divert to waypoint, hold, resume.
- Captain responses: **ACCEPT** or **ESCALATE_DISTRESS**.
- Free-form captain distress messages parsed into structured severity / incident / injury / impact data.
- One-hour in-memory playback ring with periodic state snapshots and key events.
- Visual + browser-audio critical alert notification.
- Docker Compose startup.

### Bonus functionality
- Three route alternatives: **fast / safe / efficient**, with distance, weather exposure, estimated fuel, and reachability.
- Ship-to-ship assistance: fuel, medical, escort, cargo offload; nearest suitable vessel receives the request and can accept/decline.
- Predictive fuel exhaustion warnings.
- Proactive fleet advisor. It uses the configured OpenAI-compatible provider when a key is supplied and deterministic operations rules when offline.

## Quick start — Docker (recommended)

Requirements: Docker Desktop / Docker Engine with Compose.

```bash
cp .env.example .env
docker compose up --build
```

Open:

- Command: `http://localhost:3000/command`
- Captain examples:
  - `http://localhost:3000/captain/MV-1`
  - `http://localhost:3000/captain/MV-7`
  - any `MV-1` … `MV-15`
- Backend health: `http://localhost:4000/health`
- Backend metrics: `http://localhost:4000/api/metrics`

The simulator works without an AI key. To enable model-based distress extraction and fleet-advisor reasoning, set `OPENAI_API_KEY` in `.env`. The local structured parser remains a fallback so the demo never depends on an external AI service to boot.

## Quick start — without Docker

Requires Node.js 22+.

Terminal 1:

```bash
cd apps/server
npm install
npm run dev
```

Terminal 2:

```bash
cd apps/web
npm install
npm run dev
```

Then open `http://localhost:3000/command`.

### Windows helper scripts

From PowerShell in the project root:

```powershell
.\scripts\setup-local.ps1
.\scripts\run-local.ps1
```

The setup script installs both app dependency sets and creates `.env` if needed. The run script opens separate backend/frontend PowerShell windows and then opens the Command dashboard.

## Demo sequence for judging

1. Open `/command` and two or more captain tabs such as `/captain/MV-1` and `/captain/MV-7`.
2. Confirm all clients receive live fleet updates.
3. In Command, select a ship and click **Analyze 3 routes**.
4. Draw a restricted polygon across the selected ship's current route. The backend detects the path intersection and reroutes automatically.
5. Draw a small zone around a ship to demonstrate immediate geofence breach + escape reroute.
6. Send a port reroute directive from Command. On that captain's page, **Accept** it. The new course applies on the next backend tick.
7. Send another directive and use **Escalate distress** with a message such as: `Engine-room explosion. Two crew injured. Main engine offline and taking water slowly.`
8. Observe the structured distress alert in Command.
9. From a captain page, request fuel or medical assistance. Open the receiving captain page to accept/decline.
10. Scrub the Command timeline after several snapshots have accumulated.

## Architecture

```text
Browser: Command UI ─────┐
                        │ Socket.IO / WebSocket
Browser: Captain UI ────┼─────────────┐
                        │             │
Browser: Captain UI ────┘       Fastify server
                                      │
                 ┌────────────────────┼───────────────────┐
                 │                    │                   │
          Simulation engine        A* router         Alert pipeline
             4 Hz default      water + zones +       geofence
                 │               weather cost         proximity
                 │                    │               distress
                 │                    │               fuel
                 │                    │               assistance
                 ├──────────── Weather service
                 │               Open-Meteo
                 │
                 ├──────────── AI/NLP service
                 │          provider + local fallback
                 │
                 └──────────── 1-hour history ring
```

### Server source

- `apps/server/src/engine/simulation.ts` — authoritative state, ticks, movement, fuel, alerts, directives, assistance, history.
- `apps/server/src/routing/grid-router.ts` — A* grid pathfinding, route candidates, weather cost, fuel estimates.
- `apps/server/src/services/weather.ts` — Open-Meteo + deterministic offline fallback.
- `apps/server/src/ai/distress.ts` — structured distress extraction and fleet advisor.
- `apps/server/src/engine/alerts.ts` — deduplicated acknowledgement/resolution alert pipeline.
- `apps/server/src/index.ts` — Fastify HTTP API + Socket.IO role-scoped actions.

### Web source

- `apps/web/components/command-dashboard.tsx` — fleet command UI.
- `apps/web/components/captain-dashboard.tsx` — single-ship captain UI.
- `apps/web/components/fleet-map.tsx` — MapLibre map, ship markers, routes, zones, custom polygon creation/editing.
- `apps/web/hooks/use-realtime.ts` — live state synchronization.
- `apps/web/hooks/use-interpolated-fleet.ts` — smooth client rendering between server updates.

## Routing details

The router uses an ~0.05° A* grid. A grid cell is traversable only if it is inside the supplied `navigableWater` polygon and outside every runtime restricted zone. Diagonal movement is supported. A line-of-sight smoothing pass reduces unnecessary grid corners while repeatedly sampling the resulting segment to ensure it remains navigable.

Three strategy weights are exposed:
- **fast**: mostly distance-driven, small weather penalty.
- **safe**: strong adverse/severe weather penalty.
- **efficient**: balanced weather/distance behavior, with fuel estimate shown in Command.

Restricted zones are hard obstacles (not merely cost penalties).


### Supplied water-polygon normalization

The provided simplified water ring contains a very small boundary self-intersection at the Strait throat (near 26.45°N, 56.44°E). A strict even/odd polygon interpretation splits the Persian Gulf and Gulf of Oman into disconnected lobes, making most supplied ship-to-port routes impossible. The router detects such boundary self-intersections generically and treats an 18 km radius around each crossing as a narrow navigable repair throat. Outside that repair area, every sampled route segment must remain inside the supplied polygon. This is documented rather than silently changing the fleet data.

## Fuel model

The brief fixes the adverse-weather cost at +30% but does not define the absolute fuel-consumption curve. This implementation documents and uses a deterministic distance/speed model:

```text
baseFuelPerKm = 1.40 t/km × speedFactor
speedFactor   = max(0.72, (cruiseKnots / 15)^1.35)
weather       = ×1.30 in adverse/severe weather, otherwise ×1.00
```

The same model is used for live burn and route reachability estimates so the UI and simulator remain internally consistent.

## Weather behavior

The service samples multiple points inside the supplied operating water polygon from Open-Meteo. A ship uses its nearest current weather sample. `adverse` and `severe` conditions apply the required 1.30 fuel multiplier. If Open-Meteo is unavailable, the service keeps the application running with deterministic fallback cells and clearly reports `LOCAL FALLBACK` in the Command UI.

## Roles and authorization assumption

The brief defines Command and Captain interfaces but does not define login credentials. This implementation uses **server-enforced socket role scoping**:
- Command sockets can create/edit/delete zones and issue directives.
- Captain sockets are bound to exactly one valid ship ID and can only respond for that ship, send distress for that ship, acknowledge relevant alerts, and handle relevant assistance requests.

The URL selects the demo role (`/command` or `/captain/MV-X`). For a production system, place real authentication in front of the same authorization checks.

## State persistence assumption

The brief allows event logs, snapshots, or a ring buffer and states that full arbitrary-time reconstruction is not required. This build uses an in-memory one-hour ring buffer, with `HISTORY_INTERVAL_MS=10000` by default so playback becomes demonstrable quickly. Restarting the server intentionally resets the simulation, zones, alerts, directives, and playback history to the supplied fleet baseline.

## External dependencies and reproducibility

- The application itself runs locally in Docker / Node.
- OpenStreetMap raster tiles are used only as basemap imagery; the supplied water polygon and all fleet state are local.
- Weather uses Open-Meteo when internet access exists, with local fallback.
- AI is optional at boot and has a local structured fallback.

## Environment variables

See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | backend port |
| `WEB_ORIGIN` | `http://localhost:3000` | allowed web origin(s), comma separated |
| `TICK_MS` | `250` | authoritative simulation tick |
| `HISTORY_INTERVAL_MS` | `10000` | history snapshot cadence |
| `WEATHER_REFRESH_MS` | `600000` | weather refresh cadence |
| `AI_MODE` | `auto` | `auto` or `heuristic` |
| `OPENAI_API_KEY` | blank | optional model provider key |
| `OPENAI_MODEL` | `gpt-5-mini` | model identifier |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `NEXT_PUBLIC_SERVER_URL` | `http://localhost:4000` | browser API/socket endpoint |

## Validation and tests

From the repository root:

```bash
npm run validate
npm --prefix apps/server install
npm run test:server
npm run build:server
npm --prefix apps/web install
npm run build:web
```

`npm run validate` verifies the supplied fixed fleet contains exactly 15 unique ships with valid destination references and confirms the critical project files are present.

## Important spec assumptions

1. Fuel burn's absolute baseline is not supplied, so a documented deterministic model is used while preserving the exact +30% adverse-weather requirement.
2. A Captain is scoped to one ship by socket session; the brief does not prescribe credential storage.
3. History is a volatile one-hour ring because the brief explicitly permits a ring buffer and does not require persistence across process restarts.
4. Runtime zone polygons must stay inside the supplied overall bounding box; they may include non-water area because operators are defining forbidden space, while the ship router remains constrained to navigable water.
5. Automatic restricted-zone rerouting always uses the **safe** route strategy because the brief says it should require no operator approval and weather should be factored into new paths.
