import type { AdvisorSuggestion, Alert, DistressAnalysis, Severity, ShipState } from "../types.js";
import { env } from "../config.js";

function extractCount(message: string, words: string[]): number | undefined {
  const escaped = words.join("|");
  const patterns = [
    new RegExp(`(\\d+)\\s+(?:crew\\s+|people\\s+|persons\\s+)?(?:${escaped})`, "i"),
    new RegExp(`(?:${escaped})\\D{0,12}(\\d+)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

export class AIService {
  async analyzeDistress(message: string): Promise<DistressAnalysis> {
    if (this.canUseOpenAI()) {
      try {
        return await this.openAiDistress(message);
      } catch (error) {
        console.warn("AI distress call failed; using local parser:", (error as Error).message);
      }
    }
    return this.heuristicDistress(message);
  }

  async advise(ships: ShipState[], alerts: Alert[], fallback: AdvisorSuggestion[]): Promise<AdvisorSuggestion[]> {
    if (!this.canUseOpenAI()) return fallback;
    try {
      const compactShips = ships.map((s) => ({
        shipId: s.shipId,
        name: s.name,
        status: s.status,
        fuel: Math.round(s.fuel),
        destination: s.destinationLabel,
        reachable: s.reachability.reachable,
        weather: s.weather.condition,
      }));
      const activeAlerts = alerts.filter((a) => !a.resolved).slice(0, 15).map((a) => ({
        type: a.type,
        severity: a.severity,
        shipIds: a.shipIds,
        message: a.message,
      }));
      const content = await this.chatJson(
        "You are a maritime fleet operations advisor. Return JSON only with key suggestions, an array of at most 5 objects. Each object must contain severity (info|warning|high|critical), title, reasoning, actions (string array), shipIds (string array). Do not invent ship IDs. Prefer concrete operational suggestions.",
        JSON.stringify({ ships: compactShips, alerts: activeAlerts }),
      );
      const parsed = JSON.parse(content) as { suggestions?: Array<Omit<AdvisorSuggestion, "id" | "source">> };
      return (parsed.suggestions ?? []).slice(0, 5).map((item, index) => ({
        id: `ai-${Date.now()}-${index}`,
        severity: item.severity,
        title: item.title,
        reasoning: item.reasoning,
        actions: item.actions,
        shipIds: item.shipIds,
        source: "openai",
      }));
    } catch (error) {
      console.warn("AI advisor call failed; using rule suggestions:", (error as Error).message);
      return fallback;
    }
  }

  private canUseOpenAI(): boolean {
    return env.aiMode !== "heuristic" && Boolean(env.openAiKey);
  }

  private heuristicDistress(message: string): DistressAnalysis {
    const lower = message.toLowerCase();
    const incidentType: string[] = [];
    if (/fire|explosion|blast/.test(lower)) incidentType.push("fire_or_explosion");
    if (/engine|propulsion|power loss|dead in water/.test(lower)) incidentType.push("engine_failure");
    if (/flood|taking water|leak/.test(lower)) incidentType.push("flooding");
    if (/injur|wound|hurt|casualt/.test(lower)) incidentType.push("injuries");
    if (/collision|hit|impact/.test(lower)) incidentType.push("collision");
    if (/pirat|attack|weapon|hostile/.test(lower)) incidentType.push("security");
    if (/medical|heart|unconscious|sick/.test(lower)) incidentType.push("medical");
    if (!incidentType.length) incidentType.push("unknown_incident");

    const injuries = extractCount(message, ["injured", "injuries", "wounded", "casualties"]);
    const criticalTerms = /sinking|mayday|explosion|fire out of control|fatal|dead|abandon ship|taking water rapidly|collision|attack/;
    const highTerms = /engine offline|engine failure|injured|flood|taking water|steering failure|medical emergency/;
    const warningTerms = /minor|degraded|slow leak|reduced speed|issue|fault/;
    let severity: Severity = "warning";
    if (criticalTerms.test(lower) || (injuries ?? 0) >= 3) severity = "critical";
    else if (highTerms.test(lower) || (injuries ?? 0) > 0) severity = "high";
    else if (!warningTerms.test(lower)) severity = "warning";

    const quantifiableImpact: string[] = [];
    if (injuries !== undefined) quantifiableImpact.push(`${injuries} reported injuries`);
    const percent = message.match(/(\d{1,3})\s*%/);
    if (percent) quantifiableImpact.push(`${percent[1]}% reported impact`);
    const money = message.match(/(?:\$|usd\s?)([\d,.]+(?:\s?(?:k|m|million|thousand))?)/i);
    const damageEstimate = money ? money[0] : undefined;
    if (damageEstimate) quantifiableImpact.push(`damage estimate ${damageEstimate}`);

    return {
      severity,
      incidentType,
      injuries,
      damageEstimate,
      quantifiableImpact,
      summary: message.length > 180 ? `${message.slice(0, 177)}...` : message,
      recommendedPriority: severity === "critical" ? 1 : severity === "high" ? 2 : severity === "warning" ? 3 : 4,
      provider: "heuristic",
    };
  }

  private async openAiDistress(message: string): Promise<DistressAnalysis> {
    const content = await this.chatJson(
      "Extract structured maritime distress information. Return JSON only with: severity (info|warning|high|critical), incidentType (string[]), injuries (number|null), damageEstimate (string|null), quantifiableImpact (string[]), summary (string), recommendedPriority (1-4). Be conservative; do not invent numbers.",
      message,
    );
    const parsed = JSON.parse(content) as Omit<DistressAnalysis, "provider">;
    return { ...parsed, provider: "openai" };
  }

  private async chatJson(system: string, user: string): Promise<string> {
    const response = await fetch(`${env.openAiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openAiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.openAiModel,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
    const json = (await response.json()) as any;
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("No model content returned");
    return content;
  }
}
