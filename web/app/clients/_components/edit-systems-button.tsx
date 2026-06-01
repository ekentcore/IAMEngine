"use client";

import { useState } from "react";
import { SystemsEditor } from "./systems-editor";

// Detail-page entry point to the systems editor.
export function EditSystemsButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="primary" onClick={() => setOpen(true)}>Edit systems</button>
      <SystemsEditor slug={open ? slug : null} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
