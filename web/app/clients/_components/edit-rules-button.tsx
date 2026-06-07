"use client";

import { useState } from "react";
import { RulesEditor } from "./rules-editor";

// Detail-page entry point to the no-code roles & rules editor. Always available (even when the
// client has no rules yet) so you can create the first persona/rule.
export function EditRulesButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Edit rules</button>
      <RulesEditor slug={open ? slug : null} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
