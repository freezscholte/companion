// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const getFileTreeMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const getFileBlobMock = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  api: {
    getFileTree: getFileTreeMock,
    readFile: readFileMock,
    writeFile: writeFileMock,
    getFileBlob: getFileBlobMock,
  },
}));

vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      aria-label="Code editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

interface MockStoreState {
  darkMode: boolean;
  sessions: Map<string, { cwd?: string }>;
  sdkSessions: { sessionId: string; cwd?: string }[];
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    darkMode: false,
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

import { SessionEditorPane } from "./SessionEditorPane.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

// Helper: both desktop and mobile layouts render in jsdom (CSS hidden doesn't apply),
// so file buttons appear twice. Click the first one.
async function clickFile(name: string) {
  const btns = await screen.findAllByText(name);
  fireEvent.click(btns[0]);
}

describe("SessionEditorPane", () => {
  it("loads tree and reads file when selected", async () => {
    // Tree loads on mount, file content loads when a file is clicked
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [
        { name: "src", path: "/repo/src", type: "directory", children: [{ name: "a.ts", path: "/repo/src/a.ts", type: "file" }] },
      ],
    });
    readFileMock.mockResolvedValue({ path: "/repo/src/a.ts", content: "const a = 1;\n" });

    render(<SessionEditorPane sessionId="s1" />);

    await waitFor(() => expect(getFileTreeMock).toHaveBeenCalledWith("/repo"));

    // Click the file to select it (use first match — desktop and mobile both render)
    await clickFile("a.ts");

    await waitFor(() => expect(readFileMock).toHaveBeenCalledWith("/repo/src/a.ts"));
    // File path label appears in the editor header
    const pathLabels = await screen.findAllByText("src/a.ts");
    expect(pathLabels.length).toBeGreaterThanOrEqual(1);
  });

  it("saves when content changes", async () => {
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "index.ts", path: "/repo/index.ts", type: "file" }],
    });
    readFileMock.mockResolvedValue({ path: "/repo/index.ts", content: "hello\n" });
    writeFileMock.mockResolvedValue({ ok: true, path: "/repo/index.ts" });

    render(<SessionEditorPane sessionId="s1" />);

    // Click file to select it first
    await clickFile("index.ts");

    await waitFor(() => expect(readFileMock).toHaveBeenCalled());
    // CodeMirror mock renders as textarea; both layouts render it so get the first
    const editors = screen.getAllByLabelText("Code editor");
    fireEvent.change(editors[0], { target: { value: "hello!\n" } });
    // Save buttons also appear in both layouts — click the first
    const saveBtns = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saveBtns[0]);

    await waitFor(() => {
      expect(writeFileMock).toHaveBeenCalled();
      expect(writeFileMock.mock.calls[0][0]).toBe("/repo/index.ts");
    });
  });

  it("shows reconnecting message when cwd is unavailable", () => {
    resetStore({ sessions: new Map([["s1", {}]]) });
    render(<SessionEditorPane sessionId="s1" />);
    expect(screen.getByText("Editor unavailable while session is reconnecting.")).toBeInTheDocument();
  });

  it("renders image preview for image files instead of CodeMirror", async () => {
    // When an image file is selected, getFileBlob is called (not readFile)
    // and an <img> element is rendered instead of CodeMirror
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "logo.png", path: "/repo/logo.png", type: "file" }],
    });
    const fakeUrl = "blob:http://localhost/fake-image";
    getFileBlobMock.mockResolvedValue(fakeUrl);

    render(<SessionEditorPane sessionId="s1" />);

    await clickFile("logo.png");

    await waitFor(() => expect(getFileBlobMock).toHaveBeenCalledWith("/repo/logo.png"));
    // readFile should NOT be called for images
    expect(readFileMock).not.toHaveBeenCalled();

    // Image element should render with the blob URL
    const imgs = await screen.findAllByRole("img");
    expect(imgs[0]).toHaveAttribute("src", fakeUrl);
    expect(imgs[0]).toHaveAttribute("alt", "logo.png");
  });

  it("hides save button for image files", async () => {
    // Save button should not appear when viewing image files (they're read-only)
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "photo.jpg", path: "/repo/photo.jpg", type: "file" }],
    });
    getFileBlobMock.mockResolvedValue("blob:http://localhost/photo");

    render(<SessionEditorPane sessionId="s1" />);

    await clickFile("photo.jpg");

    await waitFor(() => expect(getFileBlobMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("has mobile back button for navigation", async () => {
    // Mobile layout shows a back button to return to file tree
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "main.ts", path: "/repo/main.ts", type: "file" }],
    });
    readFileMock.mockResolvedValue({ path: "/repo/main.ts", content: "code\n" });

    render(<SessionEditorPane sessionId="s1" />);

    await clickFile("main.ts");

    await waitFor(() => expect(readFileMock).toHaveBeenCalled());
    // Back button should exist (visible on mobile via sm:hidden)
    const backBtns = screen.getAllByLabelText("Back to file tree");
    expect(backBtns.length).toBeGreaterThanOrEqual(1);
  });
});
