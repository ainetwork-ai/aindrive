package ai.ainetwork.aindrive;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.IOException;
import java.util.Arrays;
import org.junit.Test;

/** Path parsing guards shared by every SafFs operation (mirrors cli/src/rpc.js). */
public class SafFsPathTest {
    @Test
    public void refusesReservedAindrivePaths() {
        for (String p : new String[] {".aindrive", ".aindrive/config.json", "/.aindrive//config.json", "./.aindrive/yjs/x.bin"}) {
            IOException e = assertThrows(p, IOException.class, () -> SafFs.splitPath(p));
            assertEquals("reserved path", e.getMessage());
        }
    }

    @Test
    public void allowsServerDrivenSystemDirsAndLookalikes() throws IOException {
        assertEquals(Arrays.asList(".aindrive", "agents", "a.json"), SafFs.splitPath(".aindrive/agents/a.json"));
        assertEquals(Arrays.asList(".aindrive", "uploads", "u.part"), SafFs.splitPath(".aindrive/uploads/u.part"));
        assertEquals(Arrays.asList("docs", ".aindrive", "x"), SafFs.splitPath("docs/.aindrive/x"));
        assertEquals(Arrays.asList(".aindrive-notes"), SafFs.splitPath(".aindrive-notes"));
    }

    @Test
    public void stillRefusesTraversal() {
        assertThrows(IOException.class, () -> SafFs.splitPath("a/../../etc"));
    }
}
