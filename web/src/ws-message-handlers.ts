/**
 * Individual message type handlers for the browser WebSocket client.
 *
 * Each handler processes a single BrowserIncomingMessage type and updates
 * the Zustand store accordingly. Dependencies from the main ws module
 * (streaming state, sequence tracking) are injected via HandlerDeps to
 * avoid circular imports.
 */

import { useStore } from "./store.js";
import type { BrowserIncomingMessage, ChatMessage, ProcessStatus } from "./types.js";
import { generateUniqueSessionName } from "./utils/names.js";
import { playNotificationSound } from "./utils/notification-sound.js";
import {
  extractTextFromBlocks,
  mergeAssistantMessage,
  upsertAssistantMessage,
  extractTasksFromBlocks,
  extractChangedFilesFromBlocks,
  extractProcessesFromBlocks,
  clearProcessedToolUseIds,
  sendBrowserNotification,
  summarizeSystemEvent,
} from "./ws-extractors.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface HandleParsedOptions {
  processSeq?: boolean;
  ackSeqMessage?: boolean;
}

/**
 * Dependencies injected from ws.ts to avoid circular imports.
 * These are functions that manage state owned by the main ws module.
 */
export interface HandlerDeps {
  nextId: () => string;
  // Streaming phase tracking
  getStreamingPhase: (sessionId: string) => "thinking" | "text" | undefined;
  setStreamingPhase: (sessionId: string, phase: "thinking" | "text") => void;
  deleteStreamingPhase: (sessionId: string) => void;
  // Streaming draft message management
  setStreamingDraftMessage: (sessionId: string, content: string) => void;
  finalizeStreamingDraftMessage: (sessionId: string, finalMessage: ChatMessage) => boolean;
  clearStreamingDraftMessage: (sessionId: string) => void;
  // Sequence tracking (needed for event_replay)
  getLastSeq: (sessionId: string) => number;
  setLastSeq: (sessionId: string, seq: number) => void;
  ackSeq: (sessionId: string, seq: number) => void;
  // Recursive dispatch (needed for event_replay)
  handleParsedMessage: (sessionId: string, data: BrowserIncomingMessage, options?: HandleParsedOptions) => void;
}

// ── Session lifecycle ───────────────────────────────────────────────────────

export function handleSessionInit(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "session_init" }>,
) {
  const store = useStore.getState();
  const existingSession = store.sessions.get(sessionId);
  store.addSession(data.session);
  store.setCliConnected(sessionId, true);
  if (!existingSession) {
    store.setSessionStatus(sessionId, "idle");
  }
  if (!store.sessionNames.has(sessionId)) {
    const existingNames = new Set(store.sessionNames.values());
    const name = generateUniqueSessionName(existingNames);
    store.setSessionName(sessionId, name);
  }
}

export function handleSessionUpdate(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "session_update" }>,
) {
  useStore.getState().updateSession(sessionId, data.session);
}

// ── Assistant message ───────────────────────────────────────────────────────

export function handleAssistant(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  deps: HandlerDeps,
) {
  const store = useStore.getState();
  const msg = data.message;
  const textContent = extractTextFromBlocks(msg.content);
  const chatMsg: ChatMessage = {
    id: msg.id,
    role: "assistant",
    content: textContent,
    contentBlocks: msg.content,
    timestamp: data.timestamp || Date.now(),
    parentToolUseId: data.parent_tool_use_id,
    model: msg.model,
    stopReason: msg.stop_reason,
  };
  const replacedDraft = deps.finalizeStreamingDraftMessage(sessionId, chatMsg);
  if (!replacedDraft) {
    upsertAssistantMessage(sessionId, chatMsg);
  }
  store.setStreaming(sessionId, null);
  deps.deleteStreamingPhase(sessionId);
  // Clear progress only for completed tools (tool_result blocks), not all tools.
  // Blanket clear would cause flickering during concurrent tool execution.
  if (msg.content?.length) {
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        store.clearToolProgress(sessionId, block.tool_use_id);
      }
    }
  }
  store.setSessionStatus(sessionId, "running");

  // Start timer if not already started (for non-streaming tool calls)
  if (!store.streamingStartedAt.has(sessionId)) {
    store.setStreamingStats(sessionId, { startedAt: Date.now() });
  }

  // Extract tasks and changed files from tool_use content blocks
  if (msg.content?.length) {
    extractTasksFromBlocks(sessionId, msg.content);
    extractChangedFilesFromBlocks(sessionId, msg.content);
    extractProcessesFromBlocks(sessionId, msg.content);
  }
}

// ── Streaming events ────────────────────────────────────────────────────────

