package ai.ainetwork.aindrive;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.text.Normalizer;
import org.junit.Test;

/** The server names paths in NFC; a folder on the phone may hold the NFD name a Mac wrote (mirrors cli/src/rpc.js matchSpelling). */
public class ChildNameMatchTest {
    private static final String NFC = Normalizer.normalize("제주 앨범.jpg", Normalizer.Form.NFC);
    private static final String NFD = Normalizer.normalize(NFC, Normalizer.Form.NFD);

    @Test
    public void findsTheNfdChildFromItsNfcName() {
        ChildNameMatch m = new ChildNameMatch(NFC);
        assertFalse(m.offer("id-other", "other.jpg"));
        assertFalse(m.offer("id-nfd", NFD));
        assertEquals("id-nfd", m.result());
    }

    @Test
    public void anExactNameWinsAndStopsTheScan() {
        ChildNameMatch m = new ChildNameMatch(NFC);
        assertFalse(m.offer("id-nfd", NFD));
        assertTrue(m.offer("id-nfc", NFC));
        assertEquals("id-nfc", m.result());
    }

    @Test
    public void noChildOfEitherSpellingIsNull() {
        ChildNameMatch m = new ChildNameMatch(NFC);
        m.offer("id-other", "other.jpg");
        assertNull(m.result());
    }
}
