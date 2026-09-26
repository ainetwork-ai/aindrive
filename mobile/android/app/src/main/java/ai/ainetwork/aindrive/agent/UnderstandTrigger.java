package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

/**
 * When the rules are UNSURE — the only time the on-device model is asked to read a turn
 * (docs/superpowers/specs/2026-09-27-llm-understanding-design.md, "the trigger"). A pure
 * function of the rules' result, so it is tested without a model, and the model can never
 * change a turn the rules are sure about:
 *
 * <pre>
 *  rules' decision                                   asked?
 *  CHAT (small talk, greeting, closing patterns)     no
 *  CHAT from the social fall-through                 yes when a weak kind / place / date / kind word
 *                                                    was seen, the turn follows a file search, or it
 *                                                    is a question — the OUT row's twin: the sentence
 *                                                    had no file word and no service word either
 *  CALLS                                             no
 *  FILES, named kind word (+ any filter)             no  — unless ≥2 words were thrown away
 *  FILES, follow-up / task-only / "few" branch       yes when ≥1 word was thrown away
 *  FILES, bare search-box query                      no  (that branch requires nothing thrown away)
 *  OUT                                               yes when a weak kind / place / date / kind word
 *                                                    was seen, or the turn follows a file search
 *  any FILES turn with ignoredWords ≥ 2              yes
 * </pre>
 */
public final class UnderstandTrigger {
    private UnderstandTrigger() { }

    /**
     * @param t the rules' reading of the turn
     * @param q the rules' parse of its text — {@code t.query} for a FILES turn, {@code t.parsed} otherwise
     */
    public static boolean unsure(Router.Turn t, @Nullable SearchQuery q) {
        switch (t.route) {
            case OUT:
                return t.hint || t.afterFiles;
            case CHAT:
                // Pattern matches (greetings, closings, small talk) are strong; the social fall-through is
                // not — "anything from Sam's wedding?" lands there. The model is loaded for a social reply
                // anyway, so reading the question first costs one more generation, not a second load.
                return t.why == Router.Why.SOCIAL && (t.hint || t.afterFiles || t.question);
            case FILES:
                if (q == null) return false;
                if (q.ignoredWords >= 2) return true;          // words the rules threw away
                return t.why == Router.Why.FOLLOW_UP && q.ignoredWords > 0;   // context inherited on thin evidence
            default:
                return false;                                   // CHAT, CALLS: pattern matches, strong
        }
    }
}
