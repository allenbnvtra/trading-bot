import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Task 12 ("prove it" task for Milestone 5, see
 * .superpowers/sdd/2026-09-23-milestone-5-screenshot-generation/task-12-brief.md):
 * a static-analysis proof that the PRE_TRADE render route structurally
 * cannot reach post-trade/outcome data. This isn't a runtime behavior
 * check - it inspects the route's actual source code, so it fails
 * immediately if anyone later adds an import or call that reaches into
 * journal/trades (a JournalTrade's actualExit, netPnl, outcome, etc.),
 * which would let a PRE_TRADE chart see how the trade turned out and
 * defeat the entire anti-look-ahead guarantee this route exists to provide.
 *
 * Resolved relative to this dashboard package's own directory (via
 * import.meta.dirname, not a repo-root-relative literal) so the assertion
 * holds regardless of whether the test is invoked from the repo root, the
 * workspace package root, or a filtered `pnpm --filter` run - vitest's
 * `root` for this package is the package directory itself
 * (apps/dashboard/vitest.config.ts), so process.cwd() lands there too.
 *
 * The guard is checked against the file's code with comments stripped, not
 * its raw text. The route's own doc comments (see page.tsx) legitimately
 * discuss the anti-look-ahead guarantee in prose and mention the literal
 * strings "journal/trades" and "getJournalTrade" while explaining what must
 * never be imported - matching raw source text would make this test fail
 * permanently against its own documentation. Stripping comments first keeps
 * the check honest: it only ever fires on a real import or a real call in
 * executable code.
 *
 * As of this route's Task 7 review, the file's real import list is (see
 * page.tsx's own doc comment): getSetup, getMarketSnapshot, getInstrument,
 * getLatestRiskCalculation, getCandlesUpToTimestamp, and getStrategy (added
 * for a human-readable strategy label - a strategy-definition lookup, not a
 * journal/trades/outcome endpoint, so it does not weaken this guarantee).
 * None of those is getJournalTrade or a /journal/trades endpoint.
 */
describe("PRE_TRADE render route anti-look-ahead boundary", () => {
  const pageSourcePath = join(import.meta.dirname, "[setupId]", "page.tsx");
  const source = readFileSync(pageSourcePath, "utf-8");

  const FORBIDDEN_PATTERN = /getJournalTrade|journal\/trades/;

  /** Strips /* block *\/ and // line comments so doc-comment prose can't trip the guard below. */
  function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const codeOnly = stripComments(source);

  it("the route's doc comments genuinely discuss journal/trades in prose (sanity check that stripping is needed at all)", () => {
    expect(source).toMatch(FORBIDDEN_PATTERN);
  });

  it("never imports getJournalTrade or calls any /journal/trades endpoint, once comments are stripped", () => {
    expect(codeOnly).not.toMatch(FORBIDDEN_PATTERN);
  });

  /**
   * A meaningfulness check on the guard itself: prove it actually fails
   * against code it's supposed to catch, so a typo'd or over-narrow pattern
   * above can't pass merely because it never gets exercised against a
   * positive case. This never touches the real route file.
   */
  it("the guard genuinely flags a getJournalTrade import if one is added to the real code", () => {
    const tainted = stripComments(`import { getJournalTrade } from "@/lib/api";\n${source}`);
    expect(tainted).toMatch(FORBIDDEN_PATTERN);
  });

  it("the guard genuinely flags a /journal/trades endpoint call if one is added to the real code", () => {
    const tainted = stripComments(`${source}\nfetch("/journal/trades/123");`);
    expect(tainted).toMatch(FORBIDDEN_PATTERN);
  });

  it("the guard is not fooled by a getJournalTrade reference hidden inside a comment", () => {
    const stillClean = stripComments(`// getJournalTrade is not used here, see /journal/trades\n${source}`);
    expect(stillClean).not.toMatch(FORBIDDEN_PATTERN);
  });

  it("sanity-checks the source was actually read (non-trivial file, references the real render pipeline)", () => {
    expect(source.length).toBeGreaterThan(100);
    expect(source).toMatch(/RenderClient/);
  });
});
