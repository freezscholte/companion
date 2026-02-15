import type {
  PermissionAutomationDecision,
  PluginDefinition,
  PluginEvent,
  PluginEventOf,
  PluginEventResult,
  PluginInsight,
  SoundVariant,
} from "./types.js";

interface NotificationsPluginConfig {
  events: {
    sessionCreated: boolean;
    sessionEnded: boolean;
    resultSuccess: boolean;
    resultError: boolean;
    permissionRequest: boolean;
    permissionResponse: boolean;
  };
  channels: {
    toast: boolean;
    sound: boolean;
    desktop: boolean;
  };
  toolLifecycleMode: "off" | "summary" | "verbose";
  suppressAutomatedPermissionResponses: boolean;
  throttleMs: number;
}

interface PermissionRule {
  id: string;
  enabled: boolean;
  backendType: "claude" | "codex" | "any";
  toolName?: string;
  commandContains?: string;
  filePathContains?: string;
  action: "allow" | "deny";
  message?: string;
}

interface PermissionAutomationPluginConfig {
  rules: PermissionRule[];
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asToolLifecycleMode(v: unknown): NotificationsPluginConfig["toolLifecycleMode"] {
  if (v === "summary" || v === "verbose" || v === "off") return v;
  return "off";
}

function normalizeNotificationsConfig(input: unknown): NotificationsPluginConfig {
  const src = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const events = src.events && typeof src.events === "object" ? src.events as Record<string, unknown> : {};
  const channels = src.channels && typeof src.channels === "object" ? src.channels as Record<string, unknown> : {};

  return {
    events: {
      sessionCreated: asBoolean(events.sessionCreated, false),
      sessionEnded: asBoolean(events.sessionEnded, true),
      resultSuccess: asBoolean(events.resultSuccess, false),
      resultError: asBoolean(events.resultError, true),
      permissionRequest: asBoolean(events.permissionRequest, true),
      permissionResponse: asBoolean(events.permissionResponse, true),
    },
    channels: {
      toast: asBoolean(channels.toast, true),
      sound: asBoolean(channels.sound, true),
      desktop: asBoolean(channels.desktop, true),
    },
    toolLifecycleMode: asToolLifecycleMode(src.toolLifecycleMode),
    suppressAutomatedPermissionResponses: asBoolean(src.suppressAutomatedPermissionResponses, true),
    throttleMs: Math.max(0, Math.min(asNumber(src.throttleMs, 1200), 30000)),
  };
}

function normalizePermissionAutomationConfig(input: unknown): PermissionAutomationPluginConfig {
  const src = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rulesRaw = Array.isArray(src.rules) ? src.rules : [];
  const rules: PermissionRule[] = [];

  for (const item of rulesRaw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const action = row.action === "allow" || row.action === "deny" ? row.action : null;
    if (!action) continue;

    const backendType = row.backendType === "claude" || row.backendType === "codex"
      ? row.backendType
      : "any";

    rules.push({
      id: asString(row.id) || `rule-${rules.length + 1}`,
      enabled: asBoolean(row.enabled, true),
      backendType,
      toolName: asString(row.toolName),
      commandContains: asString(row.commandContains),
      filePathContains: asString(row.filePathContains),
      action,
      message: asString(row.message),
    });
  }

  return { rules };
}

interface InsightCaps {
  toast?: boolean;
  sound?: boolean | SoundVariant;
  desktop?: boolean;
}

const notificationsThrottle = new Map<string, number>();

function shouldThrottle(
  config: NotificationsPluginConfig,
  event: PluginEvent,
  dedupeKey: string,
  sessionId?: string,
): boolean {
  if (config.throttleMs <= 0) return false;
  const key = `${sessionId || "global"}:${event.name}:${dedupeKey}`;
  const now = Date.now();
  const last = notificationsThrottle.get(key) || 0;
  if (now - last < config.throttleMs) {
    return true;
  }
  notificationsThrottle.set(key, now);
  return false;
}

function eventCaps(config: NotificationsPluginConfig, level: PluginInsight["level"], desktopOverride?: boolean): InsightCaps {
  return {
    toast: config.channels.toast,
    sound: config.channels.sound ? true : false,
    desktop: config.channels.desktop && (desktopOverride ?? true),
  };
}

function buildInsight(
  pluginId: string,
  event: PluginEvent,
  level: PluginInsight["level"],
  title: string,
  message: string,
  sessionId?: string,
  caps?: InsightCaps,
): PluginInsight {
  return {
    id: `${pluginId}-${event.meta.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    plugin_id: pluginId,
    title,
    message,
    level,
    timestamp: event.meta.timestamp,
    session_id: sessionId,
    event_name: event.name,
    ...caps,
  };
}

export const notificationsPlugin: PluginDefinition<NotificationsPluginConfig> = {
  id: "notifications",
  name: "Session Notifications",
  version: "2.0.0",
  apiVersion: 2,
  description: "Generates plugin notifications for session and execution events.",
  events: [
    "session.created",
    "session.killed",
    "session.archived",
    "session.deleted",
    "result.received",
    "permission.requested",
    "permission.responded",
    "tool.started",
    "tool.finished",
  ],
  priority: 50,
  blocking: true,
  timeoutMs: 1000,
  failPolicy: "continue",
  capabilities: ["insight:toast", "insight:sound", "insight:desktop"],
  riskLevel: "low",
  defaultEnabled: true,
  defaultConfig: {
    events: {
      sessionCreated: false,
      sessionEnded: true,
      resultSuccess: false,
      resultError: true,
      permissionRequest: true,
      permissionResponse: true,
    },
    channels: {
      toast: true,
      sound: true,
      desktop: true,
    },
    toolLifecycleMode: "off",
    suppressAutomatedPermissionResponses: true,
    throttleMs: 1200,
  },
  validateConfig: normalizeNotificationsConfig,
  onEvent: (event, config): PluginEventResult | void => {
    if (event.name === "session.created") {
      if (!config.events.sessionCreated) return;
      const payload = (event as PluginEventOf<"session.created">).data;
      if (shouldThrottle(config, event, "session-created", payload.session.session_id)) return;
      return {
        insights: [
          buildInsight(
            "notifications",
            event,
            "info",
            "Session started",
            `Session ${payload.session.session_id} launched in ${payload.session.backend_type}.`,
            payload.session.session_id,
            eventCaps(config, "info"),
          ),
        ],
      };
    }

    if (event.name === "session.killed" || event.name === "session.archived" || event.name === "session.deleted") {
      if (!config.events.sessionEnded) return;
      const payload = (event as PluginEventOf<"session.killed" | "session.archived" | "session.deleted">).data;
      if (shouldThrottle(config, event, `session-ended:${event.name}`, payload.sessionId)) return;
      return {
        insights: [
          buildInsight(
            "notifications",
            event,
            "warning",
            "Session ended",
            `Session ${payload.sessionId} ended (${event.name}).`,
            payload.sessionId,
            eventCaps(config, "warning"),
          ),
        ],
      };
    }

    if (event.name === "result.received") {
      const payload = (event as PluginEventOf<"result.received">).data;
      if (!payload.success && !config.events.resultError) return;
      if (payload.success && !config.events.resultSuccess) return;
      const dedupeKey = payload.success ? "result-success" : `result-error:${payload.errorSummary || "unknown"}`;
      if (shouldThrottle(config, event, dedupeKey, payload.sessionId)) return;
      return {
        insights: [
          buildInsight(
            "notifications",
            event,
            payload.success ? "success" : "error",
            payload.success ? "Execution completed" : "Execution error",
            payload.success ? `Result received (${payload.numTurns} turns).` : (payload.errorSummary || "Unknown error"),
            payload.sessionId,
            eventCaps(config, payload.success ? "success" : "error", !payload.success),
          ),
        ],
      };
    }

    if (event.name === "permission.requested") {
      if (!config.events.permissionRequest) return;
      const payload = (event as PluginEventOf<"permission.requested">).data;
      if (shouldThrottle(config, event, `perm-request:${payload.permission.tool_name}`, payload.sessionId)) return;
      return {
        insights: [
          buildInsight(
            "notifications",
            event,
            "info",
            "Permission requested",
            `${payload.permission.tool_name} is waiting for a decision.`,
            payload.sessionId,
            eventCaps(config, "info"),
          ),
        ],
      };
    }

    if (event.name === "permission.responded") {
      if (!config.events.permissionResponse) return;
      const payload = (event as PluginEventOf<"permission.responded">).data;
      if (config.suppressAutomatedPermissionResponses && payload.automated) return;
      if (shouldThrottle(config, event, `perm-response:${payload.behavior}`, payload.sessionId)) return;
      return {
        insights: [
          buildInsight(
            "notifications",
            event,
            payload.behavior === "allow" ? "success" : "warning",
            "Permission responded",
            `${payload.requestId}: ${payload.behavior}${payload.automated ? " (automated)" : ""}`,
            payload.sessionId,
            eventCaps(config, payload.behavior === "allow" ? "success" : "warning", false),
          ),
        ],
      };
    }

    if ((event.name === "tool.started" || event.name === "tool.finished") && config.toolLifecycleMode !== "off") {
      if (config.toolLifecycleMode === "summary" && event.name === "tool.started") return;
      const payload = (event as PluginEventOf<"tool.started" | "tool.finished">).data;
      if (shouldThrottle(config, event, `tool:${payload.toolUseId}`, payload.sessionId)) return;
      const message = event.name === "tool.started"
        ? `${(event as PluginEventOf<"tool.started">).data.toolName} started (${payload.toolUseId}).`
        : `Tool finished (${payload.toolUseId}).`;
      return {
        insights: [
          buildInsight(
            "notifications",
            event,
            "info",
            event.name === "tool.started" ? "Tool started" : "Tool finished",
            message,
            payload.sessionId,
            eventCaps(config, "info", false),
          ),
        ],
      };
    }

    return;
  },
};

function matchesRule(event: PluginEventOf<"permission.requested">, rule: PermissionRule): boolean {
  if (!rule.enabled) return false;
  if (rule.backendType !== "any" && rule.backendType !== event.data.backendType) return false;
  if (rule.toolName && rule.toolName !== event.data.permission.tool_name) return false;

  const normalized = event.data.toolInputNormalized;
  const command = normalized.command || "";
  const filePath = normalized.filePath || "";

  if (rule.commandContains && !command.includes(rule.commandContains)) return false;
  if (rule.filePathContains && !filePath.includes(rule.filePathContains)) return false;

  return true;
}

export const permissionAutomationPlugin: PluginDefinition<PermissionAutomationPluginConfig> = {
  id: "permission-automation",
  name: "Permission Automation",
  version: "2.0.0",
  apiVersion: 2,
  description: "Automates allow/deny permissions with explicit rules.",
  events: ["permission.requested"],
  priority: 1000,
  blocking: true,
  timeoutMs: 500,
  failPolicy: "abort_current_action",
  capabilities: ["permission:auto-decide", "insight:toast"],
  riskLevel: "high",
  defaultEnabled: false,
  defaultConfig: {
    rules: [],
  },
  validateConfig: normalizePermissionAutomationConfig,
  onEvent: (event, config): PluginEventResult | void => {
    if (event.name !== "permission.requested") return;
    const permissionEvent = event as PluginEventOf<"permission.requested">;

    for (const rule of config.rules) {
      if (!matchesRule(permissionEvent, rule)) continue;

      const decision: PermissionAutomationDecision = {
        behavior: rule.action,
        message: rule.message || `Auto decision (${rule.id})`,
        pluginId: "permission-automation",
      };

      return {
        permissionDecision: decision,
        insights: [
          buildInsight(
            "permission-automation",
            event,
            rule.action === "allow" ? "success" : "warning",
            "Permission auto-handled",
            `${permissionEvent.data.permission.tool_name}: ${rule.action} via rule ${rule.id}.`,
            permissionEvent.data.sessionId,
            { toast: true },
          ),
        ],
      };
    }

    return;
  },
};

export function getBuiltinPlugins(): Array<PluginDefinition<any>> {
  return [notificationsPlugin, permissionAutomationPlugin];
}
