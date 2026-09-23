import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fleetPath = path.join(root, 'data', 'fleet.json');
const fleet = JSON.parse(fs.readFileSync(fleetPath, 'utf8'));

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

assert(Array.isArray(fleet.fleet) && fleet.fleet.length === 15, 'fleet.json must contain exactly 15 ships');
assert(Array.isArray(fleet.navigableWater) && fleet.navigableWater.length >= 4, 'navigableWater polygon is missing');
assert(Array.isArray(fleet.ports) && fleet.ports.length > 0, 'ports are missing');

const shipIds = new Set();
for (const ship of fleet.fleet ?? []) {
  assert(!shipIds.has(ship.shipId), `duplicate shipId: ${ship.shipId}`);
  shipIds.add(ship.shipId);
  assert(Array.isArray(ship.position) && ship.position.length === 2, `${ship.shipId}: invalid position`);
  assert(Number.isFinite(ship.speed) && ship.speed >= 0, `${ship.shipId}: invalid speed`);
  assert(Number.isFinite(ship.fuel) && ship.fuel >= 0, `${ship.shipId}: invalid fuel`);
  assert(fleet.ports.some((p) => p.id === ship.destination), `${ship.shipId}: destination port not found`);
}

const required = [
  'apps/server/src/index.ts',
  'apps/server/src/engine/simulation.ts',
  'apps/server/src/routing/grid-router.ts',
  'apps/web/app/command/page.tsx',
  'apps/web/app/captain/[shipId]/page.tsx',
  'docker-compose.yml',
  'README.md'
];
for (const item of required) {
  assert(fs.existsSync(path.join(root, item)), `missing required file: ${item}`);
}

if (failures.length) {
  console.error('Validation failed:\n- ' + failures.join('\n- '));
  process.exit(1);
}

console.log(`Validation passed: ${fleet.fleet.length} ships, ${fleet.ports.length} ports, project structure present.`);
