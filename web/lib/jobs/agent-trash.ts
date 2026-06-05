// Trash retention math for soft-deleted runners. A disabled runner moved to the trash is restorable
// for TRASH_RETENTION_DAYS, then eligible to be purged (hard-deleted). Pure + unit-tested.

export const TRASH_RETENTION_DAYS = 30;

// Whole days left before a trashed runner is purged (0 once expired).
export function trashDaysLeft(deletedAt: Date, now: Date, days = TRASH_RETENTION_DAYS): number {
  const remainingMs = days * 86_400_000 - (now.getTime() - deletedAt.getTime());
  return Math.max(0, Math.ceil(remainingMs / 86_400_000));
}

// True once a trashed runner has sat in the trash for the full retention window.
export function isTrashExpired(deletedAt: Date, now: Date, days = TRASH_RETENTION_DAYS): boolean {
  return now.getTime() - deletedAt.getTime() >= days * 86_400_000;
}

// The cutoff timestamp: anything deleted at or before this is purgeable.
export function purgeCutoff(now: Date, days = TRASH_RETENTION_DAYS): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
