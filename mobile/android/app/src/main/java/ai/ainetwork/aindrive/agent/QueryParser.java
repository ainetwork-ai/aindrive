package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import ai.ainetwork.aindrive.index.GeoLookup;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Rule-based question → {@link SearchQuery}. This is the P1 stand-in for the
 * LLM planner: it understands places (via the gazetteer), dates (absolute and
 * relative, Korean and English) and leaves the rest as content words.
 *
 * Korean particles are stripped from the END of tokens ("파리에서" → "파리")
 * and the longest place name wins, so "New York" beats "York".
 */
public final class QueryParser {
    private static final String[] KO_PARTICLES = {
            "에서의", "에서는", "에서", "으로", "로", "까지", "부터", "에는", "에", "의", "은", "는", "이", "가", "을", "를", "과", "와", "도", "랑", "이랑", "하고",
    };
    private static final Set<String> STOP = new HashSet<>(Arrays.asList(
            // Korean
            "사진", "사진들", "이미지", "찍은", "찍었던", "찍힌", "촬영한", "갔던", "갔을때", "갔을", "여행", "여행갔던", "때",
            "찾아줘", "찾아", "찾아봐", "보여줘", "보여", "줘", "좀", "다", "모두", "전부", "있어", "있나", "있니", "뭐", "어디",
            "내", "나의", "우리", "그", "저", "것", "거", "들", "중", "중에", "중에서", "관련", "관련된",
            // English
            "photo", "photos", "picture", "pictures", "pic", "pics", "image", "images", "shot", "shots",
            "find", "show", "me", "the", "a", "an", "of", "from", "in", "at", "on", "my", "our", "all", "any", "some",
            "taken", "took", "trip", "travel", "travelled", "traveled", "vacation", "holiday", "please", "that", "i", "we", "were", "was"
    ));
    private static final Pattern YEAR = Pattern.compile("^(19|20)\\d{2}$");
    private static final Pattern YEAR_MONTH = Pattern.compile("^((?:19|20)\\d{2})[-./]?(0?[1-9]|1[0-2])$");
    private static final Pattern KO_YEAR = Pattern.compile("^((?:19|20)\\d{2})년$");
    private static final Pattern KO_MONTH = Pattern.compile("^(0?[1-9]|1[0-2])월$");
    private static final String[] EN_MONTHS = {"january", "february", "march", "april", "may", "june", "july",
            "august", "september", "october", "november", "december"};

    private final GeoLookup geo;

    public QueryParser(GeoLookup geo) { this.geo = geo; }

    public SearchQuery parse(String question, long nowMs) {
        SearchQuery q = new SearchQuery();
        q.korean = question.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3);
        List<String> tokens = tokenize(question);
        Calendar now = Calendar.getInstance(TimeZone.getDefault());
        now.setTimeInMillis(nowMs);
        int year = now.get(Calendar.YEAR);

        Integer y = null, m = null;          // absolute year / month
        String season = null;
        List<String> leftovers = new ArrayList<>();
        boolean[] used = new boolean[tokens.size()];

        // 1. Places: try 3-, 2-, then 1-token spans so multi-word names win.
        for (int span = 3; span >= 1; span--) {
            for (int i = 0; i + span <= tokens.size(); i++) {
                if (anyUsed(used, i, span)) continue;
                String raw = String.join(" ", tokens.subList(i, i + span));
                GeoLookup.Place p = placeOf(raw);
                if (p == null) continue;
                if (p.city != null && q.city == null) { q.city = p.city; q.country = p.country; }
                else if (p.city == null && q.country == null) q.country = p.country;
                else continue;
                Arrays.fill(used, i, i + span, true);
            }
        }

