package ai.ainetwork.aindrive.index;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import org.junit.Test;

/**
 * The root prefix filter's SQL. SQLite isn't on the JVM here, so this pins the clause's shape:
 * an exact, case-sensitive prefix (never LIKE, which ignores ASCII case in SQLite), bound
 * arguments only, and no clause at all for the whole drive.
 */
public class FileIndexUnderTest {
    @Test
    public void onePrefixPerSpellingWithBoundArguments() {
        StringBuilder where = new StringBuilder();
        List<String> args = new ArrayList<>();
        FileIndex.appendUnder(where, args, Arrays.asList("Camera/2026", "Camera/2026"));
        assertEquals("(path = ? OR substr(path, 1, length(?)) = ? OR path = ? OR substr(path, 1, length(?)) = ?)", where.toString());
        assertEquals(Arrays.asList("Camera/2026", "Camera/2026/", "Camera/2026/", "Camera/2026", "Camera/2026/", "Camera/2026/"), args);
        assertFalse(where.toString().toUpperCase().contains("LIKE"));
    }

    @Test
    public void quotesAndWildcardsStayData() {
        StringBuilder where = new StringBuilder();
        List<String> args = new ArrayList<>();
        FileIndex.appendUnder(where, args, Collections.singletonList("it's_100%"));
        assertFalse(where.toString().contains("it's"));
        assertTrue(args.contains("it's_100%/"));
    }

    @Test
    public void theWholeDriveAddsNoClause() {
        StringBuilder where = new StringBuilder();
        List<String> args = new ArrayList<>();
        FileIndex.appendUnder(where, args, Collections.emptyList());
        FileIndex.appendUnder(where, args, Collections.singletonList(""));
        assertEquals("", where.toString());
        assertTrue(args.isEmpty());
    }
}
