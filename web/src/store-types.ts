/**
 * Type definitions for the application Zustand store.
 *
 * Extracted from store.ts for readability — the AppState interface alone
 * is ~200 lines. Keeping it separate makes both the interface definition
 * and the store implementation easier to navigate.
 */

import type { SessionState, PermissionRequest, ChatMessage, SdkSessionInfo, TaskItem, ProcessItem, McpServerDetail } from "./types.js";
import type { UpdateInfo, PRStatusResponse, CreationProgressEvent, LinearIssue } from "./api.js";
import type { TaskPanelConfig } from "./components/task-panel-sections.js";

// ── Re-exported value types ─────────────────────────────────────────────────

export interface QuickTerminalTab {
  id: string;
  label: string;
  cwd: string;
  containerId?: string;
}

export type QuickTerminalPlacement = "top" | "right" | "bottom" | "left";

export type DiffBase = "last-commit" | "default-branch";

// ── Store interface ─────────────────────────────────────────────────────────

export interface AppState {
  // Auth
  authToken: string | null;
  isAuthenticated: boolean;

  // Sessions
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;

  // Messages per session
  messages: Map<string, ChatMessage[]>;

  // Streaming partial text per session
  streaming: Map<string, string>;

  // Streaming stats: start time + output tokens
  streamingStartedAt: Map<string, number>;
  streamingOutputTokens: Map<string, number>;

  // Pending permissions per session (outer key = sessionId, inner key = request_id)
  pendingPermissions: Map<string, Map<string, PermissionRequest>>;

  /** Browser↔Server WebSocket connection state per session */
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  /** CLI process↔Server connection state (pushed by server via "cli_connected"/"cli_disconnected") */
  cliConnected: Map<string, boolean>;

  // Session status
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;

  // Plan mode: stores previous permission mode per session so we can restore it
  previousPermissionMode: Map<string, string>;

  // Tasks per session
  sessionTasks: Map<string, TaskItem[]>;

  // Tick incremented when agent edits an in-scope file — used to trigger DiffPanel re-fetch
  changedFilesTick: Map<string, number>;
  // Count of files changed per session as reported by git (set by DiffPanel)
  gitChangedFilesCount: Map<string, number>;

  // Background processes per session (Bash with run_in_background)
  sessionProcesses: Map<string, ProcessItem[]>;

  // Session display names
  sessionNames: Map<string, string>;
  // Track sessions that were just renamed (for animation)
  recentlyRenamed: Set<string>;

  // PR status per session (pushed by server via WebSocket)
  prStatus: Map<string, PRStatusResponse>;

  // Linear issues linked to sessions
  linkedLinearIssues: Map<string, LinearIssue>;

  // MCP servers per session
  mcpServers: Map<string, McpServerDetail[]>;

  // Tool progress (session → tool_use_id → progress info)
  toolProgress: Map<string, Map<string, { toolName: string; elapsedSeconds: number }>>;

  // Sidebar project grouping
  collapsedProjects: Set<string>;

  // Update info
  updateInfo: UpdateInfo | null;
  updateDismissedVersion: string | null;
  updateOverlayActive: boolean;

  // Session creation progress (SSE streaming)
  creationProgress: CreationProgressEvent[] | null;
  creationError: string | null;
  sessionCreating: boolean;
  sessionCreatingBackend: "claude" | "codex" | null;
  addCreationProgress: (step: CreationProgressEvent) => void;
  clearCreation: () => void;
  setSessionCreating: (creating: boolean, backend?: "claude" | "codex") => void;
  setCreationError: (error: string | null) => void;

  // UI
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  sidebarOpen: boolean;
  taskPanelOpen: boolean;
  taskPanelConfig: TaskPanelConfig;
  taskPanelConfigMode: boolean;
  homeResetKey: number;
  editorTabEnabled: boolean;
  activeTab: "chat" | "diff" | "terminal" | "processes" | "editor";
  chatTabReentryTickBySession: Map<string, number>;
  diffPanelSelectedFile: Map<string, string>;

  // Auth actions
  setAuthToken: (token: string) => void;
  logout: () => void;

  // Actions
  setDarkMode: (v: boolean) => void;
  toggleDarkMode: () => void;
  setNotificationSound: (v: boolean) => void;
  toggleNotificationSound: () => void;
  setNotificationDesktop: (v: boolean) => void;
  toggleNotificationDesktop: () => void;
  setSidebarOpen: (v: boolean) => void;
  setTaskPanelOpen: (open: boolean) => void;
  setTaskPanelConfigMode: (open: boolean) => void;
  toggleSectionEnabled: (sectionId: string) => void;
  moveSectionUp: (sectionId: string) => void;
  moveSectionDown: (sectionId: string) => void;
  resetTaskPanelConfig: () => void;
  newSession: () => void;

