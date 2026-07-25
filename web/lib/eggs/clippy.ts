// Clipper's page-aware one-liners — pure so clippy.test.ts can pin every route down.
// The popup itself lives in app/_components/eggs/clippy-egg.tsx.

export function clippyLine(pathname: string): string {
  if (pathname.startsWith("/cases")) {
    return "It looks like you're provisioning a user. Have you tried turning them off and on again? Oh wait — that's offboarding.";
  }
  if (pathname.startsWith("/agents")) {
    return "It looks like your runner fleet is polling. Would you like me to stare at the heartbeat column with you?";
  }
  if (pathname.startsWith("/runs")) {
    return "It looks like something failed. I have 200 suggestions, and every one of them is “check the credentials.”";
  }
  if (pathname.startsWith("/changelog")) {
    return "It looks like you're reading the changelog. Everything here shipped before you finished this sentence.";
  }
  if (pathname.startsWith("/clients")) {
    return "It looks like you're managing 200 client orgs. Have you considered a smaller font?";
  }
  return "Hi! It looks like you're automating identity. Would you like help? I've been waiting since 1997.";
}
