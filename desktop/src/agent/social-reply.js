// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/agent/SocialReply.java
/**
 * A friendly answer to chit-chat when no LLM writes one ("I love hiking", "do
 * you have pets?"). Warm, short, honest about being an app, and pointing at
 * what it can do. Variants rotate by the text's (Java) hash, so the Mac picks
 * the same words as the phone for the same turn.
 */
import { javaHash, jre } from "./java-regex.js";

const QUESTION_TO_ME = jre("\\b(you|your|yourself|u)\\b.*\\?|^(do|did|are|have|would|what's|what is|how) (you|your)\\b|너|당신", { ci: true });
const FEELING_BAD = jre("\\b(sad|tired|sick|stressed|lonely|bored|worried|upset|hurt|miss|lost|died|passed away)\\b|힘들|슬퍼|우울|피곤|아파", { ci: true });
const FEELING_GOOD = jre("\\b(love|like|enjoy|excited|happy|great|awesome|fun|favorite|favourite|amazing|cool|nice|proud)\\b|좋아|사랑|신나|재밌|행복", { ci: true });

const ASKED_EN = [
  "I'm just an app living on your phone, so not really — but I'd love to hear about yours!",
  "Ha, I'm a phone assistant, so I don't have one of my own. What about you?",
  "Not me — I spend my days sorting photos and recordings. Tell me more about you!",
];
const ASKED_KO = ["저는 폰 속 앱이라 그런 건 없어요. 당신 얘기를 더 듣고 싶어요!", "저는 사진이랑 녹음 정리하는 게 일이라서요. 당신은요?"];
const GOOD_EN = ["That sounds wonderful!", "I love that!", "That's great to hear!", "How fun!"];
const GOOD_KO = ["멋지네요!", "좋네요!", "듣기만 해도 즐거워요!"];
const BAD_EN = ["I'm sorry to hear that.", "That sounds hard — I hope things get better soon."];
const BAD_KO = ["그랬군요, 힘내요.", "마음이 쓰이네요. 곧 나아지길 바라요."];
const PLAIN_EN = ["I see!", "Interesting!", "Got it — thanks for sharing.", "Oh, nice."];
const PLAIN_KO = ["그렇군요!", "흥미롭네요!", "알려줘서 고마워요."];

/**
 * Math.abs(hashCode) as Java computes it. Java's abs(Integer.MIN_VALUE) stays
 * negative and the array index then throws; here it is clamped to a valid pick instead.
 */
const hashOf = (t) => { const h = javaHash(t.toLowerCase()); return h === -2147483648 ? 2147483647 : Math.abs(h); };
const pick = (a, h) => a[h % a.length];

/** @param {string} t the turn  @param {boolean} ko answer in Korean  @param {boolean} mentionsFiles it named a file kind */
export function socialReply(t, ko, mentionsFiles) {
  const h = hashOf(t);
  let first;
  if (QUESTION_TO_ME.test(t)) first = pick(ko ? ASKED_KO : ASKED_EN, h);
  else if (FEELING_BAD.test(t)) first = pick(ko ? BAD_KO : BAD_EN, h);
  else if (FEELING_GOOD.test(t)) first = pick(ko ? GOOD_KO : GOOD_EN, h);
  else first = pick(ko ? PLAIN_KO : PLAIN_EN, h);
  const hint = mentionsFiles
    ? (ko ? " 폰에 있는 사진이나 영상을 찾아 드릴까요? “작년 여름 사진”처럼 말해 주세요." : " Want me to find some on your phone? Try “my photos from last summer”.")
    : (h % 3 === 0 ? (ko ? " 사진이나 녹음을 찾을 일이 있으면 불러 주세요." : " If you ever need a photo or recording found, just ask.") : "");
  return first + hint;
}
