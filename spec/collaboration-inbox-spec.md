# Collaboration Inbox UX and API Specification

**Status:** Phase 1 implemented

**Date:** 2026-08-28

**Scope:** Ego Lite local Linux application and the embedded `ego-browser` agent SDK
**Implementation status:** Durable manual Inbox implemented; Phase 2 and Phase 3 remain planned

## 1. Objective

Make browser collaboration between a person and one or more agents explicit, quiet,
and recoverable.

The user must be able to answer every outstanding agent request from one pinned
**Needs You** queue without searching through tabs or task spaces. Background agent
work must remain visible without stealing focus. A request that needs the user may
only present the browser after an explicit user action or through the existing
instructed-user-action focus policy.

### Success outcome

- Every unresolved user request is visible in one place.
- The user always knows which agent and task space owns the request.
- A response is accepted exactly once and has deterministic resume semantics.
- Requests survive navigation, daemon restart, and the originating CLI process exit.
- Empty or idle spaces do not consume large screenshot cards.
- Creating a request never flashes or focuses a window by itself.

## 2. Product principles

1. **Quiet by default.** Agent-created spaces and ordinary progress updates never
   focus or raise the browser.
2. **Attention is a state, not a notification.** A durable queue is the source of
   truth; desktop notifications and in-page overlays are projections of it.
3. **Control is always visible.** Each request and space shows whether the agent or
   user currently controls it.
4. **Opening is not answering.** `Open page` presents context but does not resolve a
   request.
5. **Responses are structured and idempotent.** Retrying the same response is safe;
   conflicting responses fail visibly.
6. **Secrets stay on the page.** Inbox fields never request, store, or echo
   passwords, recovery codes, payment data, or session tokens.
7. **Backward compatibility first.** Existing Done/Cancel `requestUserAction`
   callers continue to work without changes.

## 3. Recommended architecture

Use a hybrid model:

- a daemon-owned, persistent collaboration request store is the source of truth;
- the Spaces panel renders the global Inbox;
- the existing closed-shadow in-page panel renders the same request in page context;
- the SDK wait/resume path observes the same state transitions.

### Alternatives rejected

| Alternative                        | Reason rejected                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Page overlay only                  | It disappears from the user's attention when the page is hidden, navigates, or closes.   |
| Inbox only                         | It loses target-level page context and makes manual actions slower.                      |
| Screenshots as the source of truth | Screenshots are stale, privacy-sensitive, and do not encode response or ownership state. |

## 4. UX specification

### 4.1 Spaces panel layout

At narrow widths, including the observed approximately 592 px panel width, use a
single column:

```text
+--------------------------------------------------+
| Spaces                        3 spaces   [Pause]  |
+--------------------------------------------------+
| NEEDS YOU (2)                                    |
| Hostinger - Core agent                           |
| Confirm the DNS record after reviewing it.       |
| Sensitive action · waiting 1m                    |
| [Open page]              [Cancel] [Done]          |
|                                                  |
| Analytics - Research agent                       |
| Choose the report period.                        |
| ( ) 7 days  ( ) 30 days  ( ) 90 days             |
| [Open page]                       [Send choice]   |
+--------------------------------------------------+
| LIVE WORK (1)                                    |
| [medium preview] Agent · domain · current step   |
+--------------------------------------------------+
| RECENT / IDLE (2)                                |
| [icon] Space name · no page yet · 4m       [Open]|
| [icon] Space name · stopped · 9m           [Open]|
+--------------------------------------------------+
```

At widths above 900 px, live work cards may use two columns. The **Needs You** queue
always spans the full width and stays above normal work.

### 4.2 Needs You request card

Every card contains:

- task space name;
- agent/profile display name;
- current domain, or `No page available`;
- concise title and one actionable instruction;
- risk label: `Routine`, `Sensitive`, or `Destructive`;
- control label: `Agent paused`, `You control this page`, or `Agent unavailable`;
- request age;
- optional target description, never raw HTML;
- response controls determined by the request type.

Supported MVP request types:

| Type       | Controls                                 | Resume behavior                                                |
| ---------- | ---------------------------------------- | -------------------------------------------------------------- |
| `manual`   | `Open page`, `Cancel`, `Done`            | Done resumes; Cancel does not.                                 |
| `approval` | `Open page`, `Reject`, `Approve`         | Approve resumes; Reject does not unless explicitly configured. |
| `choice`   | 2-6 predefined choices and `Send choice` | A valid choice resumes by default.                             |

Short free-text responses are Phase 2. They must be limited to 512 characters and
must display `Do not enter passwords or verification codes`. Credential entry always
happens directly on the website after `Open page`.

### 4.3 User actions

#### Open page

