import type { Socket } from "socket.io-client";

export type AckResult<T = unknown> = { ok: boolean; data?: T; error?: string };

export function emitWithAck<T>(socket: Socket | undefined, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error("Socket is not connected"));
    socket.timeout(5000).emit(event, payload, (err: Error | null, result: AckResult<T>) => {
      if (err) return reject(err);
      if (!result?.ok) return reject(new Error(result?.error ?? "Operation failed"));
      resolve(result.data as T);
    });
  });
}
