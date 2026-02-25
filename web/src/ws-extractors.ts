/**
 * Content block extraction utilities for the WebSocket message handler.
 *
 * Extracts structured data (tasks, changed files, background processes) from
 * Claude Code content blocks. Also provides text/block merge helpers and
 * notification utilities used across message handlers.
 */

import { useStore } from "./store.js";
import type { BrowserIncomingMessage, ContentBlock, ChatMessage, TaskItem, ProcessItem } from "./types.js";

// ── Path utilities ──────────────────────────────────────────────────────────

export function normalizePath(path: string): string {
  const isAbs = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return `${isAbs ? "/" : ""}${out.join("/")}`;
}

export function resolveSessionFilePath(filePath: string, cwd?: string): string {
  if (filePath.startsWith("/")) return normalizePath(filePath);
  if (!cwd) return normalizePath(filePath);
  return normalizePath(`${cwd}/${filePath}`);
}

export function isPathInSessionScope(filePath: string, cwd?: string): boolean {
  if (!cwd) return true;
  const normalizedCwd = normalizePath(cwd);
  return filePath === normalizedCwd || filePath.startsWith(`${normalizedCwd}/`);
}

// ── Text / block helpers ────────────────────────────────────────────────────

export function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return b.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function mergeContentBlocks(prev?: ContentBlock[], next?: ContentBlock[]): ContentBlock[] | undefined {
  const prevBlocks = prev || [];
  const nextBlocks = next || [];
  if (prevBlocks.length === 0 && nextBlocks.length === 0) return undefined;

  const merged: ContentBlock[] = [];
  const seen = new Set<string>();

  const pushUnique = (block: ContentBlock) => {
    const key = JSON.stringify(block);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(block);
  };

  for (const block of prevBlocks) pushUnique(block);
  for (const block of nextBlocks) pushUnique(block);
  return merged;
}

export function mergeAssistantMessage(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
  const mergedBlocks = mergeContentBlocks(previous.contentBlocks, incoming.contentBlocks);
  const mergedContent = mergedBlocks && mergedBlocks.length > 0
    ? extractTextFromBlocks(mergedBlocks)
    : (incoming.content || previous.content);

  return {
    ...previous,
    ...incoming,
    content: mergedContent,
    contentBlocks: mergedBlocks,
    // Keep the original timestamp position when this is an in-place assistant update.
    timestamp: previous.timestamp ?? incoming.timestamp,
    // Explicitly clear stale streaming marker when incoming is final.
    isStreaming: incoming.isStreaming,
  };
}

export function upsertAssistantMessage(sessionId: string, incoming: ChatMessage) {
  const store = useStore.getState();
  const existing = store.messages.get(sessionId) || [];
  const index = existing.findIndex((m) => m.role === "assistant" && m.id === incoming.id);
  if (index === -1) {
    store.appendMessage(sessionId, incoming);
    return;
  }

  const messages = [...existing];
  messages[index] = mergeAssistantMessage(messages[index], incoming);
  store.setMessages(sessionId, messages);
}

// ── Task extraction ─────────────────────────────────────────────────────────

/** Track processed tool_use IDs to prevent duplicate task creation */
const processedToolUseIds = new Map<string, Set<string>>();
const taskCounters = new Map<string, number>();

function getProcessedSet(sessionId: string): Set<string> {
  let set = processedToolUseIds.get(sessionId);
  if (!set) {
    set = new Set();
    processedToolUseIds.set(sessionId, set);
  }
  return set;
}

export function extractTasksFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const processed = getProcessedSet(sessionId);

  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input, id: toolUseId } = block;

    // Deduplicate by tool_use_id
    if (toolUseId) {
      if (processed.has(toolUseId)) continue;
      processed.add(toolUseId);
    }

    // TodoWrite: full replacement — { todos: [{ content, status, activeForm }] }
    if (name === "TodoWrite") {
      const todos = input.todos as { content?: string; status?: string; activeForm?: string }[] | undefined;
      if (Array.isArray(todos)) {
        const tasks: TaskItem[] = todos.map((t, i) => ({
          id: String(i + 1),
          subject: t.content || "Task",
          description: "",
          activeForm: t.activeForm,
          status: (t.status as TaskItem["status"]) || "pending",
        }));
        store.setTasks(sessionId, tasks);
        taskCounters.set(sessionId, tasks.length);
      }
      continue;
    }

    // TaskCreate: incremental add — { subject, description, activeForm }
    if (name === "TaskCreate") {
      const count = (taskCounters.get(sessionId) || 0) + 1;
      taskCounters.set(sessionId, count);
      const task = {
        id: String(count),
        subject: (input.subject as string) || "Task",
        description: (input.description as string) || "",
        activeForm: input.activeForm as string | undefined,
        status: "pending" as const,
      };
      store.addTask(sessionId, task);
      continue;
    }

    // TaskUpdate: incremental update — { taskId, status, owner, activeForm, addBlockedBy }
    if (name === "TaskUpdate") {
      const taskId = input.taskId as string;
      if (taskId) {
        const updates: Partial<TaskItem> = {};
        if (input.status) updates.status = input.status as TaskItem["status"];
        if (input.owner) updates.owner = input.owner as string;
        if (input.activeForm !== undefined) updates.activeForm = input.activeForm as string;
        if (input.addBlockedBy) updates.blockedBy = input.addBlockedBy as string[];
        store.updateTask(sessionId, taskId, updates);
      }
    }
  }
}

