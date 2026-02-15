import { useState, useCallback } from "react";
import { api, type PluginRuntimeInfo } from "../api.js";

interface NotificationsConfig {
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

function parseConfig(raw: unknown): NotificationsConfig {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const events = src.events && typeof src.events === "object" ? src.events as Record<string, unknown> : {};
  const channels = src.channels && typeof src.channels === "object" ? src.channels as Record<string, unknown> : {};

  const toolLifecycleMode = src.toolLifecycleMode === "summary" || src.toolLifecycleMode === "verbose"
    ? src.toolLifecycleMode
    : "off";

  return {
    events: {
      sessionCreated: events.sessionCreated === true,
      sessionEnded: events.sessionEnded !== false,
      resultSuccess: events.resultSuccess === true,
      resultError: events.resultError !== false,
      permissionRequest: events.permissionRequest !== false,
      permissionResponse: events.permissionResponse !== false,
    },
    channels: {
      toast: channels.toast !== false,
      sound: channels.sound !== false,
      desktop: channels.desktop !== false,
    },
    toolLifecycleMode,
    suppressAutomatedPermissionResponses: src.suppressAutomatedPermissionResponses !== false,
    throttleMs: typeof src.throttleMs === "number" && Number.isFinite(src.throttleMs) ? Math.max(0, Math.min(src.throttleMs, 30000)) : 1200,
  };
}

function Toggle({ checked, onChange, label, description }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-left bg-cc-hover/50 hover:bg-cc-hover transition-colors cursor-pointer"
    >
      <div className="min-w-0">
        <span className="text-[13px] font-medium text-cc-fg">{label}</span>
        <p className="text-[11px] text-cc-muted mt-0.5">{description}</p>
      </div>
      <div className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${checked ? "bg-cc-primary" : "bg-cc-muted/30"}`}>
        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${checked ? "left-[18px]" : "left-0.5"}`} />
      </div>
    </button>
  );
}

interface Props {
  plugin: PluginRuntimeInfo;
  onRefresh: () => void;
}

export function NotificationPluginConfig({ plugin, onRefresh }: Props) {
  const [config, setConfig] = useState<NotificationsConfig>(() => parseConfig(plugin.config));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = useCallback(async (nextConfig: NotificationsConfig) => {
    setConfig(nextConfig);
    setSaving(true);
    setSaved(false);
    try {
      await api.updatePluginConfig(plugin.id, nextConfig);
      onRefresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      setConfig(parseConfig(plugin.config));
    } finally {
      setSaving(false);
    }
  }, [plugin.id, plugin.config, onRefresh]);

  const toggleEvent = (key: keyof NotificationsConfig["events"]) => {
    const next = { ...config, events: { ...config.events, [key]: !config.events[key] } };
    void save(next);
  };

  const toggleChannel = (key: keyof NotificationsConfig["channels"]) => {
    const next = { ...config, channels: { ...config.channels, [key]: !config.channels[key] } };
    void save(next);
  };

  const setToolLifecycleMode = (mode: NotificationsConfig["toolLifecycleMode"]) => {
    const next = { ...config, toolLifecycleMode: mode };
    void save(next);
  };

  const setThrottleMs = (value: number) => {
    const next = { ...config, throttleMs: Math.max(0, Math.min(value, 30000)) };
    void save(next);
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-2 px-1">Delivery Channels</h3>
        <div className="space-y-1">
          <Toggle checked={config.channels.toast} onChange={() => toggleChannel("toast")} label="In-app toast" description="Show notification toasts in Companion." />
          <Toggle checked={config.channels.desktop} onChange={() => toggleChannel("desktop")} label="Desktop notification" description="Trigger browser desktop notifications (if permission granted)." />
          <Toggle checked={config.channels.sound} onChange={() => toggleChannel("sound")} label="Sound" description="Play a short sound for notifications." />
        </div>
      </div>

      <div>
        <h3 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-2 px-1">Events</h3>
        <div className="space-y-1">
          <Toggle checked={config.events.sessionCreated} onChange={() => toggleEvent("sessionCreated")} label="Session started" description="Notify when a new session starts." />
          <Toggle checked={config.events.sessionEnded} onChange={() => toggleEvent("sessionEnded")} label="Session ended" description="Notify when a session is killed/archived/deleted." />
          <Toggle checked={config.events.resultSuccess} onChange={() => toggleEvent("resultSuccess")} label="Execution success" description="Notify after successful result." />
          <Toggle checked={config.events.resultError} onChange={() => toggleEvent("resultError")} label="Execution error" description="Notify after failed result." />
          <Toggle checked={config.events.permissionRequest} onChange={() => toggleEvent("permissionRequest")} label="Permission requested" description="Notify when a permission decision is needed." />
          <Toggle checked={config.events.permissionResponse} onChange={() => toggleEvent("permissionResponse")} label="Permission responded" description="Notify when allow/deny is sent." />
        </div>
      </div>

      <div className="space-y-2 px-1">
        <h3 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider">Tool Lifecycle</h3>
        <div className="flex gap-2">
          {(["off", "summary", "verbose"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setToolLifecycleMode(mode)}
              className={`px-2.5 py-1 rounded text-[11px] border cursor-pointer ${
                config.toolLifecycleMode === mode
                  ? "border-cc-primary/50 bg-cc-primary/10 text-cc-primary"
                  : "border-cc-border bg-cc-card text-cc-muted hover:text-cc-fg"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2 px-1">
        <Toggle
          checked={config.suppressAutomatedPermissionResponses}
          onChange={() => save({ ...config, suppressAutomatedPermissionResponses: !config.suppressAutomatedPermissionResponses })}
          label="Suppress automated permission responses"
          description="Hide noisy auto-allow/deny events from automation plugins."
        />
        <label className="text-[11px] text-cc-muted flex items-center justify-between gap-2">
          <span>Throttle (ms)</span>
          <input
            type="number"
            min={0}
            max={30000}
            value={config.throttleMs}
            onChange={(e) => setThrottleMs(Number(e.target.value))}
            className="w-24 px-2 py-1 rounded bg-cc-input-bg border border-cc-border text-cc-fg"
          />
        </label>
      </div>

      <div className="flex items-center justify-end px-1">
        {saving && <span className="text-[11px] text-cc-muted">Saving...</span>}
        {saved && <span className="text-[11px] text-cc-success">Saved</span>}
      </div>
    </div>
  );
}

