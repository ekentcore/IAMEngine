import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "self-heal-watchdog",
  date: "2026-07-17",
  time: "12:45",
  title: "The server heals itself: heartbeat-killing failures pop a restart countdown and (supervised) restart automatically",
  items: [
    "Today's 20-minute fleet stall (a code update landed under the running server, one broken module 500'd every route including heartbeats) can no longer wait for a human: a watchdog started at boot probes the server's own routes, announces, waits a one-minute grace, and - when a supervisor will relaunch it - exits so it comes back clean",
    "Every open page shows what's happening: after ~45 seconds of wholesale failure a modal says the server will restart itself in about a minute (or, unsupervised, that a human must restart it), then the page reconnects and reloads on its own",
    "The restart can't loop: a 500 where the route never ran (fixable by restart) is distinguished from 'the route ran but the database is unreachable' (a restart can't fix that - the page says so instead), and self-restarts are capped at 3 per hour",
    "New public liveness endpoint /api/health/probe proves route code executes plus one database-reachability bit - /api/health couldn't serve this purpose because the middleware answers it before any route runs, so it looked healthy through the whole outage",
    "New web/scripts/activate-web-supervisor.sh switches the server to the launchd supervisor SAFELY: it verifies the supervised instance actually reaches the database and rolls back to a working server if macOS's Local Network permission still blocks it - the blocked-supervisor fleet stall from this morning can't recur",
  ],
};
