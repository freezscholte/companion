/**
 * Collapsible session group for the Sidebar.
 *
 * Renders a toggle header (chevron + icon + label + count) and an
 * expandable list of SessionItem rows. Used for Scheduled Runs,
 * Agent Runs, and Archived sections.
 */
import { useState } from "react";
import { useStore } from "../store.js";
import { SessionItem } from "./SessionItem.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import type { PermissionRequest } from "../types.js";

interface CollapsibleSessionGroupProps {
  /** Section label (e.g. "Scheduled Runs") */
  label: string;
  /** Number of sessions in this group */
  count: number;
  /** Tailwind text-color class for the label (e.g. "text-violet-400") */
  colorClass: string;
  /** Tailwind hover text-color class for the label (e.g. "hover:text-violet-300") */
  hoverColorClass: string;
  /** Optional SVG icon rendered next to the label */
  icon?: React.ReactNode;
  /** Sessions to render when expanded */
  sessions: SessionItemType[];
  /** Whether the section starts expanded (default: true) */
  defaultExpanded?: boolean;
  /** CSS class for the wrapper div (e.g. border-top styling) */
  className?: string;
  /** Optional trailing element in the header row (e.g. "Delete all" button) */
  headerAction?: React.ReactNode;

  // ─── Passed through to SessionItem ────────────────────────────────
  currentSessionId: string | null;
  sessionNames: Map<string, string>;
  pendingPermissions: Map<string, Map<string, PermissionRequest>>;
  recentlyRenamed: Set<string>;
  /** Mark archived sessions (shows Restore instead of Archive in menu) */
  isArchived?: boolean;

  // SessionItem callback props (spread)
  onSelect: (sessionId: string) => void;
  onStartRename: (id: string, currentName: string) => void;
  onArchive: (e: React.MouseEvent, sessionId: string) => void;
  onUnarchive: (e: React.MouseEvent, sessionId: string) => void;
  onDelete: (e: React.MouseEvent, sessionId: string) => void;
  onClearRecentlyRenamed: (sessionId: string) => void;
  editingSessionId: string | null;
  editingName: string;
  setEditingName: (name: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  editInputRef: React.RefObject<HTMLInputElement | null>;
}

export function CollapsibleSessionGroup({
  label,
  count,
  colorClass,
  hoverColorClass,
  icon,
  sessions,
  defaultExpanded = true,
  className = "",
  headerAction,
  currentSessionId,
  sessionNames,
  pendingPermissions,
  recentlyRenamed,
  isArchived,
  onSelect,
  onStartRename,
  onArchive,
  onUnarchive,
  onDelete,
  onClearRecentlyRenamed,
  editingSessionId,
  editingName,
  setEditingName,
  onConfirmRename,
  onCancelRename,
  editInputRef,
}: CollapsibleSessionGroupProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className={className}>
      <div className="flex items-center">
        <button
          onClick={() => setExpanded(!expanded)}
          className={`flex-1 px-3 py-1.5 text-[11px] font-medium ${colorClass} uppercase tracking-wider flex items-center gap-1.5 ${hoverColorClass} transition-colors cursor-pointer`}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`}>
            <path d="M6 4l4 4-4 4" />
          </svg>
          {icon}
          {label} ({count})
        </button>
        {expanded && headerAction}
      </div>
      {expanded && (
        <div className="space-y-0.5 mt-1">
          {sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isActive={currentSessionId === s.id}
              isArchived={isArchived}
              sessionName={sessionNames.get(s.id)}
              permCount={pendingPermissions.get(s.id)?.size ?? 0}
              isRecentlyRenamed={recentlyRenamed.has(s.id)}
              onSelect={onSelect}
              onStartRename={onStartRename}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
              onDelete={onDelete}
              onClearRecentlyRenamed={onClearRecentlyRenamed}
              editingSessionId={editingSessionId}
              editingName={editingName}
              setEditingName={setEditingName}
              onConfirmRename={onConfirmRename}
              onCancelRename={onCancelRename}
              editInputRef={editInputRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}
