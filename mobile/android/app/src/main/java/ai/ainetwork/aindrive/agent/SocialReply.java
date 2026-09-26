package ai.ainetwork.aindrive.agent;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * A friendly answer to chit-chat when the on-device LLM isn't loaded ("I love
 * hiking", "do you have pets?"). Warm, short, honest about being an app, and
 * pointing at what it can actually do. Variants rotate by the text so the same
 * shape of turn doesn't always get the same words.
 */
final class SocialReply {
    private SocialReply() { }

    private static final Pattern QUESTION_TO_ME = Pattern.compile("\\b(you|your|yourself|u)\\b.*\\?|^(do|did|are|have|would|what's|what is|how) (you|your)\\b|너|당신", Pattern.CASE_INSENSITIVE);
    private static final Pattern FEELING_BAD = Pattern.compile("\\b(sad|tired|sick|stressed|lonely|bored|worried|upset|hurt|miss|lost|died|passed away)\\b|힘들|슬퍼|우울|피곤|아파", Pattern.CASE_INSENSITIVE);
    private static final Pattern FEELING_GOOD = Pattern.compile("\\b(love|like|enjoy|excited|happy|great|awesome|fun|favorite|favourite|amazing|cool|nice|proud)\\b|좋아|사랑|신나|재밌|행복", Pattern.CASE_INSENSITIVE);

    private static final String[] ASKED_EN = {
            "I'm just an app living on your phone, so not really — but I'd love to hear about yours!",
            "Ha, I'm a phone assistant, so I don't have one of my own. What about you?",
            "Not me — I spend my days sorting photos and recordings. Tell me more about you!",
    };
    private static final String[] ASKED_KO = {"저는 폰 속 앱이라 그런 건 없어요. 당신 얘기를 더 듣고 싶어요!", "저는 사진이랑 녹음 정리하는 게 일이라서요. 당신은요?"};
    private static final String[] GOOD_EN = {"That sounds wonderful!", "I love that!", "That's great to hear!", "How fun!"};
    private static final String[] GOOD_KO = {"멋지네요!", "좋네요!", "듣기만 해도 즐거워요!"};
    private static final String[] BAD_EN = {"I'm sorry to hear that.", "That sounds hard — I hope things get better soon."};
    private static final String[] BAD_KO = {"그랬군요, 힘내요.", "마음이 쓰이네요. 곧 나아지길 바라요."};
    private static final String[] PLAIN_EN = {"I see!", "Interesting!", "Got it — thanks for sharing.", "Oh, nice."};
    private static final String[] PLAIN_KO = {"그렇군요!", "흥미롭네요!", "알려줘서 고마워요."};

    static String reply(String t, boolean ko, boolean mentionsFiles) {
        int h = Math.abs(t.toLowerCase(Locale.ROOT).hashCode());
        String first;
        if (QUESTION_TO_ME.matcher(t).find()) first = pick(ko ? ASKED_KO : ASKED_EN, h);
        else if (FEELING_BAD.matcher(t).find()) first = pick(ko ? BAD_KO : BAD_EN, h);
        else if (FEELING_GOOD.matcher(t).find()) first = pick(ko ? GOOD_KO : GOOD_EN, h);
        else first = pick(ko ? PLAIN_KO : PLAIN_EN, h);
        String hint = mentionsFiles
                ? (ko ? " 폰에 있는 사진이나 영상을 찾아 드릴까요? “작년 여름 사진”처럼 말해 주세요." : " Want me to find some on your phone? Try “my photos from last summer”.")
                : (h % 3 == 0 ? (ko ? " 사진이나 녹음을 찾을 일이 있으면 불러 주세요." : " If you ever need a photo or recording found, just ask.") : "");
        return first + hint;
    }

    private static String pick(String[] a, int h) { return a[h % a.length]; }
}
