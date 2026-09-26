// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/agent/UnderstandTrigger.java
/**
 * When the rules are unsure — the only time a model is asked (the trigger table in
 * docs/superpowers/specs/2026-09-27-llm-understanding-design.md). A pure function of
 * the rules' Turn (router.js `understand`), so it is tested without a model, and a
 * turn the rules are sure about never waits for one:
 *
 *   CHAT from a pattern, CALLS                          never
 *   CHAT from the social fall-through                    yes when a weak kind / place / date / kind word
 *                                                        was seen, it follows a FILES turn, or it is a
 *                                                        question ("anything from Sam's wedding?") —
 *                                                        the OUT row's twin: no file word, no service word
 *   FILES with ignoredWords ≥ 2                          yes (words the rules threw away)
 *   FILES from the follow-up / task-only / "few" branch  yes when ignoredWords > 0
 *   FILES from a kind word or the search-box branch      no
 *   OUT                                                  yes when a weak kind word, a place/date/kind
 *                                                        word was seen, or it follows a FILES turn
 */

/**
 * @param {import("./router.js").Turn} turn
 * @param {import("./search-query.js").SearchQuery | null} [query] the parsed query (defaults to the turn's)
 * @returns {boolean}
 */
export function unsure(turn, query = turn?.query ?? null) {
  if (turn == null) return false;
  const b = turn.basis ?? {};
  switch (turn.route) {
    case "FILES": {
      const ignored = query?.ignoredWords ?? 0;
      if (ignored >= 2) return true;
      return b.branch === "followUp" && ignored > 0;
    }
    case "OUT":
      return !!(b.weak || b.seen || b.afterFiles);
    case "CHAT":
      return b.branch === "social" && !!(b.weak || b.seen || b.afterFiles || b.question);
    default:
      return false;
  }
}
