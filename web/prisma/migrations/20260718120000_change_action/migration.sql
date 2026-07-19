-- Add the "change" (mover / ad-hoc access) value to the Action enum.
ALTER TYPE "Action" ADD VALUE IF NOT EXISTS 'change';
