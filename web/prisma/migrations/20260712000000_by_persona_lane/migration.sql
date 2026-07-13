-- New lane: a system runs only when the selected persona's bundle lists it (e.g. xMatters for Ops).
ALTER TYPE "Lifecycle" ADD VALUE IF NOT EXISTS 'by_persona';
