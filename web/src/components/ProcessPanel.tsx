import { useState, useCallback, useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { ProcessItem, SystemProcess } from "../types.js";

const EMPTY_PROCESSES: ProcessItem[] = [];
const SYSTEM_POLL_INTERVAL = 15_000;

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function truncateCommand(cmd: string, max = 60): string {
  const first = cmd.split("\n")[0];
  if (first.length <= max) return first;
  return first.slice(0, max - 3) + "...";
}

function pathBasename(path: string): string {
  const cleaned = path.replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts[parts.length - 1] || cleaned || "/";
}

function pathDirname(path: string): string {
  const cleaned = path.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  if (idx <= 0) return "/";
  return cleaned.slice(0, idx);
}

function normalizePath(path?: string): string | undefined {
  if (!path) return undefined;
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "") || "/";
}

function isPathInside(path?: string, parent?: string): boolean {
  const a = normalizePath(path);
  const b = normalizePath(parent);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.startsWith(`${b}/`);
}

function compactPath(path: string, max = 68): string {
  if (path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return `...${path.slice(-(max - 3))}`;
  const tail = parts.slice(-2).join("/");
  const prefix = path.startsWith("/") ? "/" : "";
  const candidate = `${prefix}.../${tail}`;
  if (candidate.length <= max) return candidate;
  return `...${path.slice(-(max - 3))}`;
}

function extractProjectPathFromCommand(fullCommand: string): string | undefined {
  const candidates = [...fullCommand.matchAll(/\/[^\s"'`]+/g)].map((m) => m[0]);
  if (candidates.length === 0) return undefined;

  let best: { path: string; score: number } | null = null;
  for (const raw of candidates) {
    let candidate = raw;
    let score = 0;

    const nodeModulesIdx = candidate.indexOf("/node_modules/");
    if (nodeModulesIdx > 0) {
      candidate = candidate.slice(0, nodeModulesIdx);
      score += 4;
    }

    if (/\/\.[^/]+/.test(candidate)) {
      score -= 1;
    }
    if (/\/\.nvm\//.test(raw) || /\/bin\/(?:node|bun|python3?|ruby|php)$/.test(raw)) {
      score -= 3;
    }
    if (/\.(mjs|cjs|js|ts|tsx|py|rb|php|go)$/i.test(candidate)) {
      candidate = pathDirname(candidate);
      score += 2;
    }
    if (/\/Users\/|\/home\/|\/workspace\//.test(candidate)) {
      score += 1;
    }

    const normalized = normalizePath(candidate);
    if (!normalized) continue;
    if (!best || score > best.score || (score === best.score && normalized.length > best.path.length)) {
      best = { path: normalized, score };
    }
  }

  return best?.path;
}

function formatStartTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

interface SystemProcessGroup {
  key: string;
  label: string;
  path?: string;
  isCurrentRepo: boolean;
  processes: SystemProcess[];
}

function AccordionChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      className={`w-3 h-3 text-cc-muted shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <path d="M7 4l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function groupSystemProcesses(systemProcesses: SystemProcess[], currentRepoPath?: string): SystemProcessGroup[] {
  const groups = new Map<string, SystemProcessGroup>();

  for (const proc of systemProcesses) {
    const projectPath = normalizePath(proc.cwd) || extractProjectPathFromCommand(proc.fullCommand);
    const isCurrentRepo = isPathInside(projectPath, currentRepoPath);
    const key = projectPath || "__unknown__";
    const existing = groups.get(key);

    if (existing) {
      existing.processes.push(proc);
      existing.isCurrentRepo = existing.isCurrentRepo || isCurrentRepo;
      continue;
    }

    const label = projectPath ? pathBasename(projectPath) : "Unknown project";
    groups.set(key, {
      key,
      label,
      path: projectPath,
      isCurrentRepo,
      processes: [proc],
    });
  }

  return [...groups.values()].sort((a, b) => {
    if (a.isCurrentRepo !== b.isCurrentRepo) return a.isCurrentRepo ? -1 : 1;
    if (!!a.path !== !!b.path) return a.path ? -1 : 1;
    return (a.path || a.label).localeCompare(b.path || b.label);
  });
}

function inferSystemProcessTitle(proc: SystemProcess): string {
  const full = (proc.fullCommand || proc.command || "").trim();
  const lower = full.toLowerCase();

  if (/\bnext(\s+dev|\b)/.test(lower) || lower.includes("/next/dist/bin/next")) return "Next.js dev server";
  if (/\bvite\b/.test(lower)) return "Vite dev server";
  if (/\bnuxt\b/.test(lower)) return "Nuxt dev server";
  if (/\bastro\b/.test(lower)) return "Astro dev server";
  if (/\bremix\b/.test(lower)) return "Remix dev server";
  if (/\bwebpack(-dev-server)?\b/.test(lower)) return "Webpack dev server";
  if (/\bphp\s+artisan\s+serve\b/.test(lower)) return "Laravel dev server";
  if (/\buvicorn\b/.test(lower)) return "Uvicorn server";
  if (/\bgunicorn\b/.test(lower)) return "Gunicorn server";
  if (/\bpython(?:3)?\s+-m\s+http\.server\b/.test(lower)) return "Python http.server";
  if (/\b(?:bin\/rails|rails\s+server|puma)\b/.test(lower)) return "Rails app server";

  const scriptMatch = full.match(/(?:^|\s)([^\s"'`]+\.(?:mjs|cjs|js|ts|tsx|py|rb|php|go))(?=\s|$)/i);
  if (scriptMatch) {
    const filename = scriptMatch[1].split("/").pop();
    if (filename) return filename;
  }

  return truncateCommand(full || proc.command, 64);
}

// --- Claude Background Task Row ---

function ProcessRow({
  process,
  killing,
  onKill,
}: {
  process: ProcessItem;
  killing: boolean;
  onKill: (() => void) | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Tick every second for running processes to update duration
  useEffect(() => {
    if (process.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [process.status]);

  const statusColor: Record<string, string> = {
    running: "bg-cc-primary",
    completed: "bg-cc-success",
    failed: "bg-cc-error",
    stopped: "bg-cc-muted",
  };

  const duration = process.completedAt
    ? formatDuration(process.completedAt - process.startedAt)
    : formatDuration(now - process.startedAt);

  return (
    <div
      role="listitem"
      className={`px-4 py-2.5 border-b border-cc-border hover:bg-cc-hover/50 transition-colors ${process.status !== "running" ? "opacity-60" : ""}`}
      data-testid="process-row"
    >
      <div className="flex items-start gap-2">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${statusColor[process.status] || "bg-cc-muted"} ${process.status === "running" ? "animate-pulse" : ""}`}
          data-testid="process-status-dot"
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="text-[12px] text-cc-fg font-medium truncate text-left cursor-pointer hover:underline flex-1 min-w-0"
              title={process.description || process.command}
            >
              {process.description || truncateCommand(process.command)}
            </button>
            <span className="text-[10px] text-cc-muted tabular-nums shrink-0">
              {duration}
            </span>
          </div>

          <div className="text-[10px] text-cc-muted mt-0.5">
            ID: {process.taskId || "pending..."}
          </div>

          {expanded && (
            <div className="mt-1.5 space-y-1">
              <pre className="text-[10px] text-cc-muted bg-cc-hover rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all font-mono">
                {process.command}
              </pre>
              {process.summary && (
                <div className="text-[11px] text-cc-muted italic">
                  {process.summary}
                </div>
              )}
            </div>
          )}
        </div>

        {onKill && process.status === "running" && (
          <button
            type="button"
            onClick={onKill}
            disabled={killing}
            className="shrink-0 text-[11px] text-cc-error hover:text-red-500 disabled:opacity-50 transition-colors cursor-pointer px-2.5 py-1.5 min-h-[44px] rounded hover:bg-cc-hover"
            title="Kill process"
            aria-label={`Kill process ${process.taskId}`}
          >
            {killing ? "..." : "Kill"}
          </button>
        )}
      </div>
    </div>
  );
}

// --- System Dev Process Row ---

function SystemProcessRow({
  proc,
  killing,
  onKill,
}: {
  proc: SystemProcess;
  killing: boolean;
  onKill: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const title = inferSystemProcessTitle(proc);
  const commandPreview = truncateCommand(proc.fullCommand, 110);
  const showCommandPreview = commandPreview && commandPreview !== title;
  const uptime = proc.startedAt ? formatDuration(Math.max(0, now - proc.startedAt)) : null;
  const startedLabel = proc.startedAt ? formatStartTime(proc.startedAt) : null;

  useEffect(() => {
    if (!proc.startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [proc.startedAt]);

  return (
    <div
      role="listitem"
      className="px-4 py-2.5 border-b border-cc-border hover:bg-cc-hover/50 transition-colors"
      data-testid="system-process-row"
    >
      <div className="flex items-start gap-2">
        <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 bg-green-500 animate-pulse" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="text-[12px] text-cc-fg font-medium truncate text-left cursor-pointer hover:underline flex-1 min-w-0"
              title={proc.fullCommand}
            >
              {title}
            </button>
          </div>

          <div className="mt-0.5 flex items-center gap-1.5 flex-wrap text-[10px] text-cc-muted">
            <span className="rounded px-1 py-0.5 bg-cc-hover text-[9px] font-mono text-cc-fg/80">
              {proc.command}
            </span>
            <span>PID: {proc.pid}</span>
            {uptime && <span>Up {uptime}</span>}
            {startedLabel && <span>Started {startedLabel}</span>}
            {proc.ports.map((port) => (
              <a
                key={port}
                href={`http://localhost:${port}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open http://localhost:${port}`}
                className="text-[9px] rounded px-1 py-0.5 bg-cc-hover text-cc-muted tabular-nums font-mono"
              >
                localhost:{port}
              </a>
            ))}
          </div>

          {showCommandPreview && !expanded && (
            <div className="mt-1 text-[10px] text-cc-muted font-mono truncate" title={proc.fullCommand}>
              {commandPreview}
            </div>
          )}

          {expanded && (
            <pre className="mt-1.5 text-[10px] text-cc-muted bg-cc-hover rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all font-mono">
              {proc.fullCommand}
            </pre>
          )}
        </div>

        <button
          type="button"
          onClick={onKill}
          disabled={killing}
          className="shrink-0 text-[11px] text-cc-error hover:text-red-500 disabled:opacity-50 transition-colors cursor-pointer px-2.5 py-1.5 min-h-[44px] rounded hover:bg-cc-hover"
          title="Kill process"
          aria-label={`Kill system process ${proc.pid}`}
        >
          {killing ? "..." : "Kill"}
        </button>
      </div>
    </div>
  );
}

// --- Section Header ---

function SectionHeader({ title, count, action }: { title: string; count?: number; action?: React.ReactNode }) {
  return (
    <div className="shrink-0 px-4 py-2 border-b border-cc-border flex items-center justify-between bg-cc-bg">
      <span className="text-[11px] text-cc-muted uppercase tracking-wider">
        {title}{count !== undefined && count > 0 ? ` (${count})` : ""}
      </span>
      {action}
    </div>
  );
}

// --- Main Panel ---

export function ProcessPanel({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const processes = useStore((s) => s.sessionProcesses.get(sessionId)) || EMPTY_PROCESSES;
  const [killing, setKilling] = useState<Set<string>>(new Set());
  const [systemProcesses, setSystemProcesses] = useState<SystemProcess[]>([]);
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set());
  const [collapsedSystemGroups, setCollapsedSystemGroups] = useState<Set<string>>(new Set());
  const userToggledSystemGroupsRef = useRef<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const cancelledRef = useRef(false);

  const runningProcesses = processes.filter((p) => p.status === "running");
  const completedProcesses = processes.filter((p) => p.status !== "running");
  const currentRepoPath = session?.repo_root || session?.cwd;
  const systemGroups = groupSystemProcesses(systemProcesses, currentRepoPath);

  // Default folder groups: expand current repo, collapse others.
  // Re-apply for untouched groups so they self-correct if session repo metadata
  // arrives after the first process scan.
  useEffect(() => {
    setCollapsedSystemGroups((prev) => {
      let changed = false;
      const next = new Set(prev);
      const currentKeys = new Set(systemGroups.map((g) => g.key));

      for (const group of systemGroups) {
        if (userToggledSystemGroupsRef.current.has(group.key)) continue;

        if (group.isCurrentRepo) {
          if (next.delete(group.key)) changed = true;
        } else {
          if (!next.has(group.key)) {
            next.add(group.key);
            changed = true;
          }
        }
      }

      for (const key of [...next]) {
        if (!currentKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      for (const key of [...userToggledSystemGroupsRef.current]) {
        if (!currentKeys.has(key)) {
          userToggledSystemGroupsRef.current.delete(key);
        }
      }

      return changed ? next : prev;
    });
  }, [systemGroups]);

  const fetchSystemProcesses = useCallback(async () => {
    try {
      const result = await api.getSystemProcesses(sessionId);
      if (!cancelledRef.current && result.processes) {
        setSystemProcesses(result.processes);
      }
    } catch (err) {
      console.warn("[ProcessPanel] System process scan failed:", err instanceof Error ? err.message : err);
    }
  }, [sessionId]);

  // Poll for system dev processes every 15s
  useEffect(() => {
    cancelledRef.current = false;
    fetchSystemProcesses();
    const timer = setInterval(fetchSystemProcesses, SYSTEM_POLL_INTERVAL);
    return () => {
      cancelledRef.current = true;
      clearInterval(timer);
    };
  }, [fetchSystemProcesses]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchSystemProcesses();
    setRefreshing(false);
  }, [fetchSystemProcesses]);

  const handleKill = useCallback(
    async (taskId: string) => {
      setKilling((prev) => new Set([...prev, taskId]));
      try {
        await api.killProcess(sessionId, taskId);
        // Optimistically mark as stopped if no task_notification arrives within 3s
        setTimeout(() => {
          const store = useStore.getState();
          const current = store.sessionProcesses.get(sessionId);
          const proc = current?.find((p) => p.taskId === taskId);
          if (proc && proc.status === "running") {
            store.updateProcess(sessionId, taskId, {
              status: "stopped",
              completedAt: Date.now(),
            });
          }
        }, 3000);
      } catch {
        // Kill request failed — process may already be dead
      } finally {
        setKilling((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [sessionId],
  );

  const handleKillAll = useCallback(async () => {
    const ids = runningProcesses.map((p) => p.taskId).filter(Boolean);
    setKilling(new Set(ids));
    try {
      await api.killAllProcesses(sessionId, ids);
    } catch {
      // silently handle
    } finally {
      setKilling(new Set());
    }
  }, [sessionId, runningProcesses]);

  const handleKillSystemProcess = useCallback(
    async (pid: number) => {
      setKillingPids((prev) => new Set([...prev, pid]));
      try {
        await api.killSystemProcess(sessionId, pid);
        // Remove from local list after a short delay for the kill to take effect
        setTimeout(() => {
          setSystemProcesses((prev) => prev.filter((p) => p.pid !== pid));
        }, 1000);
      } catch {
        // Process may already be dead
      } finally {
        setKillingPids((prev) => {
          const next = new Set(prev);
          next.delete(pid);
          return next;
        });
      }
    },
    [sessionId],
  );

  const toggleSystemGroup = useCallback((groupKey: string) => {
    userToggledSystemGroupsRef.current.add(groupKey);
    setCollapsedSystemGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const hasAnything = processes.length > 0 || systemProcesses.length > 0;

  if (!hasAnything) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-6 text-center bg-cc-bg">
        <div className="w-12 h-12 mb-3 text-cc-muted/40">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M8 9h8m-8 4h6m-2-10h2.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h3 className="text-sm font-medium text-cc-fg mb-1">No background processes</h3>
        <p className="text-xs text-cc-muted max-w-[260px]">
          Background tasks spawned by Claude and dev servers listening on ports will appear here.
        </p>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="mt-3 text-[11px] text-cc-muted hover:text-cc-fg disabled:opacity-50 transition-colors cursor-pointer px-3 py-2 rounded border border-cc-border hover:bg-cc-hover"
          aria-label="Scan for dev servers"
        >
          {refreshing ? "Scanning..." : "Scan for dev servers"}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-cc-bg">
      <div className="flex-1 overflow-y-auto">
        {/* Claude Background Tasks */}
        {processes.length > 0 && (
          <>
            <SectionHeader
              title="Claude Tasks"
              count={runningProcesses.length}
              action={runningProcesses.length > 1 ? (
                <button
                  type="button"
                  onClick={handleKillAll}
                  className="text-[11px] px-2.5 py-1.5 text-cc-error hover:text-red-500 transition-colors cursor-pointer"
                  aria-label="Kill all running processes"
                >
                  Kill All
                </button>
              ) : undefined}
            />
            <div role="list" aria-label="Background processes">
              {runningProcesses.map((proc) => (
                <ProcessRow
                  key={proc.taskId || proc.toolUseId}
                  process={proc}
                  killing={killing.has(proc.taskId)}
                  onKill={() => handleKill(proc.taskId)}
                />
              ))}

              {completedProcesses.length > 0 && runningProcesses.length > 0 && (
                <div role="presentation" className="px-4 py-1.5 text-[10px] text-cc-muted uppercase tracking-wider border-t border-cc-border">
                  Completed
                </div>
              )}
              {completedProcesses.map((proc) => (
                <ProcessRow
                  key={proc.taskId || proc.toolUseId}
                  process={proc}
                  killing={false}
                  onKill={null}
                />
              ))}
            </div>
          </>
        )}

        {/* System Dev Servers */}
        {systemProcesses.length > 0 && (
          <>
            <SectionHeader
              title="Dev Servers"
              count={systemProcesses.length}
              action={
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="text-[11px] px-2 py-1.5 text-cc-muted hover:text-cc-fg disabled:opacity-50 transition-colors cursor-pointer"
                  aria-label="Refresh system processes"
                >
                  {refreshing ? "..." : "Refresh"}
                </button>
              }
            />
            {systemGroups.map((group) => {
              const isCollapsed = collapsedSystemGroups.has(group.key);
              const uniquePorts = [...new Set(group.processes.flatMap((proc) => proc.ports))].sort((a, b) => a - b);
              return (
                <div key={group.key}>
                  <div className="px-4 py-2.5 border-b border-cc-border bg-cc-hover/25">
                    <button
                      type="button"
                      onClick={() => toggleSystemGroup(group.key)}
                      className="w-full flex items-start justify-between gap-3 text-left cursor-pointer rounded px-2 py-1.5 hover:bg-cc-hover/60 transition-colors"
                      aria-expanded={!isCollapsed}
                      aria-label={`Toggle process group ${group.label}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <AccordionChevron expanded={!isCollapsed} />
                          <span className="text-[9px] rounded px-1 py-0.5 border border-cc-border text-cc-muted uppercase tracking-wide">
                            Folder
                          </span>
                          <span className="text-[12px] text-cc-fg font-medium">
                            {group.label}
                          </span>
                          <span className="text-[9px] rounded px-1.5 py-0.5 bg-cc-hover text-cc-fg/90">
                            {group.processes.length} running
                          </span>
                          {uniquePorts.length > 0 && (
                            <span className="text-[9px] rounded px-1.5 py-0.5 bg-cc-hover text-cc-muted">
                              {uniquePorts.length} port{uniquePorts.length === 1 ? "" : "s"}
                            </span>
                          )}
                          {group.isCurrentRepo && (
                            <span className="text-[9px] rounded px-1.5 py-0.5 bg-cc-primary/20 text-cc-primary">
                              Current repo
                            </span>
                          )}
                        </div>
                        {group.path && (
                          <div
                            className="mt-1 text-[10px] text-cc-muted font-mono truncate"
                            title={group.path}
                          >
                            {compactPath(group.path, 96)}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 hidden md:flex items-center gap-1.5 flex-wrap justify-end max-w-[40%]">
                        {uniquePorts.slice(0, 4).map((port) => (
                          <span
                            key={`${group.key}-port-${port}`}
                            className="text-[9px] rounded px-1 py-0.5 bg-cc-hover text-cc-muted tabular-nums font-mono"
                          >
                            :{port}
                          </span>
                        ))}
                        {uniquePorts.length > 4 && (
                          <span className="text-[9px] text-cc-muted">
                            +{uniquePorts.length - 4}
                          </span>
                        )}
                      </div>
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div
                      role="list"
                      aria-label={`System dev processes for ${group.label}`}
                      className="ml-4 border-l border-cc-border/40"
                    >
                      {group.processes.map((proc) => (
                        <SystemProcessRow
                          key={proc.pid}
                          proc={proc}
                          killing={killingPids.has(proc.pid)}
                          onKill={() => handleKillSystemProcess(proc.pid)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
