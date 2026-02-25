// @vitest-environment jsdom
/**
 * Tests for the CollapsibleSessionGroup component.
 *
 * Validates: rendering, expand/collapse toggle, session item rendering,
 * header action slot, and accessibility (axe).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import type { PermissionRequest } from "../types.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock the store — SessionItem uses useStore selectors internally
vi.mock("../store.js", () => {
  const state = {
    sessions: new Map(),
    sdkSessions: [],
    currentSessionId: null,
    cliConnected: new Map(),
    sessionStatus: new Map(),
    sessionNames: new Map(),
    recentlyRenamed: new Set(),
    pendingPermissions: new Map(),
    collapsedProjects: new Set(),
    setCurrentSession: vi.fn(),
    toggleProjectCollapse: vi.fn(),
    removeSession: vi.fn(),
    newSession: vi.fn(),
    setSidebarOpen: vi.fn(),
    setSessionName: vi.fn(),
    markRecentlyRenamed: vi.fn(),
    clearRecentlyRenamed: vi.fn(),
    setSdkSessions: vi.fn(),
    closeTerminal: vi.fn(),
  };
  const useStoreFn = (selector: (s: typeof state) => unknown) => selector(state);
  useStoreFn.getState = () => state;
  return { useStore: useStoreFn };
});

vi.mock("../ws.js", () => ({
  connectSession: vi.fn(),
  connectAllSessions: vi.fn(),
  disconnectSession: vi.fn(),
}));

vi.mock("../api.js", () => ({
  api: {
    listSessions: vi.fn().mockResolvedValue([]),
    deleteSession: vi.fn().mockResolvedValue({}),
    archiveSession: vi.fn().mockResolvedValue({}),
    unarchiveSession: vi.fn().mockResolvedValue({}),
    renameSession: vi.fn().mockResolvedValue({}),
  },
}));

// ─── Import component after mocks ───────────────────────────────────────────

import { CollapsibleSessionGroup } from "./CollapsibleSessionGroup.js";
import { useRef } from "react";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockSession(id: string, model = "claude-sonnet-4-6"): SessionItemType {
  return {
    id,
    model,
    cwd: "/home/user/project",
    gitBranch: "",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    status: "idle",
    sdkState: "connected",
    createdAt: Date.now(),
    archived: false,
    backendType: "claude",
    repoRoot: "",
    permCount: 0,
  };
}

/** Wrapper that provides a ref for the edit input */
function TestWrapper(props: Omit<React.ComponentProps<typeof CollapsibleSessionGroup>, "editInputRef">) {
  const ref = useRef<HTMLInputElement>(null);
  return <CollapsibleSessionGroup {...props} editInputRef={ref} />;
}

const baseProps = {
  label: "Scheduled Runs",
  count: 2,
  colorClass: "text-violet-400",
  hoverColorClass: "hover:text-violet-300",
  sessions: [makeMockSession("s1", "model-a"), makeMockSession("s2", "model-b")],
  currentSessionId: null,
  sessionNames: new Map<string, string>(),
  pendingPermissions: new Map<string, Map<string, PermissionRequest>>(),
  recentlyRenamed: new Set<string>(),
  onSelect: vi.fn(),
  onStartRename: vi.fn(),
  onArchive: vi.fn(),
  onUnarchive: vi.fn(),
  onDelete: vi.fn(),
  onClearRecentlyRenamed: vi.fn(),
  editingSessionId: null,
  editingName: "",
  setEditingName: vi.fn(),
  onConfirmRename: vi.fn(),
  onCancelRename: vi.fn(),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("CollapsibleSessionGroup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the label with count", () => {
    render(<TestWrapper {...baseProps} />);
    expect(screen.getByText(/Scheduled Runs \(2\)/)).toBeInTheDocument();
  });

  it("renders sessions when expanded (default)", () => {
    render(<TestWrapper {...baseProps} />);
    // Session models should be visible since defaultExpanded is true
    expect(screen.getByText("model-a")).toBeInTheDocument();
    expect(screen.getByText("model-b")).toBeInTheDocument();
  });

  it("hides sessions when collapsed", () => {
    render(<TestWrapper {...baseProps} defaultExpanded={false} />);
    // Sessions should not be visible when collapsed
    expect(screen.queryByText("model-a")).not.toBeInTheDocument();
    expect(screen.queryByText("model-b")).not.toBeInTheDocument();
  });

  it("toggling the header button shows/hides sessions", () => {
    render(<TestWrapper {...baseProps} defaultExpanded={false} />);
    expect(screen.queryByText("model-a")).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByText(/Scheduled Runs \(2\)/));
    expect(screen.getByText("model-a")).toBeInTheDocument();

    // Click again to collapse
    fireEvent.click(screen.getByText(/Scheduled Runs \(2\)/));
    expect(screen.queryByText("model-a")).not.toBeInTheDocument();
  });

  it("renders optional icon in the header", () => {
    const icon = <svg data-testid="custom-icon" />;
    render(<TestWrapper {...baseProps} icon={icon} />);
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
  });

  it("renders headerAction when expanded", () => {
    const action = <button data-testid="header-action">Delete all</button>;
    render(<TestWrapper {...baseProps} headerAction={action} />);
    expect(screen.getByTestId("header-action")).toBeInTheDocument();
  });

  it("hides headerAction when collapsed", () => {
    const action = <button data-testid="header-action">Delete all</button>;
    render(<TestWrapper {...baseProps} defaultExpanded={false} headerAction={action} />);
    expect(screen.queryByTestId("header-action")).not.toBeInTheDocument();
  });

  it("applies className to wrapper div", () => {
    const { container } = render(<TestWrapper {...baseProps} className="mt-2 pt-2" />);
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveClass("mt-2");
    expect(wrapper).toHaveClass("pt-2");
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<TestWrapper {...baseProps} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
