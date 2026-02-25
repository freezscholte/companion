/**
 * Reusable confirmation dialog modal.
 *
 * Renders a centered modal overlay with a title, description, and
 * Cancel / Confirm action buttons. Used for destructive confirmations
 * (delete session, delete all archived, etc.).
 */

interface ConfirmDialogProps {
  /** Dialog title (e.g. "Delete session?") */
  title: string;
  /** Descriptive text shown below the title */
  description: string;
  /** Label for the confirm (destructive) button */
  confirmLabel: string;
  /** Called when the user clicks Cancel or the backdrop */
  onCancel: () => void;
  /** Called when the user clicks the confirm button */
  onConfirm: () => void;
  /** SVG icon path(s) rendered inside a colored circle above the title */
  icon?: React.ReactNode;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
  icon,
}: ConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-[fadeIn_150ms_ease-out]"
      onClick={onCancel}
    >
      <div
        className="mx-4 w-full max-w-[280px] bg-cc-card border border-cc-border rounded-xl shadow-2xl p-5 animate-[menu-appear_150ms_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Icon */}
        {icon && (
          <div className="flex justify-center mb-3">
            {icon}
          </div>
        )}

        {/* Text */}
        <h3 className="text-[13px] font-semibold text-cc-fg text-center">
          {title}
        </h3>
        <p className="text-[12px] text-cc-muted text-center mt-1.5 leading-relaxed">
          {description}
        </p>

        {/* Actions */}
        <div className="flex gap-2.5 mt-4">
          <button
            onClick={onCancel}
            className="flex-1 px-3 py-2 text-[12px] font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-3 py-2 text-[12px] font-medium rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors cursor-pointer"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Standard delete icon used in the ConfirmDialog */
export function DeleteIcon() {
  return (
    <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5 text-red-400">
        <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z" />
        <path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 010-2H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM6 2h4v1H6V2z" clipRule="evenodd" />
      </svg>
    </div>
  );
}
