"use client";

// Login-time "needs your attention" popup for global/super admins: pending access requests and
// untriaged (status "new") feature requests. Pops once per NEW item — dismissal stores high-water
// marks in localStorage (per user, per browser); lib/attention/seen.ts owns the comparison.
//
// forceOpen is the /tools/popup-test hook: it bypasses the seen-state check AND never writes
// marks, so exercising the modal there can't mark real items as seen. Zero items never opens,
// forced or not — "None" on the test page verifies exactly that.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  attentionStorageKey,
  marksAfterDismiss,
  parseSeenMarks,
  shouldShowAttention,
  type AttentionData,
} from "@/lib/attention/seen";

type Props = AttentionData & {
  userId: string | null;
  forceOpen?: boolean;
  onDismiss?: () => void;
};

export function AdminAttentionModal({ userId, forceOpen = false, onDismiss, ...data }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  // Decide once on mount. Later navigations re-run the server layout, which re-mounts this with
  // fresh data — there is deliberately no client-side polling.
  useEffect(() => {
    if (data.pendingRequests <= 0 && data.newFeatureRequests <= 0) return;
    if (forceOpen) {
      setOpen(true);
      return;
    }
    let stored: ReturnType<typeof parseSeenMarks> = null;
    try {
      stored = parseSeenMarks(localStorage.getItem(attentionStorageKey(userId)));
    } catch {
      // Storage unavailable (privacy mode) — treated as never-seen; it may show again. Harmless.
    }
    if (shouldShowAttention(data, stored)) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) ref.current?.showModal();
  }, [open]);

  // Every close path (Dismiss button, Esc, following a link) funnels through the dialog's own
  // close event, so the marks are recorded exactly once per dismissal.
  function handleClose() {
    if (!forceOpen) {
      try {
        const key = attentionStorageKey(userId);
        const prior = parseSeenMarks(localStorage.getItem(key));
        localStorage.setItem(key, JSON.stringify(marksAfterDismiss(data, prior)));
      } catch {
        // Storage write failed — it may show again next load, which is harmless.
      }
    }
    setOpen(false);
    onDismiss?.();
  }

  if (!open) return null;
  const reqs = data.pendingRequests;
  const frs = data.newFeatureRequests;
  return (
    <dialog ref={ref} style={{ maxWidth: 460 }} onClose={handleClose}>
      <h2>Needs your attention</h2>
      {reqs > 0 && (
        <div className="row-between" style={{ margin: "0.9rem 0" }}>
          <span>
            <span aria-hidden="true">👤</span> {reqs} user request{reqs === 1 ? "" : "s"} awaiting approval
          </span>
          <Link href="/users" onClick={() => ref.current?.close()}>
            Review →
          </Link>
        </div>
      )}
      {frs > 0 && (
        <div className="row-between" style={{ margin: "0.9rem 0" }}>
          <span>
            <span aria-hidden="true">💡</span> {frs} new feature request{frs === 1 ? "" : "s"}
          </span>
          <Link href="/feature-requests" onClick={() => ref.current?.close()}>
            View →
          </Link>
        </div>
      )}
      <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: "1rem" }}>
        <button type="button" className="primary" onClick={() => ref.current?.close()}>
          Dismiss
        </button>
      </div>
    </dialog>
  );
}
