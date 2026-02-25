/**
 * Browser WebSocket client — connection management and message dispatch.
 *
 * This module owns the WebSocket lifecycle (connect, reconnect, disconnect)
 * and delegates incoming message handling to ws-message-handlers.ts.
 * Content block extraction utilities live in ws-extractors.ts.
 */

import { useStore } from "./store.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, ChatMessage, SdkSessionInfo, McpServerConfig } from "./types.js";
import { clearExtractorState } from "./ws-extractors.js";
import type { HandlerDeps, HandleParsedOptions } from "./ws-message-handlers.js";
import {
  handleSessionInit,
  handleSessionUpdate,
  handleAssistant,
  handleStreamEvent,
  handleResult,
  handlePermissionRequest,
  handlePermissionCancelled,
  handleToolProgress,
  handleToolUseSummary,
  handleSystemEvent,
  handleStatusChange,
  handleAuthStatus,
  handleError,
  handleCliDisconnected,
  handleCliConnected,
  handleSessionNameUpdate,
  handlePRStatusUpdate,
  handleMcpStatus,
  handleMessageHistory,
  handleEventReplay,
} from "./ws-message-handlers.js";

// Re-export public utilities from extractors
export { resolveSessionFilePath } from "./ws-extractors.js";

// ── Constants & per-session state ───────────────────────────────────────────

const WS_RECONNECT_DELAY_MS = 2000;
const sockets = new Map<string, WebSocket>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSeqBySession = new Map<string, number>();
const streamingPhaseBySession = new Map<string, "thinking" | "text">();
const streamingDraftMessageIdBySession = new Map<string, string>();

// ── ID generators ───────────────────────────────────────────────────────────

let idCounter = 0;
let clientMsgCounter = 0;