1. Switch to or present the request's task space.
2. Give the user control if the request requires direct page interaction.
3. Focus the browser because this action was initiated by the user.
4. Keep the request unresolved.
5. Re-render the in-page panel from the persistent request record.

If no live tab exists, keep the request visible and return an `Unavailable` state;
do not silently create a replacement page.

#### Respond

1. Submit a versioned structured response.
2. Disable all response controls while the request is being committed.
3. On success, move the card to `Recently resolved` for 10 seconds.
4. Resume the agent only when the request's resume policy allows it.
5. On a conflict, reload the winning response and show `Already answered`.

#### Cancel or reject

Cancel resolves the wait but never returns browser control to the agent automatically.
The task space remains user-controlled until the user or another explicit operation
returns control.

### 4.4 Compact task-space cards

- A space with no live page uses a 64-72 px row, not a blank screenshot area.
- An idle or stopped space uses a compact row by default.
- A live space may show a medium preview with current intent and current step.
- A space with a pending request is represented by its Inbox card and may also appear
  in the normal section with a `Needs you` badge.
- Low-level cursor events remain available behind `Show activity`; they are not the
  primary explanation of agent intent.

### 4.5 Focus and notification policy

| Event                                                                        | Browser focus | Desktop notification   |
| ---------------------------------------------------------------------------- | ------------- | ---------------------- |
| Agent opens or navigates a background task space                             | Never         | No                     |
| Agent creates a request                                                      | Never         | Optional, rate-limited |
| User clicks `Open page`                                                      | Yes           | No                     |
| Existing instructed user-action policy explicitly presents a concrete action | Allowed       | Optional               |
| Request changes or resolves                                                  | Never         | No                     |

No request-creation path may use a generic window-activation command. If presentation
is required, activation must target the exact Ego Lite process/window and only under
the instructed-user-action policy.

## 5. State model

### 5.1 Request lifecycle

```text
pending ──open──> pending
   │
   ├──valid response──> resolved ──retention──> archived
   ├──cancel/reject───> cancelled ─retention──> archived
   └──deadline────────> expired ───retention──> archived
```

`Open page` records `openedAt` and may change control ownership, but does not change
the request status. A terminal transition wins exactly once.

### 5.2 Control ownership

Request state and task-space control state are independent:

```text
agent
  └─request requiring user action─> agentDelegatedToUser
       ├─Done/Approve/Choice with resume policy─> agent
       └─Cancel/Reject/Expire───────────────────> agentDelegatedToUser
```

If the agent session is no longer available, a resumable response resolves the
request but reports `resumed: false` with an explicit reason.

### 5.3 Persistence

Add a separate daemon-owned `collaboration-requests.json` state file rather than
embedding all requests into task-space records.

Requirements:

- parent state directory mode `0700`;
- file mode `0600`;
- atomic replace writes;
- inter-process serialization or locking;
- load-time schema validation and corrupt-file quarantine;
- at most 100 terminal requests or 24 hours of terminal history, whichever is less;
- pending requests are never removed by TTL cleanup;
- no passwords, tokens, cookie values, form values, or page HTML.

The in-page overlay is not authoritative. Navigation or daemon restart reconstructs
it from the request store.

## 6. Data contract

### 6.1 Collaboration request

```ts
type CollaborationRequest = {
  id: string; // UUID
  version: number; // incremented on every mutation
  actionKey: string; // caller-provided idempotency key, max 128 chars
  taskSpaceId: number;
  taskSpaceName: string;
  agentSessionId?: string;
  agentProfile?: string;
  type: "manual" | "approval" | "choice" | "text";
  title: string; // plain text, max 120 chars
  instruction: string; // plain text, max 1000 chars
  target?: {
    description: string; // plain text, max 240 chars
    locator?: string; // durable locator only; omit sensitive values
  };
  choices?: Array<{
    id: string; // unique within request
    label: string; // max 80 chars
    description?: string; // max 240 chars
  }>;
  risk: "routine" | "sensitive" | "destructive";
  preview: "none" | "page" | "target";
  status: "pending" | "resolved" | "cancelled" | "expired" | "archived";
  resumeOn: Array<"done" | "approve" | "choice" | "text">;
  createdAt: string;
  openedAt?: string;
  deadlineAt?: string;
  terminalAt?: string;
  response?: CollaborationResponse;
};

type CollaborationResponse = {
  kind: "done" | "cancel" | "approve" | "reject" | "choice" | "text";
  choiceId?: string;
  text?: string; // Phase 2, non-secret, max 512 chars
  respondedAt: string;
  resumed: boolean;
  resumeFailure?: "agent_unavailable" | "ownership_conflict" | "runtime_error";
};
```

