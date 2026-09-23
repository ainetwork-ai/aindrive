package ai.ainetwork.aindrive.index;

import androidx.annotation.Nullable;
import androidx.exifinterface.media.ExifInterface;

import java.io.IOException;
import java.io.InputStream;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;

/** When and where a photo was taken, read from its EXIF header only (no decode). */
public final class ExifMeta {
    public @Nullable Long takenAtMs;
    public @Nullable Double lat, lon;

    public static ExifMeta read(InputStream in) throws IOException {
        ExifInterface exif = new ExifInterface(in);
        ExifMeta m = new ExifMeta();
        double[] ll = exif.getLatLong();
        if (ll != null && !(ll[0] == 0 && ll[1] == 0)) { m.lat = ll[0]; m.lon = ll[1]; }
        m.takenAtMs = parseDate(
                exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL),
                exif.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL));
        if (m.takenAtMs == null) {
            m.takenAtMs = parseDate(exif.getAttribute(ExifInterface.TAG_DATETIME),
                    exif.getAttribute(ExifInterface.TAG_OFFSET_TIME));
        }
        return m;
    }

    /**
     * EXIF dates are local wall-clock time with no zone unless OffsetTime* is
     * present. Without it we assume the phone's zone — for "photos from May"
     * a few hours of skew does not matter, and it is what every gallery does.
     */
    static @Nullable Long parseDate(@Nullable String dt, @Nullable String offset) {
        if (dt == null || dt.startsWith("0000")) return null;
        SimpleDateFormat f = new SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US);
        f.setTimeZone(offset != null ? TimeZone.getTimeZone("GMT" + offset) : TimeZone.getDefault());
        try { return f.parse(dt.trim()).getTime(); }
        catch (ParseException e) { return null; }
    }
}