function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}`;
}

function nextClientMsgId(): string {
  return `cmsg-${Date.now()}-${++clientMsgCounter}`;
}

// ── Streaming draft message management ──────────────────────────────────────

function setStreamingDraftMessage(sessionId: string, content: string) {
  const store = useStore.getState();
  const existing = store.messages.get(sessionId) || [];
  const messages = [...existing];
  const existingDraftId = streamingDraftMessageIdBySession.get(sessionId);
  let draftIndex = -1;

  if (existingDraftId) {
    draftIndex = messages.findIndex((m) => m.id === existingDraftId);
    if (draftIndex === -1) {
      streamingDraftMessageIdBySession.delete(sessionId);
    }
  }

  if (draftIndex === -1) {
    const id = `stream-${sessionId}-${nextId()}`;
    streamingDraftMessageIdBySession.set(sessionId, id);
    messages.push({
      id,
      role: "assistant",
      content,
      timestamp: Date.now(),
      isStreaming: true,
    });
  } else {
    const prev = messages[draftIndex];
    messages[draftIndex] = {
      ...prev,
      role: "assistant",
      content,
      isStreaming: true,
    };
  }

  store.setMessages(sessionId, messages);
}

function finalizeStreamingDraftMessage(sessionId: string, finalMessage: ChatMessage): boolean {
  const draftId = streamingDraftMessageIdBySession.get(sessionId);
  if (!draftId) return false;

  const store = useStore.getState();
  const existing = store.messages.get(sessionId) || [];
  const draftIndex = existing.findIndex((m) => m.id === draftId);
  if (draftIndex === -1) {
    streamingDraftMessageIdBySession.delete(sessionId);
    return false;
  }

  const messages = [...existing];
  messages[draftIndex] = finalMessage;
  store.setMessages(sessionId, messages);
  streamingDraftMessageIdBySession.delete(sessionId);
  return true;
}

function clearStreamingDraftMessage(sessionId: string) {
  const draftId = streamingDraftMessageIdBySession.get(sessionId);
  if (!draftId) return;

  const store = useStore.getState();
  const existing = store.messages.get(sessionId) || [];
  const next = existing.filter((m) => m.id !== draftId);
  if (next.length !== existing.length) {
    store.setMessages(sessionId, next);
  }

  streamingDraftMessageIdBySession.delete(sessionId);
}

// ── Sequence tracking ───────────────────────────────────────────────────────

function getLastSeqStorageKey(sessionId: string): string {
  return `companion:last-seq:${sessionId}`;
}

function getLastSeq(sessionId: string): number {
  const cached = lastSeqBySession.get(sessionId);
  if (typeof cached === "number") return cached;
  try {
    const raw = localStorage.getItem(getLastSeqStorageKey(sessionId));
    const parsed = raw ? Number(raw) : 0;
    const normalized = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    lastSeqBySession.set(sessionId, normalized);
    return normalized;
  } catch {
    return 0;
  }
}

function setLastSeq(sessionId: string, seq: number): void {
  const normalized = Math.max(0, Math.floor(seq));
  lastSeqBySession.set(sessionId, normalized);
  try {
    localStorage.setItem(getLastSeqStorageKey(sessionId), String(normalized));
  } catch {
    // ignore storage errors
  }
}

function ackSeq(sessionId: string, seq: number): void {
  sendToSession(sessionId, { type: "session_ack", last_seq: seq });
}

// ── Handler deps (bridges ws.ts state to message handlers) ──────────────────

const handlerDeps: HandlerDeps = {
  nextId,
  getStreamingPhase: (sid) => streamingPhaseBySession.get(sid),
  setStreamingPhase: (sid, phase) => streamingPhaseBySession.set(sid, phase),
  deleteStreamingPhase: (sid) => { streamingPhaseBySession.delete(sid); },
  setStreamingDraftMessage,
  finalizeStreamingDraftMessage,
  clearStreamingDraftMessage,
  getLastSeq,
  setLastSeq,
  ackSeq,
  handleParsedMessage,
};

// ── Message dispatcher ──────────────────────────────────────────────────────

function handleMessage(sessionId: string, event: MessageEvent) {
  let data: BrowserIncomingMessage;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  // Promote to "connected" on first valid message (proves subscription succeeded)
  const store = useStore.getState();
  if (store.connectionStatus.get(sessionId) === "connecting") {
    store.setConnectionStatus(sessionId, "connected");
  }

  handleParsedMessage(sessionId, data);
}

function handleParsedMessage(
  sessionId: string,
  data: BrowserIncomingMessage,
  options: HandleParsedOptions = {},
) {
  const { processSeq = true, ackSeqMessage = true } = options;

  if (processSeq && typeof data.seq === "number") {
    const previous = getLastSeq(sessionId);
    if (data.seq <= previous) return;
    setLastSeq(sessionId, data.seq);
    if (ackSeqMessage) {
      ackSeq(sessionId, data.seq);
    }
  }

  switch (data.type) {
    case "session_init": return handleSessionInit(sessionId, data);
    case "session_update": return handleSessionUpdate(sessionId, data);
    case "assistant": return handleAssistant(sessionId, data, handlerDeps);
    case "stream_event": return handleStreamEvent(sessionId, data, handlerDeps);
    case "result": return handleResult(sessionId, data, handlerDeps);
    case "permission_request": return handlePermissionRequest(sessionId, data);
    case "permission_cancelled": return handlePermissionCancelled(sessionId, data);
    case "tool_progress": return handleToolProgress(sessionId, data);
    case "tool_use_summary": return handleToolUseSummary(sessionId, data, handlerDeps);
    case "system_event": return handleSystemEvent(sessionId, data, handlerDeps);
    case "status_change": return handleStatusChange(sessionId, data);
    case "auth_status": return handleAuthStatus(sessionId, data, handlerDeps);
    case "error": return handleError(sessionId, data, handlerDeps);
    case "cli_disconnected": return handleCliDisconnected(sessionId);
    case "cli_connected": return handleCliConnected(sessionId);
    case "session_name_update": return handleSessionNameUpdate(sessionId, data);
    case "pr_status_update": return handlePRStatusUpdate(sessionId, data);
    case "mcp_status": return handleMcpStatus(sessionId, data);
    case "message_history": return handleMessageHistory(sessionId, data, handlerDeps);
    case "event_replay": return handleEventReplay(sessionId, data, handlerDeps);
  }
}

// ── WebSocket connection management ─────────────────────────────────────────

const IDEMPOTENT_OUTGOING_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "user_message",
  "permission_response",
  "interrupt",
  "set_model",
  "set_permission_mode",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "mcp_set_servers",
]);

function getWsUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = localStorage.getItem("companion_auth_token") || "";
  return `${proto}//${location.host}/ws/browser/${sessionId}?token=${encodeURIComponent(token)}`;
}

