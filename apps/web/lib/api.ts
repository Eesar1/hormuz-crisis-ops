import type { AdvisorSuggestion, Bootstrap, RouteCandidate } from "./types";

export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:4000";

export async function fetchBootstrap(): Promise<Bootstrap> {
  const response = await fetch(`${SERVER_URL}/api/bootstrap`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Bootstrap failed (${response.status})`);
  return response.json();
}

export async function fetchRouteOptions(shipId: string, destination?: string): Promise<RouteCandidate[]> {
  const url = new URL(`${SERVER_URL}/api/route-options`);
  url.searchParams.set("shipId", shipId);
  if (destination) url.searchParams.set("destination", destination);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Route options failed (${response.status})`);
  return (await response.json()).candidates;
}

export async function fetchAdvisor(): Promise<AdvisorSuggestion[]> {
  const response = await fetch(`${SERVER_URL}/api/advisor`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Advisor failed (${response.status})`);
  return (await response.json()).suggestions;
}
