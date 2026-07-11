-- CreateTable
CREATE TABLE "FixTask" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "branch" TEXT,
    "prUrl" TEXT,
    "log" TEXT,
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "FixTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FixTask_fingerprint_idx" ON "FixTask"("fingerprint");