export function handleStreamEvent(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "stream_event" }>,
  deps: HandlerDeps,
) {
  const store = useStore.getState();
  const evt = data.event as Record<string, unknown>;
  if (!evt || typeof evt !== "object") return;

  // message_start → mark generation start time
  if (evt.type === "message_start") {
    deps.deleteStreamingPhase(sessionId);
    deps.clearStreamingDraftMessage(sessionId);
    if (!store.streamingStartedAt.has(sessionId)) {
      store.setStreamingStats(sessionId, { startedAt: Date.now(), outputTokens: 0 });
    }
  }

  // content_block_delta → accumulate streaming text
  if (evt.type === "content_block_delta") {
    const delta = evt.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      let current = store.streaming.get(sessionId) || "";
      const thinkingPrefix = "Thinking:\n";
      const responsePrefix = "\n\nResponse:\n";
      if (deps.getStreamingPhase(sessionId) === "thinking" && !current.includes(responsePrefix)) {
        current += responsePrefix;
      }
      deps.setStreamingPhase(sessionId, "text");
      const nextText = current + delta.text;
      store.setStreaming(sessionId, nextText);
      deps.setStreamingDraftMessage(sessionId, nextText);
    }
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      const current = store.streaming.get(sessionId) || "";
      const prefix = "Thinking:\n";
      const phase = deps.getStreamingPhase(sessionId);
      const base = phase === "thinking"
        ? (current.startsWith(prefix) ? current : prefix)
        : prefix;
      deps.setStreamingPhase(sessionId, "thinking");
      const nextText = base + delta.thinking;
      store.setStreaming(sessionId, nextText);
      deps.setStreamingDraftMessage(sessionId, nextText);
    }
  }

  // message_delta → extract output token count
  if (evt.type === "message_delta") {
    const usage = (evt as { usage?: { output_tokens?: number } }).usage;
    if (usage?.output_tokens) {
      store.setStreamingStats(sessionId, { outputTokens: usage.output_tokens });
    }
  }
}

// ── Turn result ─────────────────────────────────────────────────────────────

export function handleResult(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "result" }>,
  deps: HandlerDeps,
) {
  const store = useStore.getState();
  // Flush processed tool IDs at end of turn — deduplication only needed
  // within a single turn. Preserves memory in long-running sessions.
  clearProcessedToolUseIds(sessionId);

  const r = data.data;
  const sessionUpdates: Partial<{ total_cost_usd: number; num_turns: number; context_used_percent: number; total_lines_added: number; total_lines_removed: number }> = {
    total_cost_usd: r.total_cost_usd,
    num_turns: r.num_turns,
  };
  // Forward lines changed if present
  if (typeof r.total_lines_added === "number") {
    sessionUpdates.total_lines_added = r.total_lines_added;
  }
  if (typeof r.total_lines_removed === "number") {
    sessionUpdates.total_lines_removed = r.total_lines_removed;
  }
  // Compute context % from modelUsage if available
  if (r.modelUsage) {
    for (const usage of Object.values(r.modelUsage)) {
      if (usage.contextWindow > 0) {
        const pct = Math.round(
          ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100,
        );
        sessionUpdates.context_used_percent = Math.max(0, Math.min(pct, 100));
      }
    }
  }
  store.updateSession(sessionId, sessionUpdates);
  deps.clearStreamingDraftMessage(sessionId);
  store.setStreaming(sessionId, null);
  deps.deleteStreamingPhase(sessionId);
  store.setStreamingStats(sessionId, null);
  store.clearToolProgress(sessionId);
  store.setSessionStatus(sessionId, "idle");
  // Play notification sound if enabled and tab is not focused
  if (!document.hasFocus() && store.notificationSound) {
    playNotificationSound();
  }
  if (!document.hasFocus() && store.notificationDesktop) {
    sendBrowserNotification("Session completed", "Claude finished the task", sessionId);
  }
  if (r.is_error && r.errors?.length) {
    store.appendMessage(sessionId, {
      id: deps.nextId(),
      role: "system",
      content: `Error: ${r.errors.join(", ")}`,
      timestamp: Date.now(),
    });
  }
}

// ── Permissions ─────────────────────────────────────────────────────────────

export function handlePermissionRequest(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "permission_request" }>,
) {
  const store = useStore.getState();
  store.addPermission(sessionId, data.request);
  if (!document.hasFocus() && store.notificationDesktop) {
    const req = data.request;
    sendBrowserNotification(
      "Permission needed",
      `${req.tool_name}: approve or deny`,
      req.request_id,
    );
  }
  // Also extract tasks and changed files from permission requests
  const req = data.request;
  if (req.tool_name && req.input) {
    const permBlocks = [{
      type: "tool_use" as const,
      id: req.tool_use_id,
      name: req.tool_name,
      input: req.input,
    }];
    extractTasksFromBlocks(sessionId, permBlocks);
    extractChangedFilesFromBlocks(sessionId, permBlocks);
    extractProcessesFromBlocks(sessionId, permBlocks);
  }
}