// ── Changed files extraction ────────────────────────────────────────────────

export function extractChangedFilesFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const sessionCwd =
    store.sessions.get(sessionId)?.cwd ||
    store.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd;
  let dirty = false;
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input } = block;
    if ((name === "Edit" || name === "Write") && typeof input.file_path === "string") {
      const resolvedPath = resolveSessionFilePath(input.file_path, sessionCwd);
      if (isPathInSessionScope(resolvedPath, sessionCwd)) {
        dirty = true;
      }
    }
  }
  if (dirty) store.bumpChangedFilesTick(sessionId);
}

// ── Background process extraction ───────────────────────────────────────────

/** Pending background Bash calls awaiting their tool_result (keyed by sessionId → toolUseId) */
const pendingBackgroundBash = new Map<string, Map<string, { command: string; description: string; startedAt: number }>>();

const BG_RESULT_REGEX = /Command running in background with ID:\s*(\S+)\.\s*Output is being written to:\s*(\S+)/;

export function extractProcessesFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();

  for (const block of blocks) {
    // Phase 1: Detect Bash tool_use with run_in_background
    if (block.type === "tool_use" && block.name === "Bash") {
      const input = block.input as Record<string, unknown>;
      if (input.run_in_background === true) {
        let sessionPending = pendingBackgroundBash.get(sessionId);
        if (!sessionPending) {
          sessionPending = new Map();
          pendingBackgroundBash.set(sessionId, sessionPending);
        }
        sessionPending.set(block.id, {
          command: (input.command as string) || "",
          description: (input.description as string) || "",
          startedAt: Date.now(),
        });
      }
    }

    // Phase 2: Match tool_result to a pending background Bash
    if (block.type === "tool_result") {
      const toolUseId = block.tool_use_id;
      const sessionPending = pendingBackgroundBash.get(sessionId);
      const pending = sessionPending?.get(toolUseId);
      if (sessionPending && pending) {
        const content = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
            : "";

        const match = content.match(BG_RESULT_REGEX);
        if (match) {
          const processItem: ProcessItem = {
            taskId: match[1],
            toolUseId,
            command: pending.command,
            description: pending.description,
            outputFile: match[2],
            status: "running",
            startedAt: pending.startedAt,
          };
          store.addProcess(sessionId, processItem);
        }

        sessionPending.delete(toolUseId);
        if (sessionPending.size === 0) {
          pendingBackgroundBash.delete(sessionId);
        }
      }
    }
  }
}

// ── Notification helpers ────────────────────────────────────────────────────

export function sendBrowserNotification(title: string, body: string, tag: string) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  new Notification(title, { body, tag });
}

// ── System event summarizer ─────────────────────────────────────────────────

export function summarizeSystemEvent(
  event: Extract<BrowserIncomingMessage, { type: "system_event" }>["event"],
): string | null {
  if (event.subtype === "compact_boundary") {
    return `Context compacted (${event.compact_metadata.trigger}, pre-tokens: ${event.compact_metadata.pre_tokens}).`;
  }

  if (event.subtype === "task_notification") {
    const summary = event.summary ? ` ${event.summary}` : "";
    return `Task ${event.status}: ${event.task_id}.${summary}`;
  }

  if (event.subtype === "files_persisted") {
    const persisted = event.files.length;
    const failed = event.failed.length;
    if (failed > 0) {
      return `Persisted ${persisted} file(s), ${failed} failed.`;
    }
    return `Persisted ${persisted} file(s).`;
  }

  if (event.subtype === "hook_started") {
    return `Hook started: ${event.hook_name} (${event.hook_event}).`;
  }

  if (event.subtype === "hook_response") {
    const exitCode = typeof event.exit_code === "number" ? ` (exit ${event.exit_code})` : "";
    return `Hook ${event.outcome}: ${event.hook_name} (${event.hook_event})${exitCode}.`;
  }

  // hook_progress can be high-volume; keep it out of chat by default.
  return null;
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/** Clear all per-session extractor state. Call when disconnecting a session. */
export function clearExtractorState(sessionId: string) {
  processedToolUseIds.delete(sessionId);
  pendingBackgroundBash.delete(sessionId);
  taskCounters.delete(sessionId);
}

/** Clear processed tool_use IDs at end of turn (deduplication only needed within a turn). */
export function clearProcessedToolUseIds(sessionId: string) {
  processedToolUseIds.delete(sessionId);
}
