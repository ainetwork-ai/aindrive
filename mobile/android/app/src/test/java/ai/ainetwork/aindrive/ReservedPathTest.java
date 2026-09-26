package ai.ainetwork.aindrive;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import org.junit.Test;

/** .aindrive/ is refused over RPC in any letter case: some phone storage ignores case (mirrors cli/src/rpc.js isReservedRpcPath). */
public class ReservedPathTest {
    @Test
    public void refusesTheReservedTreeInAnyCase() {
        assertTrue(ReservedPath.isReserved(Arrays.asList(".aindrive", "config.json")));
        assertTrue(ReservedPath.isReserved(Arrays.asList(".AINDRIVE", "config.json")));
        assertTrue(ReservedPath.isReserved(Arrays.asList(".Aindrive")));
    }

    @Test
    public void allowsServerDrivenDirsAndLookalikes() {
        assertFalse(ReservedPath.isReserved(Arrays.asList(".aindrive", "agents", "a.json")));
        assertFalse(ReservedPath.isReserved(Arrays.asList(".aindrive", "Uploads", "u.part")));
        assertFalse(ReservedPath.isReserved(Arrays.asList("docs", ".aindrive", "x")));
        assertFalse(ReservedPath.isReserved(Arrays.asList(".aindrive-notes")));
    }
}
