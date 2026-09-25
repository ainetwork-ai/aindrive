package ai.ainetwork.aindrive.index;

import androidx.annotation.Nullable;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * Offline gazetteer: GPS → nearest city/country, and place NAME → city/country
 * for the query parser. Backed by the bundled GeoNames cities15000 table
 * (assets/geo/cities.tsv.gz, ~34k rows, sorted by population desc) so "France"
 * and "파리" resolve with no network at all.
 *
 * Country names are not bundled: java.util.Locale already knows every ISO
 * country's name in English and Korean.
 */
public final class GeoLookup {
    public static final class City {
        public final String name, country;
        public final double lat, lon;
        public final int pop;
        public final @Nullable String ko;
        City(String name, String country, double lat, double lon, int pop, @Nullable String ko) {
            this.name = name; this.country = country; this.lat = lat; this.lon = lon; this.pop = pop; this.ko = ko;
        }
    }

    public static final class Place {
        public final @Nullable String country;   // ISO-3166 alpha-2
        public final @Nullable String city;      // GeoNames name (Paris)
        public Place(@Nullable String country, @Nullable String city) { this.country = country; this.city = city; }
    }

    /** Only cities at least this big are matchable by name — keeps "Nice" from matching a hamlet. */
    private static final int NAME_MATCH_MIN_POP = 50_000;
    /** Longest first, so 특별자치시 is not cut as 시. */
    private static final String[] KO_ADMIN_SUFFIXES = {"특별자치시", "특별자치도", "특별시", "광역시", " 시", "시", "군"};

    private final List<City> cities = new ArrayList<>();
    /** 1°×1° cells → indices into `cities`. */
    private final Map<Integer, List<Integer>> grid = new HashMap<>();
    /** lowercase English / Korean city name → biggest city with that name. */
    private final Map<String, City> byName = new HashMap<>();
    /** lowercase English / Korean country name (and aliases) → ISO code. */
    private final Map<String, String> countryByName = new HashMap<>();
    private final Map<String, String> countryEnByIso = new HashMap<>();
    private final Map<String, String> countryKoByIso = new HashMap<>();

    public static GeoLookup loadGzip(InputStream gz) throws IOException {
        return load(new GZIPInputStream(gz));
    }

