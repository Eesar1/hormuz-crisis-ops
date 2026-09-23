# Validation status

The extracted project was independently audited on Windows with Node.js 22 and Docker Desktop on 24 September 2026.

## Passed automated checks

- `npm run validate`: exactly 15 ships, 10 ports, unique ship IDs, valid destination references, and required project files.
- `npm --prefix apps/server test`: 12/12 Vitest checks passed, covering geospatial helpers, all 15 initial routes, destination blocking, escape routing from a newly drawn zone, exact 1.30 adverse-weather fuel burn, low-fuel detection, immediate geofence alerts, next-tick directive application, structured distress, assistance, and the 2 km proximity pipeline.
- `npm --prefix apps/server run build`: strict TypeScript build passed against the installed dependencies.
- `npm --prefix apps/web run build`: Next.js production build and TypeScript checks passed.
- `npm audit` in both applications: zero known vulnerabilities at the time of this audit.
- `docker compose config`: passed.
- `docker compose build`: both images built successfully from a clean Docker context.
- `docker compose up -d`: backend became healthy and both services served their documented ports.

## Passed live checks

- `/health` returned 200 with 15 ships.
- `/api/metrics` reported the default 250 ms tick and 4 Hz update rate.
- Command and five separate Captain browser clients connected concurrently over Socket.IO/WebSocket.
- MapLibre maps rendered in all six clients without browser console or page errors.
- A Command `HOLD_POSITION` directive appeared in the correct Captain console, was accepted, applied on the next tick, and synchronized back as `stopped`.
- The live weather source reported Open-Meteo during the audit; deterministic fallback remains available for offline runs.

## Source integrity

The packaged `data/fleet.json` has the same SHA-256 hash as the supplied `fleet.json`; the original input file was not modified. The assignment PDF is kept outside the application source and was not modified.

## Not externally verified

- Model-backed OpenAI responses require a real `OPENAI_API_KEY`; the no-key heuristic fallback was the path exercised during this audit.
- The 500 ms / 95th-percentile delivery target was verified structurally (250 ms authoritative broadcast and six synchronized clients), not with a long-duration statistical load benchmark.