Only one active request may exist for `(taskSpaceId, actionKey)`. Re-creating the
same active request returns it. Reusing the key with different content returns a
conflict.

## 7. Local HTTP API

All endpoints inherit the existing Spaces daemon origin checks and token
authentication. Tokens must never be accepted in query parameters and must never be
written to logs.

### 7.1 List requests

```http
GET /api/collaboration/requests?view=pending|recent|all
```

Response:

```json
{
  "requests": [],
  "pendingCount": 0,
  "serverTime": "2026-08-28T12:00:00.000Z"
}
```

Default view is `pending`. `recent` returns terminal requests inside the retention
window. Archived request bodies are not returned.

### 7.2 Open request context

```http
POST /api/collaboration/requests/:id/open
Content-Type: application/json

{ "requestVersion": 3 }
```

Success:

```json
{
  "request": {},
  "presented": true,
  "control": "user"
}
```

Errors:

- `404` unknown request;
- `409` stale version or ownership conflict;
- `410` task space exists but no live tab can be presented.

This endpoint never resolves the request.

### 7.3 Respond

```http
POST /api/collaboration/requests/:id/respond
Content-Type: application/json

{
  "requestVersion": 3,
  "response": {
    "kind": "choice",
    "choiceId": "last-30-days"
  }
}
```

Success returns the terminal request and resume result:

```json
{
  "request": {},
  "accepted": true,
  "resumed": true
}
```

Idempotency rules:

- repeating an identical terminal response returns `200` and `accepted: true`;
- a different response after the terminal transition returns `409` and the winning
  terminal request;
- an invalid choice or response kind returns `422`;
- Cancel/Reject/Expire must return `resumed: false` unless explicitly allowed by a
  future API version.

### 7.4 Archive terminal request

```http
POST /api/collaboration/requests/:id/archive
Content-Type: application/json

{ "requestVersion": 4 }
```

Only terminal requests can be archived. Archive removes the body from UI results but
retains the minimal request ID, timestamps, and terminal status until TTL cleanup.

### 7.5 Change events

Use the existing authenticated fetch-based event stream. Emit:

```json
{
  "type": "collaboration-request-changed",
  "requestId": "...",
  "version": 4,
  "status": "resolved"
}
```

Events are hints only. The panel always re-fetches canonical state after reconnect,
sequence gaps, or version mismatch.

## 8. Agent SDK contract

Extend the existing task-space user-action request rather than adding a second handoff
mechanism:

```ts
await taskSpaces.requestUserAction(taskSpaceId, {
  actionKey: "confirm-hostinger-dns",
  type: "approval",
  title: "Confirm the DNS record",
  instruction: "Review the highlighted record and approve it if correct.",
  target: "loc=role:row[name='TXT @']",
  risk: "sensitive",
  preview: "target",
  resumeOn: ["approve"],
  doneLabel: "Approve",
  cancelLabel: "Reject",
});
```

Result:

```ts
type UserActionResult = {
  userResult: "done" | "cancelled";
  response?: {
    kind: "done" | "cancel" | "approve" | "reject" | "choice" | "text";
    choiceId?: string;
    text?: string;
  };
  resumed: boolean;
  resumeFailure?: string;
};
```

Backward compatibility:

- existing `instruction`, `target`, `doneLabel`, and `cancelLabel` calls become a
  `manual` request;
- existing Done behavior resumes the agent;
- existing Cancel behavior leaves the task space user-controlled;
- callers that omit `actionKey` receive a generated process-local key, but durable
  retry safety requires callers to provide one.

The low-level `showUserAction`, `waitForUserAction`, `clearUserAction`, and
`notifyUserAction` bridge may remain internal, but all four must operate on the same
persistent request ID.

## 9. Security and privacy requirements

- Authenticate every `/api/collaboration/` request with the daemon token.
- Enforce same-origin and reject cross-site state-changing requests.
- Sanitize and length-limit every caller-provided display string.
- Render all caller text as text nodes, never HTML.
- Do not include tokens in URLs, logs, screenshots, event payloads, or errors.
- Default `preview` to `none` on login, payment, account, and recovery pages.
- Never persist field values or clipboard contents.
- Do not accept credential-shaped text responses in Inbox text mode.
- Make terminal transitions compare-and-swap operations on `version`.
- Ensure site JavaScript cannot read or forge responses from the closed-shadow panel.
- Rate-limit desktop notifications and never include sensitive instructions in them.
- `Open page` may focus only because the user initiated it; request creation may not.

## 10. Failure and recovery behavior

