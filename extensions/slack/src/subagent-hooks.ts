import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

/**
 * Slack thread-binding hooks for subagent lifecycle.
 *
 * Accesses the same globalThis state as src/slack/thread-bindings.ts
 * to avoid cross-package import issues (the exports map only exposes
 * plugin-sdk, not internal src/ paths).
 */

type SlackThreadBinding = {
  agentId: string;
  sessionKey: string;
  boundAt: number;
};

type SlackThreadBindingsState = {
  byThread: Map<string, SlackThreadBinding>;
  bySession: Map<string, string>;
};

const STATE_KEY = "__openclawSlackThreadBindings";

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

export function registerSlackSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel = event.requester?.channel?.trim().toLowerCase();
    if (channel !== "slack") {
      return;
    }

    const accountId = event.requester?.accountId?.trim() || "";
    const threadId =
      event.requester?.threadId != null ? String(event.requester.threadId).trim() : "";

    if (!threadId) {
      return {
        status: "error" as const,
        error: "No thread ID available for Slack thread binding.",
      };
    }

    const key = toKey(accountId, threadId);
    const state = getState();
    state.byThread.set(key, {
      agentId: event.agentId,
      sessionKey: event.childSessionKey,
      boundAt: Date.now(),
    });
    state.bySession.set(event.childSessionKey, key);

    return { status: "ok" as const, threadBindingReady: true };
  });

  api.on("subagent_ended", (event) => {
    const state = getState();
    const threadKey = state.bySession.get(event.targetSessionKey);
    if (threadKey) {
      state.byThread.delete(threadKey);
      state.bySession.delete(event.targetSessionKey);
    }
  });

  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== "slack") {
      return;
    }

    const state = getState();
    const threadKey = state.bySession.get(event.childSessionKey);
    if (!threadKey) {
      return;
    }

    const binding = state.byThread.get(threadKey);
    if (!binding) {
      return;
    }

    // Extract threadTs from key format "accountId:threadTs"
    const colonIdx = threadKey.indexOf(":");
    const boundThreadTs = colonIdx >= 0 ? threadKey.slice(colonIdx + 1) : threadKey;

    return {
      origin: {
        channel: "slack",
        to: event.requesterOrigin?.to,
        threadId: boundThreadTs,
      },
    };
  });
}
