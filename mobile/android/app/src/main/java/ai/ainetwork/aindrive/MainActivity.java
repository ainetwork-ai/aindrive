package ai.ainetwork.aindrive;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(AindriveAgentPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
