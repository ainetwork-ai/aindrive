package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class SmallTalkTest {
    @Test public void greetingsAreNotSearches() {
        for (String q : new String[]{"hi", "Hi!", "hello", "hey", "thanks", "thank you", "help", "what can you do?", "안녕", "안녕하세요", "ㅎㅇ", "고마워", "감사합니다", "도움말"}) {
            assertNotNull(q, AskRunner.smallTalk(q));
        }
    }

    @Test public void realQuestionsAreSearches() {
        for (String q : new String[]{"hi-res photos", "photos from Paris", "안녕 파일", "help.pdf", "thanks letter", "dog photos"}) {
            assertNull(q, AskRunner.smallTalk(q));
        }
    }
}
