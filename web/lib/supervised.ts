// Is something standing by to relaunch this process if it exits? "Restart server" simply exits and
// trusts a supervisor to bring the app back — so it must refuse when nothing will.
//   - IAM_SUPERVISED=1: the launchd LaunchAgent installed by web/scripts/install-web-supervisor.sh
//     (KeepAlive relaunches on exit/crash).
//   - WEBSITE_SITE_NAME: Azure App Service — the platform always restarts an exited app process,
//     so the same exit-and-be-relaunched restart works there with no extra setup.
export function isSupervised(): boolean {
  return process.env.IAM_SUPERVISED === "1" || !!process.env.WEBSITE_SITE_NAME;
}
