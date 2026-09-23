package ai.ainetwork.aindrive;

import android.content.Intent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(AindriveAgentPlugin.class);
        super.onCreate(savedInstanceState);
        forwardDebugIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        forwardDebugIntent(intent);
    }

    /**
     * Debug builds only: let `adb shell am start` drive the agent service
     * (START / REINDEX / ASK) through this exported activity, since the
     * service itself is deliberately not exported. Lets the agent be exercised
     * from a Mac without unlocking the phone. Example:
     *   am start -n ai.ainetwork.aindrive/.MainActivity --es agentAction ai.ainetwork.aindrive.ASK --es query "파리 사진"
     */
    private void forwardDebugIntent(Intent src) {
        if (!BuildConfig.DEBUG || src == null) return;
        String action = src.getStringExtra("agentAction");
        if (action == null) return;
        src.removeExtra("agentAction");   // onCreate + onNewIntent must not both forward it
        Intent svc = new Intent(this, AgentService.class).setAction(action);
        if (src.getExtras() != null) svc.putExtras(src.getExtras());
        if (AgentService.ACTION_START.equals(action)) startForegroundService(svc);
        else startService(svc);
    }
}