| Failure                               | Required behavior                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Page navigates                        | Request persists; overlay is re-created from canonical state.                                   |
| Tab closes                            | Request stays visible; `Open page` returns unavailable; Cancel remains available.               |
| Agent CLI exits                       | Request stays visible; a resumable response reports `agent_unavailable`.                        |
| Daemon restarts                       | Pending requests reload before the API becomes ready.                                           |
| Browser restarts                      | Requests remain; live-tab availability is reconciled.                                           |
| Duplicate create                      | Return the active request for the same action key and identical content.                        |
| Overlay and Inbox answer concurrently | One compare-and-swap wins; the loser displays the winning answer.                               |
| Event stream disconnects              | Re-fetch full canonical state on reconnect.                                                     |
| Request expires                       | Mark expired and do not return control to the agent automatically.                              |
| State file is corrupt                 | Quarantine it, start empty, and display a local diagnostic; do not overwrite evidence silently. |

## 11. Accessibility

- All controls must be keyboard reachable in logical order.
- Moving a request to terminal state announces the result through an ARIA live region.
- Color is never the only indication of risk, ownership, or status.
- The first pending request heading is the default landmark target, not automatic
  keyboard focus.
- Dialog-free inline cards are preferred; destructive approvals require an explicit
  confirmation dialog.
- Minimum interactive target size is 40 x 40 CSS pixels.

## 12. Acceptance criteria

### Behavior

1. Creating a request produces zero browser focus/raise events.
2. A new request appears in the open Spaces panel within 500 ms on the local machine.
3. `Open page` presents the exact task space and does not resolve the request.
4. A valid response is committed exactly once under concurrent overlay/Inbox use.
5. Repeating the same response is idempotent; a conflicting response returns `409`.
6. Done/Approve/Choice resumes an available agent within 1 second when allowed.
7. Cancel/Reject/Expire never resumes the agent.
8. Pending requests survive navigation, daemon restart, browser restart, and origin
   CLI process exit.
9. No-page and idle spaces render as compact rows at 592 px width.
10. No credential values, cookies, tokens, or page HTML are stored in the request file.

### Verification

- Unit tests cover every state transition and schema boundary.
- API tests cover token/origin enforcement, `422`, `409`, `410`, and identical retry.
- Race tests answer the same request concurrently from the overlay and Inbox.
- Persistence tests restart the daemon with a pending request.
- Focus telemetry proves no activation on background creation and exactly one user-
  initiated activation on `Open page`.
- Visual tests cover 592 px and 1280 px widths, with no-page, live, pending, resolved,
  and unavailable states.
- Accessibility tests cover keyboard order, labels, live announcements, and contrast.

## 13. Measurement plan

Run the same ten human-in-the-loop browser tasks with the current overlay-only flow
and the Inbox flow.

Ship criteria:

- median time from request creation to user notice under 10 seconds;
- at least 30% lower median request completion time;
- zero unrequested focus steals;
- zero duplicate side effects from repeated responses;
- at least 90% of test users correctly identify who controls the task space.

These are hypotheses until measured; a build or passing unit test alone does not prove
the collaboration experience is better.

## 14. Rollout plan

### Phase 1: durable manual Inbox

- persistent request store;
- manual Done/Cancel requests;
- pinned Needs You section;
- compact idle/no-page rows;
- authenticated change events;
- compatibility adapter for current user-action callers.

### Phase 2: structured collaboration

- approval and predefined-choice requests;
- short non-secret text responses;
- persistent global Pause/Resume control;
- notification preferences.

### Phase 3: contextual feedback

- point-and-comment on page elements;
- richer agent intent/current/next summaries;
- optional local collaboration history export.

Phase 1 is enabled by default after persistence, race, focus, and visual checks.
`EGO_LINUX_COLLABORATION_INBOX=0` is a diagnostic kill switch. The current overlay
and Inbox read and write the same request record; they never dual-write independent
state.

## 15. Implementation map

Expected minimum change surface:

- `package/ego-linux/src/collaboration-store.mjs` - schema, atomic persistence,
  compare-and-swap transitions, retention;
- `package/ego-linux/src/user-action.mjs` - project the canonical request into the
  in-page panel and route answers through the store;
- `package/ego-linux/src/spaces-server.mjs` - authenticated request endpoints and
  change events;
- `package/ego-linux/src/spaces-ui.mjs` - Needs You queue and compact space layout;
- `package/ego-browser/src/helpers.ts` - typed request options, compatibility, and
  structured results;
- relevant Linux and browser unit/E2E tests;
- `skills/ego-browser/SKILL.md` and generated helper documentation.

## 16. Non-goals

- replacing site-native login, MFA, checkout, or password entry;
- a full remote desktop or continuous screen recording system;
- cloud synchronization or multi-user tenancy;
- a general chat application;
- an arbitrary workflow builder;
- storing complete DOM snapshots or long-term browsing history.
