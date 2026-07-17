// Parse a Playwright codegen script (from `npx playwright codegen <portal>`) into declarative browser
// steps. This is the no-code path for browser connectors: an admin records the task once, pastes the
// generated script, and gets a starter step list they finish (add {{templates}}, mark the password
// step secret). We only parse the common getBy*/locator + action calls codegen emits; anything we
// don't recognize is reported so nothing is silently dropped.
import type { BrowserStep } from "./definition";

export type CodegenResult = { startUrl: string | null; steps: BrowserStep[]; unrecognized: string[] };

// Pull the single/double/back-tick quoted string arguments out of a call's arg list.
function args(s: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[2].replace(/\\(['"`])/g, "$1"));
  return out;
}

// A getBy* chain → a step target. Handles getByRole('button', { name: 'X' }), getByLabel('Email'),
// getByPlaceholder, getByText, getByTestId, and locator('css').
function targetFrom(chain: string): BrowserStep["target"] | null {
  let m: RegExpExecArray | null;
  if ((m = /getByRole\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*\{[^}]*name:\s*['"`]([^'"`]+)['"`])?/.exec(chain))) {
    return { role: m[1], ...(m[2] ? { name: m[2] } : {}) };
  }
  if ((m = /getByLabel\(\s*['"`]([^'"`]+)['"`]/.exec(chain))) return { label: m[1] };
  if ((m = /getByPlaceholder\(\s*['"`]([^'"`]+)['"`]/.exec(chain))) return { placeholder: m[1] };
  if ((m = /getByText\(\s*['"`]([^'"`]+)['"`]/.exec(chain))) return { text: m[1] };
  if ((m = /getByTestId\(\s*['"`]([^'"`]+)['"`]/.exec(chain))) return { testId: m[1] };
  if ((m = /locator\(\s*['"`]([^'"`]+)['"`]/.exec(chain))) return { css: m[1] };
  return null;
}

export function importCodegen(script: string): CodegenResult {
  const steps: BrowserStep[] = [];
  const unrecognized: string[] = [];
  let startUrl: string | null = null;

  for (const rawLine of script.split("\n")) {
    const line = rawLine.trim().replace(/;$/, "");
    if (!line || line.startsWith("//") || line.startsWith("import ") || /^(await )?(test|expect\.configure|const|let|browser|context|page\s*=)/.test(line) && !/page\.(goto|getBy|locator)/.test(line)) {
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = /page\.goto\(/.exec(line))) {
      const [url] = args(line);
      if (url) { steps.push({ type: "goto", url }); if (!startUrl) startUrl = url; }
      continue;
    }
    // action is the LAST .method(...) in the chain; the target is everything before it.
    const actionMatch = /\.(fill|click|press|selectOption|check|uncheck)\(([^)]*)\)\s*$/.exec(line);
    if (actionMatch && /page\./.test(line)) {
      const action = actionMatch[1];
      const chain = line.slice(0, actionMatch.index);
      const target = targetFrom(chain);
      if (!target) { unrecognized.push(rawLine.trim()); continue; }
      const callArgs = args(actionMatch[2]);
      switch (action) {
        case "fill":
          steps.push({ type: "fill", target, value: callArgs[0] ?? "" });
          break;
        case "press":
          steps.push({ type: "press", target, value: callArgs[0] ?? "Enter" });
          break;
        case "selectOption":
          steps.push({ type: "select", target, value: callArgs[0] ?? "" });
          break;
        case "click":
        case "check":
        case "uncheck":
          steps.push({ type: "click", target });
          break;
      }
      continue;
    }
    // A codegen assertion → an expect step.
    if ((m = /expect\((.*)\)\.(toBeVisible|toContainText|toHaveText)/.exec(line))) {
      const target = targetFrom(m[1]);
      if (target) steps.push({ type: "expect", target });
      else unrecognized.push(rawLine.trim());
      continue;
    }
    if (/page\.(getBy|locator|goto)/.test(line)) unrecognized.push(rawLine.trim());
  }

  return { startUrl, steps, unrecognized };
}
