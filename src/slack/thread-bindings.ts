/**
 * In-memory Slack thread → subagent session bindings.
 *
 * State lives on globalThis so the extension (loaded via Jiti) and core
 * (loaded via ESM) share the same registry — identical to the Discord
 * pattern in src/discord/monitor/thread-bindings.state.ts.
 */

export type SlackThreadBinding = {
  agentId: string;
  sessionKey: string;
  boundAt: number;
  lastActivityAt: number;
};

type SlackThreadBindingsState = {
  byThread: Map<string, SlackThreadBinding>;
  bySession: Map<string, string>; // sessionKey → threadKey (reverse lookup)
};

const STATE_KEY = "__openclawSlackThreadBindings";

const BINDING_TTL_MS = 30 * 60 * 1000; // 30 min inactivity
const SWEEP_INTERVAL_MS = 60 * 1000; // 60s cleanup

function getState(): SlackThreadBindingsState {
  const g = globalThis as typeof globalThis & {
    [STATE_KEY]?: SlackThreadBindingsState;
  };
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      byThread: new Map(),
      bySession: new Map(),
    };
  }
  return g[STATE_KEY];
}

function toKey(accountId: string, threadTs: string): string {
  return `${accountId}:${threadTs}`;
}

export function getSlackThreadBinding(
  accountId: string,
  threadTs: string,
): SlackThreadBinding | undefined {
  const state = getState();
  const binding = state.byThread.get(toKey(accountId, threadTs));
  if (!binding) {
    return undefined;
  }
  if (Date.now() - binding.lastActivityAt > BINDING_TTL_MS) {
    removeSlackThreadBinding(accountId, threadTs);
    return undefined;
  }
  binding.lastActivityAt = Date.now();
  return binding;
}

export function setSlackThreadBinding(
  accountId: string,
  threadTs: string,
  binding: { agentId: string; sessionKey: string },
): void {
  const key = toKey(accountId, threadTs);
  const state = getState();
  state.byThread.set(key, { ...binding, boundAt: Date.now(), lastActivityAt: Date.now() });
  state.bySession.set(binding.sessionKey, key);
}

export function removeSlackThreadBinding(accountId: string, threadTs: string): void {
  const key = toKey(accountId, threadTs);
  const state = getState();
  const existing = state.byThread.get(key);
  if (existing) {
    state.bySession.delete(existing.sessionKey);
  }
  state.byThread.delete(key);
}

export function removeSlackThreadBindingBySessionKey(sessionKey: string): void {
  const state = getState();
  const threadKey = state.bySession.get(sessionKey);
  if (threadKey) {
    state.byThread.delete(threadKey);
    state.bySession.delete(sessionKey);
  }
}

export function getSlackThreadBindingBySessionKey(
  sessionKey: string,
): { threadKey: string; binding: SlackThreadBinding } | undefined {
  const state = getState();
  const threadKey = state.bySession.get(sessionKey);
  if (!threadKey) {
    return undefined;
  }
  const binding = state.byThread.get(threadKey);
  if (!binding) {
    return undefined;
  }
  return { threadKey, binding };
}

// Background sweep for bindings on threads that are never accessed again
function sweepExpiredBindings(): void {
  const state = getState();
  const now = Date.now();
  for (const [key, binding] of state.byThread) {
    if (now - binding.lastActivityAt > BINDING_TTL_MS) {
      state.byThread.delete(key);
      state.bySession.delete(binding.sessionKey);
    }
  }
}
setInterval(sweepExpiredBindings, SWEEP_INTERVAL_MS);