        // 2. Dates.
        for (int i = 0; i < tokens.size(); i++) {
            if (used[i]) continue;
            String t = stripParticles(tokens.get(i));
            String lower = t.toLowerCase(Locale.ROOT);
            Matcher mm;
            if ((mm = YEAR_MONTH.matcher(t)).matches()) { y = Integer.parseInt(mm.group(1)); m = Integer.parseInt(mm.group(2)); used[i] = true; }
            else if (YEAR.matcher(t).matches()) { y = Integer.parseInt(t); used[i] = true; }
            else if ((mm = KO_YEAR.matcher(t)).matches()) { y = Integer.parseInt(mm.group(1)); used[i] = true; }
            else if ((mm = KO_MONTH.matcher(t)).matches()) { m = Integer.parseInt(mm.group(1)); used[i] = true; }
            else if (lower.equals("작년") || lower.equals("last") && next(tokens, i).equals("year")) { y = year - 1; used[i] = true; if (lower.equals("last")) used[i + 1] = true; }
            else if (lower.equals("재작년")) { y = year - 2; used[i] = true; }
            else if (lower.equals("올해") || lower.equals("this") && next(tokens, i).equals("year")) { y = year; used[i] = true; if (lower.equals("this")) used[i + 1] = true; }
            else if (lower.equals("지난달") || lower.equals("last") && next(tokens, i).equals("month")) {
                Calendar c = (Calendar) now.clone(); c.add(Calendar.MONTH, -1);
                y = c.get(Calendar.YEAR); m = c.get(Calendar.MONTH) + 1; used[i] = true; if (lower.equals("last")) used[i + 1] = true;
            }
            else if (lower.equals("이번달") || lower.equals("this") && next(tokens, i).equals("month")) { y = year; m = now.get(Calendar.MONTH) + 1; used[i] = true; if (lower.equals("this")) used[i + 1] = true; }
            else if (isSeason(lower) != null) { season = isSeason(lower); used[i] = true; }
            else {
                int mi = monthIndex(lower);
                if (mi > 0) { m = mi; used[i] = true; }
            }
        }
        if (season != null && y == null) y = year;      // "여름" alone = this year's summer
        if (m != null && y == null) y = year;            // "5월" alone = this year's May
        if (y != null) applyDate(q, y, m, season);

        // 3. Whatever is left is content.
        for (int i = 0; i < tokens.size(); i++) {
            if (used[i]) continue;
            String t = stripParticles(tokens.get(i));
            if (t.isEmpty() || STOP.contains(t.toLowerCase(Locale.ROOT)) || STOP.contains(tokens.get(i).toLowerCase(Locale.ROOT))) continue;
            leftovers.add(t);
        }
        if (!leftovers.isEmpty()) q.textQuery = String.join(" ", leftovers);
        return q;
    }

    // ------------------------------------------------------------ helpers

    private @Nullable GeoLookup.Place placeOf(String raw) {
        GeoLookup.Place p = geo.byPlaceName(raw);
        if (p != null) return p;
        String stripped = stripParticles(raw);
        return stripped.equals(raw) ? null : geo.byPlaceName(stripped);
    }

    static String stripParticles(String tok) {
        for (String p : KO_PARTICLES) {
            if (tok.length() > p.length() + 1 && tok.endsWith(p)) return tok.substring(0, tok.length() - p.length());
        }
        return tok;
    }

    private static List<String> tokenize(String s) {
        List<String> out = new ArrayList<>();
        for (String t : s.trim().split("[\\s,;!?~()\\[\\]\"']+")) {
            t = t.replaceAll("[.]+$", "");
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    private static boolean anyUsed(boolean[] used, int from, int n) {
        for (int i = from; i < from + n; i++) if (used[i]) return true;
        return false;
    }

    private static String next(List<String> tokens, int i) {
        return i + 1 < tokens.size() ? tokens.get(i + 1).toLowerCase(Locale.ROOT) : "";
    }

    private static @Nullable String isSeason(String t) {
        switch (t) {
            case "봄": case "spring": return "spring";
            case "여름": case "summer": return "summer";
            case "가을": case "autumn": case "fall": return "autumn";
            case "겨울": case "winter": return "winter";
            default: return null;
        }
    }

    private static int monthIndex(String t) {
        // Full name or the usual 3-letter abbreviation ("sep", "sept" is left alone).
        for (int i = 0; i < EN_MONTHS.length; i++) {
            if (t.equals(EN_MONTHS[i]) || t.equals(EN_MONTHS[i].substring(0, 3))) return i + 1;
        }
        return 0;
    }

    private static void applyDate(SearchQuery q, int y, @Nullable Integer m, @Nullable String season) {
        int fromMonth = 1, toMonth = 12, toYear = y;   // inclusive month range
        if (m != null) { fromMonth = m; toMonth = m; }
        else if (season != null) {
            switch (season) {
                case "spring": fromMonth = 3; toMonth = 5; break;
                case "summer": fromMonth = 6; toMonth = 8; break;
                case "autumn": fromMonth = 9; toMonth = 11; break;
                case "winter": fromMonth = 12; toMonth = 2; toYear = y + 1; break;   // Dec y → Feb y+1
            }
        }
        q.dateFrom = startOfMonth(y, fromMonth);
        q.dateTo = toMonth == 12 ? startOfMonth(toYear + 1, 1) : startOfMonth(toYear, toMonth + 1);
    }

    private static long startOfMonth(int y, int m) {
        Calendar c = Calendar.getInstance(TimeZone.getDefault());
        c.clear();
        c.set(y, m - 1, 1, 0, 0, 0);
        return c.getTimeInMillis();
    }
}
