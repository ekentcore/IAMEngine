import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "auto-update-stops-looping",
  date: "2026-09-09",
  time: "18:00",
  title: "The app stops telling a runner to update forever when the update never takes",
  items: [
    "The central cloud runner kept going down and needing a manual start. The crash was the app's doing, not the runner's: a self-update EXITS the runner process so it can come back on new code, and the app was asking it to self-update every 90 seconds, indefinitely",
    "Why indefinitely: the app decides an agent is stale by comparing the build it reports against the build the app serves. If a pull does not take, the agent comes back reporting the same build, still looks stale, and is asked again. Nothing anywhere counted the attempts, so nothing ever concluded that the update was not working",
    "That loop is survivable only for as long as the host's service manager keeps relaunching. Once it stops, the runner is simply down — which is what everyone saw, and why an operator had been clicking Update by hand (13 times on one agent over the past week)",
    "The app now counts consecutive updates that do not move an agent's build and stops after three. The agent stays UP on the code it has — behind, but working — instead of being exited every 90 seconds",
    "It also says so. The Agents page now shows \"self-update is not taking — stopped retrying after 3 attempts\" on that row, and unlike the transient update states it does not fade after five minutes, because it is a standing condition someone needs to look at",
    "Three agents are in this state today: the central cloud runner and TMMB-PA-DC01 (both on 1.116.0) and BFW-CCE-DC01 (on 1.114.0). Every other runner in the fleet took 1.118.0 within minutes, so this is those three hosts, not the update mechanism",
    "Clicking Update on an agent still works and clears the stall — an explicit request from a person outranks the guard, and starts a fresh count",
    "When a new runner build ships, stalled agents get a fresh set of attempts: a new bundle is a genuinely new thing to try, and the previous failure says nothing about it",
    "Web-only — no runner change, which is the point: the agents this affects are the ones that cannot currently take one",
  ],
};
