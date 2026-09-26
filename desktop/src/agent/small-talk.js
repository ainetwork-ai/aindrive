// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/agent/AskRunner.java (smallTalk / greeting)
/**
 * Greetings, thanks and "what can you do": a short canned reply, never a file
 * search. The replies are the phone's, word for word, so both apps sound alike.
 */
import { javaTrim, jreFull } from "./java-regex.js";

const GREETING = jreFull(
  "(hi+|hello+|hey+|yo|hiya|good (morning|afternoon|evening)|thanks?( you)?|thank u|ty|ok(ay)?|cool|nice|great|help|what can you do\\??|who are you\\??|"
  + "안녕(하세요)?|ㅎㅇ|하이|헬로|반가워(요)?|고마워(요)?|감사(합니다|해요)?|ㄱㅅ|좋아(요)?|오케이|ㅇㅋ|도움말|도와줘|뭐 할 수 있어\\??|뭘 할 수 있어\\??|넌 누구야\\??|누구세요\\??)[.!~ ]*",
  { ci: true });

/** Everyday social turns and a friendly answer to each: [pattern, English, Korean]; null replies = the greeting. */
const SOCIAL = [
  ["(hi|hey|hello)?[, ]*(how are you|how're you|how are you doing|how's it going|how is it going|how have you been|how do you do|what's up|whats up|sup|wassup)( today)?( doing)?",
    "I'm doing well, thanks for asking! How are you? I'm here whenever you want to find or sort something on your phone.",
    "잘 지내요, 물어봐 줘서 고마워요! 당신은요? 폰에서 찾거나 정리할 게 있으면 언제든 말해 주세요."],
  ["(i'?m|i am) (good|great|fine|ok|okay|well|doing well|doing good|not bad|alright)( too| as well)?(,? thanks?( you)?)?( and you)?|not bad|pretty good|all good",
    "Glad to hear it! What can I help you find?", "다행이에요! 뭘 찾아 드릴까요?"],
  ["(i'?m|i am|feeling) (tired|sad|bored|stressed|down|not great|not good)|bad day|rough day",
    "Sorry to hear that. If it helps, I can pull up some happy photos — try “photos from last summer”.",
    "그랬군요, 힘내요. 기분 전환이 필요하면 “작년 여름 사진”처럼 좋은 추억을 찾아 드릴게요."],
  ["(what'?s|what is) your name|who are you|who r u|what are you|are you (a )?(bot|robot|ai|human|real)",
    "I'm the aindrive agent. I run right here on your phone and help you find, collect and share your files.",
    "저는 aindrive 에이전트예요. 이 폰에서 직접 돌아가면서 파일을 찾고 모으고 공유하는 걸 도와드려요."],
  ["nice to meet you|pleased to meet you|good to meet you", "Nice to meet you too! Ask me about your photos, recordings or documents.", "저도 반가워요! 사진, 녹음, 문서에 대해 물어보세요."],
  ["(good|great|nice|awesome|amazing) (job|work)|well done|you'?re (great|awesome|amazing|the best|smart|helpful)|love (it|you)|i like you",
    "Thank you, that's kind! Happy to help anytime.", "고마워요! 언제든 도와드릴게요."],
  ["sorry|my bad|oops|never mind|nevermind|forget it", "No problem at all. What would you like to do next?", "괜찮아요. 다음엔 뭘 해 드릴까요?"],
  ["(lol|haha+|hehe+|lmao)", "😄 Anything I can find for you?", "😄 찾아 드릴 게 있을까요?"],
  ["good ?night|see you( later| tomorrow)?|talk (to you )?later|bye( bye)?|goodbye|take care", "Bye for now — see you soon!", "다음에 또 봐요!"],
  ["what can you do|what do you do|help|how does this work|how do i use (you|this)", null, null],
  ["잘 지내(요|세요|니|셨어요)?|어떻게 지내(요|세요)?|뭐해\\??|뭐 해\\??|기분 어때(요)?", "I'm doing well, thanks for asking! How are you?", "잘 지내요, 물어봐 줘서 고마워요! 당신은요? 찾을 게 있으면 말씀하세요."],
  ["(너|넌|당신은?) (누구|뭐)(야|예요|니|세요)?|이름이 뭐(야|예요)?", "I'm the aindrive agent, running on your phone.", "저는 aindrive 에이전트예요. 이 폰에서 파일을 찾고 정리해 드려요."],
  ["(잘했어|최고야|고마워|수고했어|좋아)(요)?", "Thank you!", "고마워요! 언제든 불러 주세요."],
  ["미안(해|해요)?|죄송(해요|합니다)?", "No problem at all.", "괜찮아요!"],
  ["잘 ?자|잘 ?가|안녕히 (가세요|계세요)|또 (봐|만나)", "Bye for now!", "다음에 또 봐요!"],
].map(([p, en, ko]) => [jreFull("(" + p + ")[\\s.!?~,]*(\\s*(:\\)|😊|🙂|😄))?[\\s.!?~]*", { ci: true }), en, ko]);

const THANKS = jreFull("^(thanks?|thank|ty|고마|감사|ㄱㅅ).*");
/** Hangul syllables or compatibility jamo (ㅎㅇ, ㄱㅅ). */
const koreanish = (t) => /[가-힣ㄱ-ㆎ]/.test(t);

/** A canned reply to small talk, or null when the turn is a real question. */
export function smallTalk(question) {
  const t = javaTrim(question);
  const hangul = koreanish(t);
  for (const [re, en, ko] of SOCIAL) {
    if (!re.test(t)) continue;
    if (en == null) return greeting(hangul);
    return hangul ? ko : en;
  }
  if (!GREETING.test(t)) return null;
  if (THANKS.test(t.toLowerCase())) return hangul ? "천만에요! 더 찾을 게 있으면 말씀하세요." : "You're welcome — ask me anything else about your files.";
  return greeting(hangul);
}

/** The opening line with example questions. */
export function greeting(ko) {
  return ko
    ? "안녕하세요! 이 폰의 파일을 찾고 정리해 드려요. 예를 들면:\n· 도쿄에서 찍은 사진\n· 이번달 음식 사진을 폴더로 모아서 공유해줘\n· 예산 얘기한 회의 녹음\n· 많이 통화한 사람 순으로 정리하고 요약해줘"
    : "Hi! I find and organise the files on this phone. Try:\n· photos taken in Tokyo\n· collect this month's food photos into a folder and share it\n· meeting recordings about the budget\n· sort my call history by who I talk to most and summarize it";
}
