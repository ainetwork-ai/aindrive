package ai.ainetwork.aindrive.index;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import org.junit.Test;

import java.io.InputStream;

/** A GPS-tagged JPEG (Eiffel Tower, 2024-05-12) must yield its date and position. */
public class ExifMetaTest {
    @Test
    public void readsDateAndGps() throws Exception {
        try (InputStream in = getClass().getResourceAsStream("/paris_eiffel.jpg")) {
            assertNotNull(in);
            ExifMeta m = ExifMeta.read(in);
            assertNotNull("takenAt", m.takenAtMs);
            assertNotNull("lat", m.lat);
            assertEquals(48.8584, m.lat, 0.001);
            assertEquals(2.2945, m.lon, 0.001);
        }
    }
}
