// @vitest-environment jsdom
/**
 * Tests for the ConfirmDialog component.
 *
 * Validates: rendering, button callbacks, backdrop click-to-cancel,
 * content propagation, and accessibility (axe).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ConfirmDialog, DeleteIcon } from "./ConfirmDialog.js";

describe("ConfirmDialog", () => {
  const defaultProps = {
    title: "Delete session?",
    description: "This will permanently delete this session.",
    confirmLabel: "Delete",
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders title, description, and button labels", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText("Delete session?")).toBeInTheDocument();
    expect(screen.getByText("This will permanently delete this session.")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByText("Delete"));
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when the Cancel button is clicked", () => {
    render(<ConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
    expect(defaultProps.onConfirm).not.toHaveBeenCalled();
  });

  it("calls onCancel when the backdrop overlay is clicked", () => {
    // The backdrop is the outermost div with the fixed inset-0 class.
    const { container } = render(<ConfirmDialog {...defaultProps} />);
    const backdrop = container.querySelector(".fixed.inset-0");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onCancel when clicking inside the dialog card", () => {
    // Clicking the card body should not propagate to the backdrop handler.
    render(<ConfirmDialog {...defaultProps} />);
    const title = screen.getByText("Delete session?");
    fireEvent.click(title);
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
  });

  it("renders an optional icon when provided", () => {
    render(<ConfirmDialog {...defaultProps} icon={<DeleteIcon />} />);
    // DeleteIcon renders an SVG with a specific path; check that the container div exists.
    const iconContainer = document.querySelector(".bg-red-500\\/10");
    expect(iconContainer).toBeTruthy();
  });

  it("does not render icon container when icon is not provided", () => {
    render(<ConfirmDialog {...defaultProps} />);
    // No icon wrapper should exist
    const iconContainer = document.querySelector(".bg-red-500\\/10");
    expect(iconContainer).toBeFalsy();
  });

  it("uses custom confirmLabel", () => {
    render(<ConfirmDialog {...defaultProps} confirmLabel="Delete all" />);
    expect(screen.getByText("Delete all")).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ConfirmDialog {...defaultProps} icon={<DeleteIcon />} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
