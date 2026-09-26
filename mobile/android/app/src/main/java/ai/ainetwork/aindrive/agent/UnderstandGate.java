package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

/**
 * Whether this device may use the on-device model to read unsure turns at all. The first real
 * model call is timed; past the budget the device is marked "too slow" for THIS model file and the
 * model is never loaded for understanding again (call summaries are unaffected — they have their
 * own budget). An S21+ once paid a 7 s load plus a 4 s wait on every unsure turn, only to fall
 * back to the rules: the gate makes that cost a one-off. Re-measured when the model file changes
 * ({@code modelId}: name + size + mtime), since a faster model may pass. Storage is behind
 * {@link Store} so the service backs it with SharedPreferences and tests with a map.
 */
public final class UnderstandGate {
    public interface Store {
        @Nullable String get(String key);
        void put(String key, String value);
    }

    static final String KEY_SLOW = "llm.understand.tooSlow", KEY_LAST_MS = "llm.understand.lastMs", KEY_MODEL = "llm.understand.model";

    private final Store store;
    private final String modelId;

    public UnderstandGate(Store store, String modelId) { this.store = store; this.modelId = modelId; }

    /** False once a call of this model file ran past the budget on this device. */
    public boolean allowed() { return !modelId.equals(store.get(KEY_SLOW)); }

    /** One model call took {@code ms} (generation only — the load is paid once and is not the device's speed). */
    public void record(long ms, long budgetMs) {
        store.put(KEY_LAST_MS, Long.toString(ms));
        store.put(KEY_MODEL, modelId);
        if (ms > budgetMs) store.put(KEY_SLOW, modelId);
    }

    /** The last measured call, or -1 when this model file was never measured here. */
    public long lastMs() {
        if (!modelId.equals(store.get(KEY_MODEL))) return -1;
        try { String s = store.get(KEY_LAST_MS); return s == null ? -1 : Long.parseLong(s); } catch (NumberFormatException e) { return -1; }
    }
}
