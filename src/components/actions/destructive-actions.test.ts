import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// S11: every delete or unlink must go through a confirmation dialog.
const SRC = join(process.cwd(), "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

describe("destructive actions (S11)", () => {
  const sources = files(SRC).map((path) => [path, readFileSync(path, "utf8")] as const);

  it("never uses window.confirm", () => {
    for (const [path, source] of sources) expect(source, path).not.toMatch(/\bconfirm\(/);
  });

  it("dispatches delete and unlink actions only from a confirmation", () => {
    for (const [path, source] of sources) {
      if (!/(delete|unlink)\w*Action\b/.test(source) || path.includes(join("app", "dashboard"))) continue;
      expect(source, path).toMatch(/ConfirmActionButton|ConfirmDialog/);
      expect(source, path).not.toMatch(/<form[^>]*action=\{(delete|unlink)Action\}/);
    }
  });

  it("does not submit stage delete as a plain button in the row form", () => {
    const source = readFileSync(join(SRC, "components/stages/stage-row.tsx"), "utf8");
    expect(source).not.toMatch(/value="delete"/);
    expect(source).toMatch(/formData\.set\("intent", "delete"\)/);
  });
});
