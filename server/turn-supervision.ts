/**
 * The server-side owner for one provider turn's process lifetime.
 *
 * Drivers emit events, but they do not own the durable bot/task record. This
 * small state machine closes the gap between an interrupt request and the
 * provider's terminal event: a matching terminal event wins, while a turn
 * that never produces one is released exactly once as UNKNOWN after a
 * bounded grace period. Provider turn ids make old events harmless when a
 * thread is reused for a later turn.
 */

export type TurnStopIntent = "cancel" | "timeout" | "restart" | "provider-exit";

export interface UnknownTurn {
  botId: string;
  threadId: string;
  turnId?: string;
  intent: TurnStopIntent;
  eventId: string;
  reason: string;
}

export interface TerminalObservation {
  accepted: boolean;
  intent?: TurnStopIntent;
  turnId?: string;
}

interface ActiveTurn {
  key: string;
  botId: string;
  threadId: string;
  generation: number;
  providerTurnId?: string;
  intent?: TurnStopIntent;
  graceMs: number;
  stopTimer?: ReturnType<typeof setTimeout>;
  interruptIssued: boolean;
}

interface TurnSupervisionOptions {
  graceMs: number;
  onUnknown: (turn: UnknownTurn) => void;
}

function keyFor(botId: string, threadId: string): string {
  return `${botId}\u0000${threadId}`;
}

/**
 * In-memory process supervision is deliberately small and generation based.
 * Durable lifecycle and terminal receipts remain Store's responsibility.
 */
export class TurnSupervision {
  private readonly active = new Map<string, ActiveTurn>();
  /** Provider ids stay rejectable for the whole attached provider fleet.
   * This is intentionally not count-bounded: an old id must not become
   * admissible merely because enough later turns completed. */
  private readonly remembered = new Map<string, Set<string>>();
  private readonly justAccepted = new Map<string, string>();
  private generation = 0;
  private readonly graceMs: number;
  private readonly onUnknown: (turn: UnknownTurn) => void;

  constructor(options: TurnSupervisionOptions) {
    this.graceMs = Math.max(1, Math.trunc(options.graceMs));
    this.onUnknown = options.onUnknown;
  }

  /** Admit exactly one supervised provider turn for a bot/thread pair. */
  begin(botId: string, threadId: string, graceMs = this.graceMs): boolean {
    const key = keyFor(botId, threadId);
    if (this.active.has(key)) return false;
    this.justAccepted.delete(key);
    this.active.set(key, {
      key,
      botId,
      threadId,
      generation: ++this.generation,
      graceMs: Math.max(1, Math.trunc(graceMs)),
      interruptIssued: false,
    });
    return true;
  }