    public static GeoLookup load(InputStream plain) throws IOException {
        GeoLookup g = new GeoLookup();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(plain, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.isEmpty() || line.charAt(0) == '#') continue;
                String[] c = line.split("\t", -1);
                if (c.length < 5) continue;
                City city = new City(c[0], c[1], Double.parseDouble(c[2]), Double.parseDouble(c[3]),
                        parseIntSafe(c[4]), c.length > 5 && !c[5].isEmpty() ? c[5] : null);
                int idx = g.cities.size();
                g.cities.add(city);
                g.grid.computeIfAbsent(cell(city.lat, city.lon), k -> new ArrayList<>()).add(idx);
                if (city.pop >= NAME_MATCH_MIN_POP) {
                    // rows are population-desc, so the first writer wins = the biggest city.
                    String en = city.name.toLowerCase(Locale.ROOT);
                    g.byName.putIfAbsent(en, city);
                    // "New York City" / "Jeju City" are asked for as "New York" / "Jeju";
                    // country names are checked first, so "Mexico" still means the country.
                    if (en.endsWith(" city")) g.byName.putIfAbsent(en.substring(0, en.length() - 5), city);
                    if (city.ko != null) {
                        g.byName.putIfAbsent(city.ko, city);
                        // Official Korean names carry an administrative suffix nobody says
                        // in a question: 서울특별시 → 서울, 부산광역시 → 부산, 제주시 → 제주, 뉴욕 시 → 뉴욕.
                        for (String suffix : KO_ADMIN_SUFFIXES) {
                            if (city.ko.length() > suffix.length() + 1 && city.ko.endsWith(suffix)) {
                                g.byName.putIfAbsent(city.ko.substring(0, city.ko.length() - suffix.length()).trim(), city);
                                break;
                            }
                        }
                    }
                }
            }
        }
        g.loadCountries();
        return g;
    }

    private void loadCountries() {
        for (String iso : Locale.getISOCountries()) {
            Locale l = new Locale("", iso);
            String en = l.getDisplayCountry(Locale.ENGLISH);
            String ko = l.getDisplayCountry(Locale.KOREAN);
            countryEnByIso.put(iso, en);
            countryKoByIso.put(iso, ko);
            countryByName.put(en.toLowerCase(Locale.ROOT), iso);
            if (!ko.isEmpty()) countryByName.put(ko, iso);
        }
        // Everyday names Locale does not produce.
        String[][] aliases = {
                {"usa", "US"}, {"u.s.", "US"}, {"america", "US"}, {"미국", "US"},
                {"uk", "GB"}, {"england", "GB"}, {"britain", "GB"}, {"영국", "GB"},
                {"korea", "KR"}, {"한국", "KR"}, {"대한민국", "KR"}, {"south korea", "KR"},
                {"불란서", "FR"}, {"홀랜드", "NL"}, {"holland", "NL"}, {"네덜란드", "NL"},
                {"czechia", "CZ"}, {"체코", "CZ"}, {"러시아", "RU"}, {"vietnam", "VN"}, {"베트남", "VN"},
                {"taiwan", "TW"}, {"대만", "TW"}, {"uae", "AE"}, {"dubai", "AE"},
                {"turkey", "TR"}, {"터키", "TR"}, {"튀르키예", "TR"}, {"czech republic", "CZ"}, {"the netherlands", "NL"},
        };
        for (String[] a : aliases) countryByName.put(a[0], a[1]);
    }

    // ------------------------------------------------------------ GPS → place

    /**
     * The city a photo "was taken in": within ~100 km, the candidate with the
     * lowest distance / sqrt(population). A photo at the Eiffel Tower is 3 km
     * from Boulogne-Billancourt (120k) and 4 km from Paris (2.1M) — the user
     * calls that Paris, and so must the index, or "파리" never matches.
     * Null when nothing is within range (open sea, Antarctica…).
     */
    public @Nullable City nearest(double lat, double lon) {
        City best = null;
        double bestScore = Double.MAX_VALUE;
        int la = (int) Math.floor(lat), lo = (int) Math.floor(lon);
        for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
                List<Integer> bucket = grid.get(cellOf(la + dy, wrapLon(lo + dx)));
                if (bucket == null) continue;
                for (int i : bucket) {
                    City c = cities.get(i);
                    double km = haversineKm(lat, lon, c.lat, c.lon);
                    if (km > 100) continue;
                    double score = km / Math.sqrt(Math.max(c.pop, 1000));
                    if (score < bestScore) { bestScore = score; best = c; }
                }
            }
        }
        return best;
    }

    // ------------------------------------------------------------ name → place

    /** Exact (case-insensitive) match on a city or country name; null if unknown. */
    public @Nullable Place byPlaceName(String raw) {
        String k = raw.trim().toLowerCase(Locale.ROOT);
        if (k.isEmpty()) return null;
        String iso = countryByName.get(k);
        if (iso != null) return new Place(iso, null);
        City c = byName.get(k);
        if (c != null) return new Place(c.country, c.name);
        return null;
    }

    public String countryName(String iso, boolean korean) {
        String n = (korean ? countryKoByIso : countryEnByIso).get(iso);
        return n == null || n.isEmpty() ? iso : n;
    }

    public @Nullable String cityKo(String cityName) {
        City c = byName.get(cityName.toLowerCase(Locale.ROOT));
        return c == null ? null : c.ko;
    }

    // ------------------------------------------------------------ helpers

    private static int cell(double lat, double lon) {
        return cellOf((int) Math.floor(lat), (int) Math.floor(lon));
    }

    private static int cellOf(int latCell, int lonCell) { return (latCell + 90) * 360 + (lonCell + 180); }

    private static int wrapLon(int lonCell) {
        if (lonCell < -180) return lonCell + 360;
        if (lonCell >= 180) return lonCell - 360;
        return lonCell;
    }

    static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371, dLat = Math.toRadians(lat2 - lat1), dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * r * Math.asin(Math.sqrt(a));
    }

    private static int parseIntSafe(String s) {
        try { return Integer.parseInt(s); } catch (NumberFormatException e) { return 0; }
    }
}