export function handlePermissionCancelled(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "permission_cancelled" }>,
) {
  useStore.getState().removePermission(sessionId, data.request_id);
}

// ── Tool progress ───────────────────────────────────────────────────────────

export function handleToolProgress(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "tool_progress" }>,
) {
  useStore.getState().setToolProgress(sessionId, data.tool_use_id, {
    toolName: data.tool_name,
    elapsedSeconds: data.elapsed_time_seconds,
  });
}

export function handleToolUseSummary(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "tool_use_summary" }>,
  deps: Pick<HandlerDeps, "nextId">,
) {
  useStore.getState().appendMessage(sessionId, {
    id: deps.nextId(),
    role: "system",
    content: data.summary,
    timestamp: Date.now(),
  });
}

// ── System events ───────────────────────────────────────────────────────────

export function handleSystemEvent(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "system_event" }>,
  deps: Pick<HandlerDeps, "nextId">,
) {
  const store = useStore.getState();
  // Update structured process state from task_notification
  if (data.event?.subtype === "task_notification") {
    const { task_id, status, summary: taskSummary } = data.event;
    if (task_id && status) {
      store.updateProcess(sessionId, task_id, {
        status: status as ProcessStatus,
        completedAt: Date.now(),
        summary: taskSummary || undefined,
      });
    }
  }

  const summary = summarizeSystemEvent(data.event);
  if (!summary) return;
  store.appendMessage(sessionId, {
    id: deps.nextId(),
    role: "system",
    content: summary,
    timestamp: data.timestamp || Date.now(),
  });
}

// ── Status / connection ─────────────────────────────────────────────────────

export function handleStatusChange(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "status_change" }>,
) {
  const store = useStore.getState();
  if (data.status === "compacting") {
    store.setSessionStatus(sessionId, "compacting");
  } else {
    store.setSessionStatus(sessionId, data.status);
  }
}

export function handleAuthStatus(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "auth_status" }>,
  deps: Pick<HandlerDeps, "nextId">,
) {
  if (data.error) {
    useStore.getState().appendMessage(sessionId, {
      id: deps.nextId(),
      role: "system",
      content: `Auth error: ${data.error}`,
      timestamp: Date.now(),
    });
  }
}

export function handleError(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "error" }>,
  deps: Pick<HandlerDeps, "nextId">,
) {
  useStore.getState().appendMessage(sessionId, {
    id: deps.nextId(),
    role: "system",
    content: data.message,
    timestamp: Date.now(),
  });
}

export function handleCliDisconnected(sessionId: string) {
  const store = useStore.getState();
  store.setCliConnected(sessionId, false);
  store.setSessionStatus(sessionId, null);
}

export function handleCliConnected(sessionId: string) {
  useStore.getState().setCliConnected(sessionId, true);
}

// ── Session metadata ────────────────────────────────────────────────────────

export function handleSessionNameUpdate(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "session_name_update" }>,
) {
  const store = useStore.getState();
  // Only apply auto-name if user hasn't manually renamed (still has random Adj+Noun name)
  const currentName = store.sessionNames.get(sessionId);
  const isRandomName = currentName && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(currentName);
  if (!currentName || isRandomName) {
    store.setSessionName(sessionId, data.name);
    store.markRecentlyRenamed(sessionId);
  }
}

export function handlePRStatusUpdate(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "pr_status_update" }>,
) {
  useStore.getState().setPRStatus(sessionId, { available: data.available, pr: data.pr });
}

export function handleMcpStatus(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "mcp_status" }>,
) {
  useStore.getState().setMcpServers(sessionId, data.servers);
}

// ── Message history (reconnect / initial load) ──────────────────────────────

