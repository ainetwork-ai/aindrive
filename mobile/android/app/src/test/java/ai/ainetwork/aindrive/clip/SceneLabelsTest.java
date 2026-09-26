package ai.ainetwork.aindrive.clip;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.List;

import org.junit.Test;

public class SceneLabelsTest {
    private static float[] unit(float... v) { return ClipEmbedder.normalize(v); }

    @Test public void photoMatchesWhenTheQueryIsTheLikeliestScene() {
        float[] food = unit(1, 0, 0), sign = unit(0, 1, 0), street = unit(0, 0, 1);
        float[][] labels = {food, sign, street};
        // Low absolute cosines, but "food" is clearly the best explanation of photo 0.
        List<float[]> photos = Arrays.asList(unit(0.19f, 0.05f, 0.02f), unit(0.05f, 0.28f, 0.02f), null);
        float[] p = SceneLabels.match(food, labels, photos);
        assertTrue(p[0] > 0.5f);
        assertEquals(-1f, p[1], 0f);
        assertEquals(-1f, p[2], 0f);
    }

    @Test public void aSynonymLabelDoesNotStealThePhoto() {
        float[] food = unit(1, 0, 0), meal = unit(1, 0.01f, 0), sign = unit(0, 1, 0);
        float[] p = SceneLabels.match(food, new float[][]{meal, sign}, Arrays.asList(unit(0.2f, 0.02f, 0)));
        assertTrue(p[0] > 0.9f);
    }

    @Test public void noConceptInTheLibraryMeansNoMatch() {
        float[] dog = unit(1, 0, 0), cat = unit(0.8f, 0.6f, 0), car = unit(0, 0, 1);
        // A cat photo: "dog" is close-ish but the cat label wins clearly.
        float[] p = SceneLabels.match(dog, new float[][]{cat, car}, Arrays.asList(unit(0.7f, 0.7f, 0.1f)));
        assertEquals(-1f, p[0], 0f);
    }
}
