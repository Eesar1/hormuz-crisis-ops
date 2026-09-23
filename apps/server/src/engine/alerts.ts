import { randomUUID } from "node:crypto";
import type { Alert, AlertType, Severity } from "../types.js";

interface UpsertInput {
  sourceKey: string;
  type: AlertType;
  severity: Severity;
  title: string;
  message: string;
  shipIds: string[];
  metadata?: Record<string, unknown>;
}

export class AlertStore {
  private alerts = new Map<string, Alert>();
  private bySource = new Map<string, string>();

  list(): Alert[] {
    return [...this.alerts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  active(): Alert[] {
    return this.list().filter((alert) => !alert.resolved);
  }

  upsert(input: UpsertInput): { alert: Alert; created: boolean } {
    const now = new Date().toISOString();
    const existingId = this.bySource.get(input.sourceKey);
    if (existingId) {
      const existing = this.alerts.get(existingId)!;
      const wasResolved = existing.resolved;
      const updated: Alert = {
        ...existing,
        severity: input.severity,
        title: input.title,
        message: input.message,
        shipIds: input.shipIds,
        metadata: input.metadata,
        updatedAt: now,
        resolved: false,
        resolvedAt: undefined,
        acknowledged: wasResolved ? false : existing.acknowledged,
        acknowledgedAt: wasResolved ? undefined : existing.acknowledgedAt,
      };
      this.alerts.set(existingId, updated);
      return { alert: updated, created: wasResolved };
    }
    const alert: Alert = {
      id: randomUUID(),
      sourceKey: input.sourceKey,
      type: input.type,
      severity: input.severity,
      title: input.title,
      message: input.message,
      shipIds: input.shipIds,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
      acknowledged: false,
      resolved: false,
    };
    this.alerts.set(alert.id, alert);
    this.bySource.set(alert.sourceKey, alert.id);
    return { alert, created: true };
  }

  resolve(sourceKey: string): Alert | null {
    const id = this.bySource.get(sourceKey);
    if (!id) return null;
    const alert = this.alerts.get(id);
    if (!alert || alert.resolved) return null;
    const now = new Date().toISOString();
    const updated = { ...alert, resolved: true, resolvedAt: now, updatedAt: now };
    this.alerts.set(id, updated);
    return updated;
  }

  acknowledge(id: string): Alert | null {
    const alert = this.alerts.get(id);
    if (!alert) return null;
    const now = new Date().toISOString();
    const updated = { ...alert, acknowledged: true, acknowledgedAt: now, updatedAt: now };
    this.alerts.set(id, updated);
    return updated;
  }
}
