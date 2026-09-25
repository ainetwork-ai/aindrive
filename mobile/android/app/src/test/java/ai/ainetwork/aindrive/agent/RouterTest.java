package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import ai.ainetwork.aindrive.index.GeoLookup;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.zip.GZIPInputStream;

/**
 * Out-of-scope conversations must never reach the file index, and file
 * questions always must.
 *
 * sgd-user-turns.tsv.gz is every USER turn of the Schema-Guided Dialogue
 * corpus (DSTC8, github.com/google-research-datasets/dstc8-schema-guided-dialogue,
 * CC BY-SA 4.0): 22,825 dialogues / 231,642 turns about restaurants, flights,
 * hotels, banks, music, calendars… Each dialogue is replayed turn by turn with
 * its context carried, exactly as the app does.
 */
public class RouterTest {
    static final long NOW = AskScenariosTest.at("2026-09-24");
    static QueryParser parser;

    @BeforeClass
    public static void load() throws Exception {
        File asset = new File("src/main/assets/geo/cities.tsv.gz");
        try (FileInputStream in = new FileInputStream(asset)) { parser = new QueryParser(GeoLookup.loadGzip(in)); }
    }

    @Test
    public void everySchemaGuidedDialogueStaysOutOfTheIndex() throws Exception {
        List<String> failures = new ArrayList<>();
        int dialogues = 0, turns = 0, chat = 0;
        try (InputStream raw = getClass().getResourceAsStream("/sgd-user-turns.tsv.gz");
             BufferedReader r = new BufferedReader(new InputStreamReader(new GZIPInputStream(raw), StandardCharsets.UTF_8))) {
            String line, dialogue = null;
            JSONObject context = null;
            while ((line = r.readLine()) != null) {
                String[] c = line.split("\t", -1);
                if (!c[0].equals(dialogue)) { dialogue = c[0]; context = null; dialogues++; }
                turns++;
                Router.Turn d = Router.understand(parser, c[3], NOW, context);
                context = d.nextContext;
                if (d.route == Router.Route.FILES || d.route == Router.Route.CALLS) failures.add(d.route + "\t" + c[1] + "\t" + c[3]);
                else if (d.route == Router.Route.CHAT) chat++;
            }
        }
        assertEquals(22825, dialogues);
        assertEquals(231642, turns);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(80, failures.size()); i++) sb.append('\n').append(failures.get(i));
        System.out.println("SGD: " + turns + " turns, " + chat + " small talk, " + failures.size() + " reached the index");
        assertTrue(failures.size() + " of " + turns + " out-of-scope turns reached the index:" + sb, failures.isEmpty());
    }

    /**
     * persona-chat-turns.tsv.gz: one speaker's turns from every conversation of Synthetic-Persona-Chat
     * (github.com/google-research-datasets/Synthetic-Persona-Chat, CC BY 4.0) — 21,907 conversations of
     * people getting to know each other. None may reach the index or the call report, and nearly all
     * must get a friendly reply rather than "that's not something I can do".
     */
    @Test
    public void personaChatIsConversationNotSearch() throws Exception {
        List<String> searched = new ArrayList<>(), refused = new ArrayList<>();
        int conversations = 0, turns = 0;
        try (InputStream raw = getClass().getResourceAsStream("/persona-chat-turns.tsv.gz");
             BufferedReader r = new BufferedReader(new InputStreamReader(new GZIPInputStream(raw), StandardCharsets.UTF_8))) {
            String line, conv = null;
            JSONObject context = null;
            while ((line = r.readLine()) != null) {
                String[] c = line.split("\t", -1);
                if (!c[0].equals(conv)) { conv = c[0]; context = null; conversations++; }
                turns++;
                Router.Turn t = Router.understand(parser, c[2], NOW, context);
                context = t.nextContext;
                if (t.route == Router.Route.FILES || t.route == Router.Route.CALLS) searched.add(t.route + "\t" + c[2]);
                else if (t.route == Router.Route.OUT) refused.add(c[2]);
            }
        }
        double social = 1 - (double) (searched.size() + refused.size()) / turns;
        StringBuilder sb = new StringBuilder(String.format(java.util.Locale.US, "persona chat: %d conversations, %d turns, %.4f answered socially, %d searched, %d refused",
                conversations, turns, social, searched.size(), refused.size()));
        for (int i = 0; i < Math.min(40, searched.size()); i++) sb.append("\n  SEARCHED ").append(searched.get(i));
        for (int i = 0; i < Math.min(40, refused.size()); i++) sb.append("\n  REFUSED ").append(refused.get(i));
        System.out.println(sb);
        java.nio.file.Files.write(java.nio.file.Paths.get("build", "persona-report.txt"), sb.toString().getBytes(StandardCharsets.UTF_8));
        assertTrue(sb.toString(), searched.isEmpty() && social >= 0.97);
    }

    @Test
    public void everyFileQuestionReachesTheIndex() throws Exception {
        List<String> questions = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(getClass().getResourceAsStream("/ask-scenarios.tsv"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) if (!line.isEmpty() && !line.startsWith("#")) questions.add(line.split("\t", -1)[1]);
        }
        try (InputStream in = getClass().getResourceAsStream("/task-scenarios.json")) {
            JSONArray s = new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getJSONArray("scenarios");
            for (int i = 0; i < s.length(); i++) questions.add(s.getJSONObject(i).getString("q"));
        }
        questions.addAll(Arrays.asList(
                "Collect all food photos taken this month", "show me photos of cars", "sunset pictures", "photos of my cat",
                "dog photos", "receipts from last month", "food photos from Tokyo", "who likes me the most and proof?",
                "Sort my call history by who I talk to most and summarize what we usually talk about, and share it",
                "Who do I call the most?", "my music", "songs on my phone", "my notes from last week", "large videos",
                "meeting recordings about the budget", "dog", "sunset", "Paris", "last winter in Tokyo", "PDFs",
                "biggest files", "delete the screenshots from last year", "how many photos did I take in Paris?",
                "파리에서 찍은 사진", "이번달 음식 사진 모아서 공유해줘", "예산 얘기한 회의 녹음", "많이 통화한 사람 순으로 정리하고 요약해줘",
                "누가 나를 제일 좋아해?", "지난주 스크린샷 지워줘", "내 노래", "강아지"));
        List<String> failures = new ArrayList<>();
        for (String q : questions) {
            Router.Decision d = Router.route(parser, q, NOW, null, false);
            if (d.route != Router.Route.FILES && d.route != Router.Route.CALLS) failures.add(d.route + "\t" + q);
        }
        assertTrue(failures.size() + " of " + questions.size() + " file questions were turned away:\n" + String.join("\n", failures), failures.isEmpty());
    }

    @Test
    public void followUpsOfAFileQuestionStayFileQuestions() {
        SearchQuery prev = Router.route(parser, "photos from Paris", NOW, null, false).query;
        for (String f : new String[]{"only the ones from 2024", "and share them", "from last summer", "the videos too", "그중 2024년 것만", "put them in a folder"}) {
            assertEquals(f, Router.Route.FILES, Router.route(parser, f, NOW, prev, false).route);
        }
    }
}
