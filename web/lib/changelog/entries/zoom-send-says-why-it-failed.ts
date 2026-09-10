import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "zoom-send-says-why-it-failed",
  date: "2026-09-10",
  time: "20:00",
  title: "A Zoom message that does not arrive now says why, and stops reporting itself as sent",
  items: [
    "No change-log announcement has reached Zoom since 21 August. Every send was refused, and two things kept that invisible",
    "First, we threw away what Zoom said. A refused send was reported as \"HTTP 400\" and nothing else, with the only hint on offer being \"set the Zoom verification token\" — which is wrong whenever a token IS set, and one is. Zoom's actual answer was \"Failed to send bot message\", which nobody could see",
    "Second, the announce script printed \"announced: <entry>\" underneath, whether or not anything went out. A completely failed send read like a success",
    "Both are fixed: the failure now carries Zoom's own words, and a send where every destination refused says \"NOT announced\" (a partial one says how many took it)",
    "What the refusal MEANS, now that it is readable: the verification token is fine — it authenticates, and a bad one fails differently. Zoom is accepting the request and declining to deliver it, which is the Zoom app or its bot having lost access to those two channels. That is fixed in Zoom, by re-adding the bot to the channel or re-authorising the app — there is nothing further to change here",
    "So the ~25 entries shipped since 21 August have not been announced. Once the bot has access again they can be re-sent",
    "Web-only — no runner change",
  ],
};
