# Requirements matrix

| Requirement | Implementation |
|---|---|
| Exactly 15 active ships | `data/fleet.json`, validated at server startup and by `scripts/validate.mjs` |
| 1 Hz or faster | Server default 4 Hz (`TICK_MS=250`) |
| State to watchers quickly | One authoritative server + Socket.IO broadcast every tick |
| Geofence alert <1 sec | Zone-change handling is synchronous; tick checks also run at 4 Hz |
| <2 km proximity warning | Pairwise Haversine check each tick |
| 30% adverse weather fuel | `WeatherInfo.fuelMultiplier = 1.3` |
| 5+ simultaneous watchers | Stateless fan-out from one authoritative in-memory engine |
| Smooth movement | Client RAF interpolation between authoritative updates |
| Routing in navigable water | A* cells + segment sampling inside supplied polygon |
| Runtime zones | Command map custom draw/edit/delete controls |
| New zone intersects route | Synchronous affected-route scan and automatic reroute |
| No valid path | `stranded` + critical alert |
| Zone drawn around ship | immediate geofence + escape reroute attempt |
| Insufficient fuel | route estimator + status + alert; ship continues |
| Interactive ship detail | Command selection + metrics/details |
| Persistent connection | Socket.IO with WebSocket preferred |
| Command vs Captain | separate interfaces + socket action authorization |
| Accept / escalate directive | Captain directive ticket workflow |
| Free-form distress | AI/local parser produces structured metadata |
| Real weather | Open-Meteo sampling |
| Weather-aware reroute | strategy-dependent weather cost in A* |
| Reachability | route distance + weather-adjusted fuel estimate |
| Playback | one-hour ring snapshots and UI timeline |
| `docker compose up` | root compose file + Dockerfiles |
| Multiple route options bonus | fast/safe/efficient candidate analysis |
| Ship-to-ship assistance bonus | nearest-vessel request + target captain response |
| Predictive alerts bonus | projected fuel-exhaustion distance |
| AI advisor bonus | model-backed when configured, operational rules fallback |