  // Session actions
  setCurrentSession: (id: string | null) => void;
  addSession: (session: SessionState) => void;
  updateSession: (sessionId: string, updates: Partial<SessionState>) => void;
  removeSession: (sessionId: string) => void;
  setSdkSessions: (sessions: SdkSessionInfo[]) => void;

  // Message actions
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  setMessages: (sessionId: string, msgs: ChatMessage[]) => void;
  updateLastAssistantMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  setStreaming: (sessionId: string, text: string | null) => void;
  setStreamingStats: (sessionId: string, stats: { startedAt?: number; outputTokens?: number } | null) => void;

  // Permission actions
  addPermission: (sessionId: string, perm: PermissionRequest) => void;
  removePermission: (sessionId: string, requestId: string) => void;

  // Task actions
  addTask: (sessionId: string, task: TaskItem) => void;
  setTasks: (sessionId: string, tasks: TaskItem[]) => void;
  updateTask: (sessionId: string, taskId: string, updates: Partial<TaskItem>) => void;

  // Changed files actions
  bumpChangedFilesTick: (sessionId: string) => void;
  setGitChangedFilesCount: (sessionId: string, count: number) => void;

  // Process actions
  addProcess: (sessionId: string, process: ProcessItem) => void;
  updateProcess: (sessionId: string, taskId: string, updates: Partial<ProcessItem>) => void;
  updateProcessByToolUseId: (sessionId: string, toolUseId: string, updates: Partial<ProcessItem>) => void;

  // Session name actions
  setSessionName: (sessionId: string, name: string) => void;
  markRecentlyRenamed: (sessionId: string) => void;
  clearRecentlyRenamed: (sessionId: string) => void;

  // PR status action
  setPRStatus: (sessionId: string, status: PRStatusResponse) => void;

  // Linear issue actions
  setLinkedLinearIssue: (sessionId: string, issue: LinearIssue | null) => void;

  // MCP actions
  setMcpServers: (sessionId: string, servers: McpServerDetail[]) => void;

  // Tool progress actions
  setToolProgress: (sessionId: string, toolUseId: string, data: { toolName: string; elapsedSeconds: number }) => void;
  clearToolProgress: (sessionId: string, toolUseId?: string) => void;

  // Sidebar project grouping actions
  toggleProjectCollapse: (projectKey: string) => void;

  // Plan mode actions
  setPreviousPermissionMode: (sessionId: string, mode: string) => void;

  // Connection actions
  setConnectionStatus: (sessionId: string, status: "connecting" | "connected" | "disconnected") => void;
  setCliConnected: (sessionId: string, connected: boolean) => void;
  setSessionStatus: (sessionId: string, status: "idle" | "running" | "compacting" | null) => void;

  // Update actions
  setUpdateInfo: (info: UpdateInfo | null) => void;
  dismissUpdate: (version: string) => void;
  setUpdateOverlayActive: (active: boolean) => void;
  setEditorTabEnabled: (enabled: boolean) => void;

  // Diff panel actions
  setActiveTab: (tab: "chat" | "diff" | "terminal" | "processes" | "editor") => void;
  markChatTabReentry: (sessionId: string) => void;
  setDiffPanelSelectedFile: (sessionId: string, filePath: string | null) => void;

  // Session quick terminal (docked in session workspace)
  quickTerminalOpen: boolean;
  quickTerminalTabs: QuickTerminalTab[];
  activeQuickTerminalTabId: string | null;
  quickTerminalPlacement: QuickTerminalPlacement;
  quickTerminalNextHostIndex: number;
  quickTerminalNextDockerIndex: number;

  // Diff settings
  diffBase: DiffBase;

  // Session quick terminal actions
  setQuickTerminalOpen: (open: boolean) => void;
  openQuickTerminal: (opts: { target: "host" | "docker"; cwd: string; containerId?: string; reuseIfExists?: boolean }) => void;
  closeQuickTerminalTab: (tabId: string) => void;
  setActiveQuickTerminalTabId: (tabId: string | null) => void;
  resetQuickTerminal: () => void;

  // Diff settings actions
  setDiffBase: (base: DiffBase) => void;

  // Terminal state
  terminalOpen: boolean;
  terminalCwd: string | null;
  terminalId: string | null;

  // Terminal actions
  setTerminalOpen: (open: boolean) => void;
  setTerminalCwd: (cwd: string | null) => void;
  setTerminalId: (id: string | null) => void;
  openTerminal: (cwd: string) => void;
  closeTerminal: () => void;

  reset: () => void;
}
