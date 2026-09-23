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
 * string "journal/trades" three times while explaining what must never be
 * called (grep-confirmed: "getJournalTrade" itself does not appear anywhere
 * in page.tsx, only "journal/trades" does) - matching raw source text would
 * make this test fail permanently against its own documentation. Stripping
 * comments first keeps the check honest: it only ever fires on a real
 * import or a real call in executable code.
 *
 * Comment stripping is deliberately line-anchored (`^\s*\/\/.*$`, a whole
 * line that is only a `//` comment) rather than "strip from the first `//`
 * to end of line anywhere in the line". The latter is unsound: a real
 * violation like `fetch("https://api.example.com/journal/trades/123")`
 * contains `//` inside the string literal (from `https://`), so a
 * match-anywhere strip would truncate the line at that `//` and delete the
 * `journal/trades` substring along with it - a false negative that lets a
 * real violation through undetected. This file's own comment convention
 * (grep-verified below) is block comments for docs plus standalone `//`
 * lines - no line in page.tsx has real code followed by a trailing `//`
 * comment - so the line-anchored strip is sound for this specific file. It
 * would NOT be sound for a file that mixes trailing inline comments with
 * code on the same line; that would need real tokenization (e.g. the
 * TypeScript compiler API), not a regex.
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

  /**
   * Strips `/* block *\/` comments and whole-line `//` comments (a line
   * that is only whitespace followed by `//`) so doc-comment prose can't
   * trip the guard below. Deliberately does NOT strip a trailing `//`
   * appearing after real code on the same line - see this file's top
   * doc comment for why that would be unsound (it would truncate a
   * violation like `fetch("https://.../journal/trades/1")` at the `//`
   * inside the URL and silently drop the forbidden substring).
   */
  function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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

  /**
   * Regression test for a real reviewer-caught bug: an earlier version of
   * `stripComments` stripped from the first `//` anywhere on a line to
   * end-of-line, which silently truncated an absolute-URL call like
   * `fetch("https://api.example.com/journal/trades/123")` at the `//`
   * inside `https://`, deleting the `journal/trades` substring along with
   * it and letting a genuine violation through the guard undetected
   * (demonstrated: raw text matched FORBIDDEN_PATTERN, but the
   * old-algorithm stripped result was `fetch("https:` and did not).
   * The line-anchored strip above must not have this blind spot.
   */
  it("the guard catches an absolute-URL call to a journal/trades endpoint, not just a relative path", () => {
    const taintedLine = `  fetch("https://api.example.com/journal/trades/123");`;
    const tainted = `${source}\n${taintedLine}`;

    // Sanity: the raw tainted line does contain the forbidden substring.
    expect(taintedLine).toMatch(FORBIDDEN_PATTERN);

    const strippedTainted = stripComments(tainted);
    // The line-anchored strip must leave this line untouched (it is real
    // code, not a whole-line `//` comment), so the guard still catches it.
    expect(strippedTainted).toContain(taintedLine);
    expect(strippedTainted).toMatch(FORBIDDEN_PATTERN);
  });

  it("sanity-checks the source was actually read (non-trivial file, references the real render pipeline)", () => {
    expect(source.length).toBeGreaterThan(100);
    expect(source).toMatch(/RenderClient/);
  });

  /**
   * Confirms the precondition the top doc comment relies on: no line in
   * the real route file mixes real code with a trailing `//` comment on
   * the same line (this file's convention is block comments for docs plus
   * standalone `//` lines). If this ever stops being true, the
   * line-anchored `stripComments` above would need to become a real
   * tokenizer instead of a regex - this test exists so that change in the
   * route file surfaces here rather than silently reintroducing the
   * match-anywhere blind spot.
   */
  it("the real route file has no line mixing code with a trailing // comment (line-anchored stripping precondition)", () => {
    const codeWithTrailingComment = source
      .split("\n")
      .filter((line) => /\/\//.test(line) && !/^\s*\/\//.test(line));
    expect(codeWithTrailingComment).toEqual([]);
  });
});
