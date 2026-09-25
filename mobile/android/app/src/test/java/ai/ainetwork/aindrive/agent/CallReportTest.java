package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

public class CallReportTest {
    @Test public void recognisesSamsungRecordingNames() {
        assertEquals("지구", CallReport.personOf("통화 녹음 지구_220108_173242.m4a"));
        assertEquals("이지애", CallReport.personOf("통화 녹음 #이지애_220108_173242.m4a"));
        assertEquals("Amy Jang", CallReport.personOf("Call recording Amy Jang_210421_181302.m4a"));
        assertEquals("010-4135-4162", CallReport.personOf("Call recording 010-4135-4162_210423_140509.m4a"));
        assertEquals("이정인 책임연구원님 LG사이언스파크", CallReport.personOf("통화 녹음 이정인 책임연구원님 LG사이언스파크_230101_120000.m4a"));
        assertEquals("엄유준", CallReport.personOf("통화 #엄유준_260805_085943.m4a"));
        assertEquals("양성욱", CallReport.personOf("통화 양성욱_260925_081724.m4a"));
        assertEquals("+16502071596", CallReport.personOf("통화 녹음 +16502071596_220228_140036.m4a"));
        assertNull(CallReport.personOf("meeting-2026-09-01.m4a"));
        java.util.Calendar c = java.util.Calendar.getInstance(); c.setTimeInMillis(CallReport.dateOf("통화 #엄유준_260805_085943.m4a"));
        assertEquals(2026, c.get(java.util.Calendar.YEAR)); assertEquals(7, c.get(java.util.Calendar.MONTH)); assertEquals(5, c.get(java.util.Calendar.DAY_OF_MONTH));
        assertNull(CallReport.dateOf("IMG_1234.jpg"));
        assertTrue(CallReport.isContact("엄유준")); assertTrue(CallReport.isContact("Amy Jang")); assertTrue(CallReport.isContact("KT 클라우드 마케팅 조현수님"));
        assertFalse(CallReport.isContact("01074441320")); assertFalse(CallReport.isContact("+16502071596")); assertFalse(CallReport.isContact("010-4135-4162"));
        assertNull(CallReport.personOf("IMG_1234.jpg"));
    }

    @Test public void warmWordsAreRealWarmth() {
        java.util.regex.Pattern w = CallReport.warmPattern();
        for (String t : new String[]{"보고 싶어", "고마워 진짜", "사랑해", "여보 어디야", "잘 자.", "love you too", "힘내!"}) assertTrue(t, w.matcher(t).find());
        for (String t : new String[]{"여보세요", "제가 여쭤보고 싶은 거는", "이거 보고 싶고 가치가", "너 되고마워 해야", "감사합니다", "Thank you for calling"}) assertFalse(t, w.matcher(t).find());
    }

    @Test public void likesQuestionIsACallsTask() {
        for (String q : new String[]{"who likes me the most and proof?", "who loves me?", "Who cares about me the most", "누가 나를 제일 좋아해?", "나를 가장 좋아하는 사람은?", "날 제일 아끼는 사람"}) {
            assertTrue(q, QueryParser.isLikesTask(q));
            assertTrue(q, QueryParser.isCallsTask(q));
        }
        assertFalse(QueryParser.isLikesTask("photos I like"));
    }

    @Test public void callsTaskIsDetectedInBothLanguages() {
        for (String q : new String[]{
                "내 통화내역을 많이 통화한 사람 순으로 정렬하고 보통 어떤 얘기를 나누는지 요약해줘",
                "통화 기록 정리해줘", "누구랑 제일 많이 통화했어",
                "Sort my call history by who I talk to most and summarize what we usually talk about",
                "who do I call the most?", "summarise my calls", "call log by person"}) {
            assertTrue(q, QueryParser.isCallsTask(q));
        }
        for (String q : new String[]{"photos from Paris", "회의 녹음 찾아줘", "collect this month's food photos into a folder and share it"}) {
            assertFalse(q, QueryParser.isCallsTask(q));
        }
    }

    @Test public void topicsAreWhatOnePersonSaysAndOthersDoNot() {
        CallReport.Person a = new CallReport.Person(); a.name = "A";
        a.transcripts.add("투자 얘기 좀 하자. 이번 라운드 투자 조건이 어떻게 되는지. 투자자 미팅은 다음주에 하고요. 계약서는 검토했어요.");
        a.transcripts.add("투자 계약서 초안 보냈어요. 밸류에이션은 나중에 다시 얘기해요.");
        CallReport.Person b = new CallReport.Person(); b.name = "B";
        b.transcripts.add("주말에 등산 갈래? 북한산 코스가 좋더라. 등산화는 챙겼고 도시락도 준비할게. 등산 끝나고 막걸리 한잔 하자.");
        CallReport.topics(Arrays.asList(a, b));
        assertTrue(a.topics.toString(), a.topics.contains("투자"));
        assertTrue(b.topics.toString(), b.topics.contains("등산"));
        assertFalse(a.topics.contains("등산"));
        assertFalse(a.gist.isEmpty());
        assertTrue(a.gist, a.gist.contains("투자"));
    }

    @Test public void wordsStripParticlesAndFillers() {
        List<String> w = CallReport.words("그냥 투자자는 계약서를 검토했어요 근데 the budget");
        assertEquals(Arrays.asList("투자자", "계약서", "budget"), w);
    }
}
