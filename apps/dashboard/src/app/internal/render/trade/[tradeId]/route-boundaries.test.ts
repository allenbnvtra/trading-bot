import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static-analysis proof for the POST_TRADE render route, modeled directly
 * on `../../setup/route-boundaries.test.ts`'s PRE_TRADE guard (same
 * comment-stripping approach, same style of assertions) but guarding
 * against a different regression: this route's anti-look-ahead property
 * isn't "never reach journal/trade data" (it's explicitly about the
 * trade's actual outcome - that's the whole point of a POST_TRADE
 * screenshot), it's "never let the candle cutoff be anything other than
 * the trade's own `exitTimestamp`".
 *
 * The two things this guards, both at the source level so a future edit
 * can't quietly reintroduce them without this test noticing:
 *  - The route's source must never contain a `new Date(` call anywhere. A
 *    wall-clock timestamp is exactly the failure mode the whole
 *    getCandlesUpToTimestamp cutoff design exists to prevent (see
 *    page.tsx's own doc comment on the `candles = await
 *    getCandlesUpToTimestamp(...)` call) - if it ever appears in this file
 *    again, in any form, that is inherently suspicious enough to fail the
 *    build regardless of where it appears or what it's used for.
 *  - The route's source must still reference `exitTimestamp` as the value
 *    it passes for the cutoff - a sanity check that the correct source is
 *    actually still wired up, not just that the wrong one is absent.
 *
 * The component-level test in this same directory (page.test.tsx) proves
 * the *running* route actually calls getCandlesUpToTimestamp with the real
 * mocked trade's exitTimestamp value - this file only proves properties of
 * the source text, which is what a `new Date(`-shaped regression needs
 * (nothing about a running-code assertion would necessarily catch a
 * *dead* `new Date()` reference introduced nearby, or vice versa; the two
 * tests check different things and both matter).
 *
 * Comment stripping and its line-anchored rationale are copied verbatim in
 * spirit from the PRE_TRADE route-boundaries.test.ts - see that file's top
 * doc comment for the full explanation of why a match-anywhere strip would
 * be unsound (it would truncate a real violation like
 * `fetch("https://api.example.com/...")` at the `//` inside `https://`).
 * The precondition test at the bottom of this file confirms that blind
 * spot does not apply to this route file's actual comment style.
 */
describe("POST_TRADE render route cutoff-source boundary", () => {
  const pageSourcePath = join(import.meta.dirname, "page.tsx");
  const source = readFileSync(pageSourcePath, "utf-8");

  const WALL_CLOCK_PATTERN = /new Date\(/;
  const EXIT_TIMESTAMP_PATTERN = /exitTimestamp/;

  /**
   * Strips `/* block *\/` comments and whole-line `//` comments (a line
   * that is only whitespace followed by `//`), same as the PRE_TRADE
   * route's guard - see that file's top doc comment for the full
   * unsoundness argument against a match-anywhere strip.
   */
  function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  const codeOnly = stripComments(source);

  it("the route's doc comments genuinely discuss exitTimestamp in prose (sanity check that the pattern is meaningful)", () => {
    expect(source).toMatch(EXIT_TIMESTAMP_PATTERN);
  });

  it("never contains a `new Date(` wall-clock call anywhere, once comments are stripped", () => {
    expect(codeOnly).not.toMatch(WALL_CLOCK_PATTERN);
  });

  it("still references exitTimestamp as the cutoff source, once comments are stripped", () => {
    expect(codeOnly).toMatch(EXIT_TIMESTAMP_PATTERN);
  });

  /**
   * A meaningfulness check on the wall-clock guard itself: prove it
   * actually fails against code it's supposed to catch, so an over-narrow
   * pattern above can't pass merely because it never gets exercised
   * against a positive case. This never touches the real route file.
   */
  it("the guard genuinely flags a `new Date(` reference if one is added to the real code", () => {
    const tainted = stripComments(`${source}\nconst cutoff = new Date();`);
    expect(tainted).toMatch(WALL_CLOCK_PATTERN);
  });

  it("the guard is not fooled by a `new Date(` reference hidden inside a comment", () => {
    const stillClean = stripComments(`// do not use new Date() here\n${source}`);
    expect(stillClean).not.toMatch(WALL_CLOCK_PATTERN);
  });

  it("the guard catches a `new Date(` call even when it appears mid-expression, not just as a standalone statement", () => {
    const taintedLine = `  const candles = await getCandlesUpToTimestamp(id, tf, new Date().toISOString(), 150);`;
    const tainted = `${source}\n${taintedLine}`;

    expect(taintedLine).toMatch(WALL_CLOCK_PATTERN);

    const strippedTainted = stripComments(tainted);
    expect(strippedTainted).toContain(taintedLine);
    expect(strippedTainted).toMatch(WALL_CLOCK_PATTERN);
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
