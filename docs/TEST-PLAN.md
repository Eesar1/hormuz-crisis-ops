# Test plan

## Automated
1. `npm run validate`
2. `npm run test:server`
3. `npm run build:server`
4. `npm run build:web`

## Manual acceptance
- Open Command + at least five Captain/browser tabs and verify ship values stay synchronized.
- Confirm the server metrics report `updateHz: 4` with defaults.
- Draw a restricted zone over an active route; observe automatic route replacement.
- Draw a zone around an existing ship; observe breach alert without waiting for the ship to cross.
- Edit a zone vertex and save; verify affected routes are recalculated.
- Select a ship and use route options; compare distance/weather/fuel tradeoffs.
- Send a command directive; accept it from the correct captain and verify the next tick applies it.
- Try handling another ship's directive by changing only the client payload; the server rejects it due to ship scoping.
- Escalate a directive with an incident description; verify structured distress alert metadata.
- Create a free-form distress and verify priority ordering in Command.
- Request assistance; verify the nearest suitable target captain receives it.
- Acknowledge an alert; verify all connected clients see the acknowledgement.
- Move two ships within 2 km in a controlled test / adjusted fleet fixture and verify one deduplicated proximity alert.
- Leave the system running; scrub historical snapshots and return to LIVE.