export function connectSession(sessionId: string) {
  if (sockets.has(sessionId)) return;

  const store = useStore.getState();
  store.setConnectionStatus(sessionId, "connecting");

  const ws = new WebSocket(getWsUrl(sessionId));
  sockets.set(sessionId, ws);

  ws.onopen = () => {
    // Stay in "connecting" until we receive the first message from the server,
    // proving the subscription succeeded. handleMessage promotes to "connected".
    const lastSeq = getLastSeq(sessionId);
    ws.send(JSON.stringify({ type: "session_subscribe", last_seq: lastSeq }));
    // Clear any reconnect timer
    const timer = reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(sessionId);
    }
  };

  ws.onmessage = (event) => handleMessage(sessionId, event);

  ws.onclose = () => {
    sockets.delete(sessionId);
    useStore.getState().setConnectionStatus(sessionId, "disconnected");
    scheduleReconnect(sessionId);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect(sessionId: string) {
  if (reconnectTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    reconnectTimers.delete(sessionId);
    const store = useStore.getState();
    // Reconnect any active (non-archived) session
    const sdkSession = store.sdkSessions.find((s) => s.sessionId === sessionId);
    if (sdkSession && !sdkSession.archived) {
      connectSession(sessionId);
    }
  }, WS_RECONNECT_DELAY_MS);
  reconnectTimers.set(sessionId, timer);
}

export function disconnectSession(sessionId: string) {
  const timer = reconnectTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(sessionId);
  }
  const ws = sockets.get(sessionId);
  if (ws) {
    ws.close();
    sockets.delete(sessionId);
  }
  clearExtractorState(sessionId);
  streamingPhaseBySession.delete(sessionId);
  streamingDraftMessageIdBySession.delete(sessionId);
  lastSeqBySession.delete(sessionId);
}

export function disconnectAll() {
  for (const [id] of sockets) {
    disconnectSession(id);
  }
}

export function connectAllSessions(sessions: SdkSessionInfo[]) {
  for (const s of sessions) {
    if (!s.archived) {
      connectSession(s.sessionId);
    }
  }
}

export function waitForConnection(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      const ws = sockets.get(sessionId);
      if (ws?.readyState === WebSocket.OPEN) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
    const timeout = setTimeout(() => {
      clearInterval(check);
      reject(new Error("Connection timeout"));
    }, 10000);
  });
}

export function sendToSession(sessionId: string, msg: BrowserOutgoingMessage) {
  const ws = sockets.get(sessionId);
  let outgoing: BrowserOutgoingMessage = msg;
  if (IDEMPOTENT_OUTGOING_TYPES.has(msg.type)) {
    switch (msg.type) {
      case "user_message":
      case "permission_response":
      case "interrupt":
      case "set_model":
      case "set_permission_mode":
      case "mcp_get_status":
      case "mcp_toggle":
      case "mcp_reconnect":
      case "mcp_set_servers":
        if (!msg.client_msg_id) {
          outgoing = { ...msg, client_msg_id: nextClientMsgId() };
        }
        break;
    }
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(outgoing));
  }
}

export function sendMcpGetStatus(sessionId: string) {
  sendToSession(sessionId, { type: "mcp_get_status" });
}

export function sendMcpToggle(sessionId: string, serverName: string, enabled: boolean) {
  sendToSession(sessionId, { type: "mcp_toggle", serverName, enabled });
}

export function sendMcpReconnect(sessionId: string, serverName: string) {
  sendToSession(sessionId, { type: "mcp_reconnect", serverName });
}

export function sendMcpSetServers(sessionId: string, servers: Record<string, McpServerConfig>) {
  sendToSession(sessionId, { type: "mcp_set_servers", servers });
}