export function handleMessageHistory(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "message_history" }>,
  deps: HandlerDeps,
) {
  const store = useStore.getState();
  const chatMessages: ChatMessage[] = [];
  for (let i = 0; i < data.messages.length; i++) {
    const histMsg = data.messages[i];
    if (histMsg.type === "user_message") {
      chatMessages.push({
        id: histMsg.id || deps.nextId(),
        role: "user",
        content: histMsg.content,
        timestamp: histMsg.timestamp,
      });
    } else if (histMsg.type === "assistant") {
      const msg = histMsg.message;
      const textContent = extractTextFromBlocks(msg.content);
      const assistantMsg: ChatMessage = {
        id: msg.id,
        role: "assistant",
        content: textContent,
        contentBlocks: msg.content,
        timestamp: histMsg.timestamp || Date.now(),
        parentToolUseId: histMsg.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
      };
      const existingIndex = chatMessages.findIndex(
        (m) => m.role === "assistant" && m.id === assistantMsg.id,
      );
      if (existingIndex === -1) {
        chatMessages.push(assistantMsg);
      } else {
        chatMessages[existingIndex] = mergeAssistantMessage(chatMessages[existingIndex], assistantMsg);
      }
      // Also extract tasks, changed files, and background processes from history
      if (msg.content?.length) {
        extractTasksFromBlocks(sessionId, msg.content);
        extractChangedFilesFromBlocks(sessionId, msg.content);
        extractProcessesFromBlocks(sessionId, msg.content);
      }
    } else if (histMsg.type === "result") {
      const r = histMsg.data;
      if (r.is_error && r.errors?.length) {
        chatMessages.push({
          id: `hist-error-${i}`,
          role: "system",
          content: `Error: ${r.errors.join(", ")}`,
          timestamp: Date.now(),
        });
      }
      // Track cost/turns from history result, same as the live result handler
      const resultUpdates: Partial<{ total_cost_usd: number; num_turns: number; context_used_percent: number; total_lines_added: number; total_lines_removed: number }> = {
        total_cost_usd: r.total_cost_usd,
        num_turns: r.num_turns,
      };
      if (typeof r.total_lines_added === "number") {
        resultUpdates.total_lines_added = r.total_lines_added;
      }
      if (typeof r.total_lines_removed === "number") {
        resultUpdates.total_lines_removed = r.total_lines_removed;
      }
      if (r.modelUsage) {
        for (const usage of Object.values(r.modelUsage)) {
          if (
            (usage as { contextWindow: number; inputTokens: number; outputTokens: number })
              .contextWindow > 0
          ) {
            const u = usage as { contextWindow: number; inputTokens: number; outputTokens: number };
            const pct = Math.round(((u.inputTokens + u.outputTokens) / u.contextWindow) * 100);
            resultUpdates.context_used_percent = Math.max(0, Math.min(pct, 100));
          }
        }
      }
      store.updateSession(sessionId, resultUpdates);
    } else if (histMsg.type === "system_event") {
      const summary = summarizeSystemEvent(histMsg.event);
      if (!summary) continue;
      chatMessages.push({
        id: `hist-system-event-${i}`,
        role: "system",
        content: summary,
        timestamp: histMsg.timestamp || Date.now(),
      });
    }
  }
  if (chatMessages.length > 0) {
    const existing = store.messages.get(sessionId) || [];
    if (existing.length === 0) {
      // Initial connect: history is the full truth
      store.setMessages(sessionId, chatMessages);
    } else {
      // Reconnect: merge history with live messages, upserting duplicate assistant IDs.
      const merged = [...existing];
      for (const incoming of chatMessages) {
        const idx = merged.findIndex((m) => m.id === incoming.id);
        if (idx === -1) {
          merged.push(incoming);
          continue;
        }
        const current = merged[idx];
        if (current.role === "assistant" && incoming.role === "assistant") {
          merged[idx] = mergeAssistantMessage(current, incoming);
        } else {
          merged[idx] = incoming;
        }
      }
      merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      store.setMessages(sessionId, merged);
    }
  }
  // Fix: if the last history message is a `result`, the session's last turn
  // is complete. Clear any stale streaming state that event_replay might not
  // correct (e.g. when `result` was pruned from the 600-event buffer).
  const lastHistMsg = data.messages[data.messages.length - 1];
  if (lastHistMsg?.type === "result") {
    deps.clearStreamingDraftMessage(sessionId);
    store.setStreaming(sessionId, null);
    deps.deleteStreamingPhase(sessionId);
    store.setStreamingStats(sessionId, null);
    store.clearToolProgress(sessionId);
    store.setSessionStatus(sessionId, "idle");
  }
}

// ── Event replay ────────────────────────────────────────────────────────────

export function handleEventReplay(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "event_replay" }>,
  deps: HandlerDeps,
) {
  let latestProcessed: number | undefined;
  for (const evt of data.events) {
    const previous = deps.getLastSeq(sessionId);
    if (evt.seq <= previous) continue;
    deps.setLastSeq(sessionId, evt.seq);
    latestProcessed = evt.seq;
    deps.handleParsedMessage(
      sessionId,
      evt.message as BrowserIncomingMessage,
      { processSeq: false, ackSeqMessage: false },
    );
  }
  if (typeof latestProcessed === "number") {
    deps.ackSeq(sessionId, latestProcessed);
  }
}