  /** Bind the provider-native turn id emitted by turn.started. */
  bind(botId: string, threadId: string, turnId: string): boolean {
    const normalized = turnId.trim();
    if (!normalized) return false;
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry || this.wasRemembered(entry.key, normalized)) return false;
    if (entry.providerTurnId && entry.providerTurnId !== normalized) return false;
    entry.providerTurnId = normalized;
    return true;
  }

  /** True only for events that can still belong to the active generation. */
  isCurrent(botId: string, threadId: string, turnId?: string): boolean {
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry) return false;
    if (turnId && this.wasRemembered(entry.key, turnId)) return false;
    if (!turnId || !entry.providerTurnId) return true;
    return entry.providerTurnId === turnId;
  }

  /** True when an event belongs to a completed generation and must not touch
   * the newer turn that may now reuse the same thread. */
  isLate(botId: string, threadId: string, turnId?: string): boolean {
    if (!turnId) return false;
    const key = keyFor(botId, threadId);
    return !this.active.has(key) && this.wasRemembered(key, turnId);
  }

  /** The current synchronous event fan-out still needs to finish after the
   * main fold removes the active generation. */
  wasJustAccepted(botId: string, threadId: string, turnId?: string): boolean {
    return Boolean(turnId && this.justAccepted.get(keyFor(botId, threadId)) === turnId);
  }

  /**
   * Ask the provider to stop. The timer starts even when the interrupt call
   * rejects: a failed transport cannot be treated as proof of termination.
   */
  async requestStop(
    botId: string,
    threadId: string,
    intent: Exclude<TurnStopIntent, "restart">,
    interrupt: () => Promise<void> | void,
  ): Promise<boolean> {
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry) return false;
    // Explicit user cancellation is the stronger visible intent when it
    // races a timeout. It still needs provider evidence or UNKNOWN fallback.
    if (!entry.intent || intent === "cancel") entry.intent = intent;
    if (!entry.stopTimer) {
      entry.stopTimer = setTimeout(() => {
        this.expire(entry, entry.intent ?? intent, this.defaultUnknownReason(entry.intent ?? intent));
      }, entry.graceMs);
      entry.stopTimer.unref?.();
    }
    if (!entry.interruptIssued) {
      entry.interruptIssued = true;
      try {
        // Do not let a wedged transport hold the cancellation HTTP request or
        // room queue open. The bounded timer below remains authoritative.
        void Promise.resolve(interrupt()).catch(() => {
          // A rejected interrupt proves neither success nor termination.
        });
      } catch {
        // The timer remains authoritative. A synchronous failure proves only
        // that the request failed, not that the provider stopped.
      }
    }
    return true;
  }

  /** Reconcile a provider terminal event against the active generation. */
  observeTerminal(botId: string, threadId: string, turnId?: string): TerminalObservation {
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry || !this.matches(entry, turnId)) return { accepted: false, turnId };
    const settledTurnId = turnId ?? entry.providerTurnId;
    this.remove(entry, settledTurnId);
    if (settledTurnId) {
      const key = entry.key;
      this.justAccepted.set(key, settledTurnId);
      queueMicrotask(() => {
        if (this.justAccepted.get(key) === settledTurnId) this.justAccepted.delete(key);
      });
    }
    return { accepted: true, intent: entry.intent, turnId: settledTurnId };
  }

  /** Finish a known launch/dispatch error that has no provider event. */
  finishWithoutProvider(botId: string, threadId: string): boolean {
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry) return false;
    this.remove(entry, entry.providerTurnId);
    return true;
  }

  /** Force an UNKNOWN terminal outcome during reload/shutdown reconciliation. */
  forceUnknown(botId: string, threadId: string, reason: string, intent: TurnStopIntent = "restart"): boolean {
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry) return false;
    this.expire(entry, intent, reason);
    return true;
  }

  /**
   * End the current provider-fleet lifecycle and release its retired ids.
   *
   * Call this only after the event bus has detached the old adapters and
   * every old provider instance has been disposed. That detach+dispose pair
   * is the lifecycle boundary proving that an old provider event cannot be
   * delivered to a future generation. Ordinary sequential turns must never
   * call this method.
   */
  resetProviderLifecycle(): void {
    this.remembered.clear();
    this.justAccepted.clear();
  }

  has(botId: string, threadId: string): boolean {
    return this.active.has(keyFor(botId, threadId));
  }

  private matches(entry: ActiveTurn, turnId?: string): boolean {
    if (!turnId) return true;
    if (this.wasRemembered(entry.key, turnId)) return false;
    return !entry.providerTurnId || entry.providerTurnId === turnId;
  }

  private expire(entry: ActiveTurn, intent: TurnStopIntent, reason: string): void {
    if (this.active.get(entry.key) !== entry) return;
    const turnId = entry.providerTurnId;
    this.remove(entry, turnId);
    this.onUnknown({
      botId: entry.botId,
      threadId: entry.threadId,
      ...(turnId ? { turnId } : {}),
      intent,
      eventId: `supervision:${entry.generation}:${intent}`,
      reason,
    });
  }

  private remove(entry: ActiveTurn, turnId?: string): void {
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
    entry.stopTimer = undefined;
    this.active.delete(entry.key);
    if (turnId) {
      const ids = this.remembered.get(entry.key) ?? new Set<string>();
      ids.add(turnId);
      this.remembered.set(entry.key, ids);
    }
  }

  private wasRemembered(key: string, turnId: string): boolean {
    return this.remembered.get(key)?.has(turnId) ?? false;
  }

  private defaultUnknownReason(intent: TurnStopIntent): string {
    if (intent === "timeout") return "provider did not confirm timeout cancellation before supervision grace expired";
    if (intent === "cancel") return "provider did not confirm explicit cancellation before supervision grace expired";
    if (intent === "provider-exit") return "provider process exited before a terminal completion was observed";
    return "provider supervision ended during server restart before a terminal event was observed";
  }
}
