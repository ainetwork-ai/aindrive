# AG-UI — Agent–User Interaction protocol

For apps that build **their own agent frontend** (for example with
[CopilotKit](https://copilotkit.ai)), aindrive speaks **AG-UI 1.0**: you POST a
`RunAgentInput`, it streams AG-UI events back.

| | |
|---|---|
| Account-wide | `POST {{BASE}}/agui` — pick a drive with `state.driveId` or a skill's `drive_id` |
| One drive | `POST {{BASE}}/agui/d/<driveId>` |
| Contract | `GET` either URL returns a machine-readable description |
| Encoding | `Accept: text/event-stream` (SSE JSON) or `application/vnd.ag-ui.event+proto` |
| Auth | `Authorization: Bearer <token>` — see [Authentication](/docs/auth) |

aindrive's agent is **deterministic** (no LLM): each run executes exactly one
[skill](/docs/skills), chosen from the input in this order:

1. `forwardedProps.a2uiAction` — an A2UI click (`{ userAction: {…} }`, CopilotKit's shape, or a bare A2UI action)
2. `forwardedProps.skill` + `forwardedProps.args` — an explicit call
3. the last `user` message — the [text commands](/docs/a2a#asking-for-something) (`ls`, `cat`, `find`, `drives`; anything else = filename search)

## Events you receive

```
RUN_STARTED
STEP_STARTED            stepName = skill
TOOL_CALL_START         toolCallName = skill
TOOL_CALL_ARGS          delta = JSON args
TOOL_CALL_END
TOOL_CALL_RESULT        content = JSON result  (or {"error":{code,message}})
ACTIVITY_SNAPSHOT       activityType = "a2ui-surface", content = { a2ui_operations: [...] }
STATE_SNAPSHOT          snapshot = { ...your state, driveId, path, skill, ok }
TEXT_MESSAGE_START/CONTENT/END   a one-line summary from the assistant
STEP_FINISHED
RUN_FINISHED
```

Bad input yields `RUN_STARTED` → `RUN_ERROR`. The `ACTIVITY_SNAPSHOT` uses the
same shape as `@ag-ui/a2ui-middleware`, so CopilotKit renders the file UI
without extra code.

## curl

```bash
curl -N {{BASE}}/agui/d/<driveId> \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"threadId":"t1","runId":"r1","state":{},"tools":[],"context":[],"forwardedProps":{},
       "messages":[{"id":"m1","role":"user","content":"ls"}]}'
```

## @ag-ui/client

```ts
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "{{BASE}}/agui/d/<driveId>",
  headers: { Authorization: `Bearer ${token}` },
});
agent.messages = [{ id: "m1", role: "user", content: "find report" }];
await agent.runAgent({}, {
  onActivitySnapshotEvent: ({ event }) => render(event.content.a2ui_operations),
  onTextMessageContentEvent: ({ event }) => console.log(event.delta),
});

// a click in the rendered surface:
await agent.runAgent({ forwardedProps: { a2uiAction: { userAction: action } } });
```

## CopilotKit

Point a CopilotKit runtime at the endpoint as an AG-UI `HttpAgent` (with the
bearer header). Surfaces arrive as `a2ui-surface` activities, and CopilotKit's
A2UI renderer forwards clicks as `forwardedProps.a2uiAction` — exactly what
aindrive expects.
