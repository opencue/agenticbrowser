/**
 * The Spaces overview page, served by spaces-server.mjs.
 *
 * Kept as a single self-contained string: the page is loaded in an --app window
 * with no toolbar, so there is no navigation to a second file, and inlining
 * avoids a static-file route that would widen the server's surface.
 */
export function profileLabel(profile) {
  if (!profile) return "Personal";
  return profile
    .split("+")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" · ");
}

export function spacePriority(space) {
  if (space.activity?.live) return 0;
  if (space.activity) return 1;
  if (space.ownership === "agentDelegatedToUser") return 2;
  if (space.ownership === "user") return 3;
  return 4;
}

export function activityStatus(space) {
  if (space.ownership !== "agent") return null;
  if (space.activity?.live) return "Live";
  if (space.activity) return "Recent";
  return "Agent";
}

export function compareSpaces(left, right) {
  return (
    spacePriority(left) - spacePriority(right) ||
    (left.name || "").localeCompare(right.name || "")
  );
}

export function compareSpaceGroups(
  [leftProfile, leftSpaces],
  [rightProfile, rightSpaces],
) {
  if (!leftProfile && !rightProfile) return 0;
  if (!leftProfile) return 1;
  if (!rightProfile) return -1;
  const leftPriority = Math.min(...leftSpaces.map(spacePriority));
  const rightPriority = Math.min(...rightSpaces.map(spacePriority));
  return (
    leftPriority - rightPriority ||
    profileLabel(leftProfile).localeCompare(profileLabel(rightProfile))
  );
}

export const SPACES_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Spaces</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fafafa;
    --surface: #fff;
    --surface-soft: #f4f4f4;
    --line: #e5e5e5;
    --line-strong: #a3a3a3;
    --text: #171717;
    --muted: #525252;
    --primary-hover: #404040;
    --warm: #845300;
    --warm-soft: #fff4d7;
    --live: #08774c;
    --danger: #b42318;
    --radius: 8px;
    --text-base: clamp(16px, 0.25vw + 13px, 18px);
    --text-small: clamp(13px, 0.14vw + 11.5px, 14px);
    --compact-thumb: clamp(76px, 5vw, 92px);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0a0a;
      --surface: #111;
      --surface-soft: #1a1a1a;
      --line: #2b2b2b;
      --line-strong: #666;
      --text: #ededed;
      --muted: #a1a1a1;
      --primary-hover: #ccc;
      --warm: #f5bb60;
      --warm-soft: #2b2113;
      --live: #50d098;
      --danger: #ff8a80;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    padding: 0 clamp(16px, 3vw, 48px) 48px;
    background: var(--bg);
    color: var(--text);
    font: var(--text-base)/1.5 Geist, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .app-shell { width: min(100%, 1360px); margin: 0 auto; }
  header {
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
    position: sticky; top: 0; z-index: 20;
    gap: 12px 24px; margin-bottom: 32px; padding: 24px 0 20px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
  }
  h1 { font-size: clamp(28px, 2vw + 14px, 36px); font-weight: 650; margin: 0; line-height: 1.15; letter-spacing: -0.04em; }
  .sub { display: block; margin-top: 5px; color: var(--muted); font-size: 14px; }
  .summary, .section-count, .status {
    color: var(--muted); font-size: var(--text-small); font-variant-numeric: tabular-nums;
    padding: 3px 8px; border: 1px solid var(--line); border-radius: 999px;
    background: var(--surface-soft);
  }
  .summary:empty { display: none; }
  .inbox { margin-bottom: 34px; }
  .inbox[hidden] { display: none; }
  .inbox-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-bottom: 12px;
  }
  .inbox-title, .section-title {
    font-size: 16px; font-weight: 650; margin: 0; letter-spacing: -0.015em;
  }
  .inbox-title::before {
    content: ""; display: inline-block; width: 7px; height: 7px;
    margin-right: 8px; vertical-align: .12em; border-radius: 50%;
    background: var(--warm);
  }
  .inbox-list { display: grid; gap: 10px; }
  .request-card {
    display: grid; grid-template-columns: minmax(0, 1fr) auto;
    gap: 14px 24px; padding: 16px 18px;
    border: 1px solid var(--line); border-radius: var(--radius);
    background: var(--surface);
  }
  .request-copy { min-width: 0; overflow-wrap: anywhere; }
  .request-title { font-size: 16px; font-weight: 650; }
  .request-instruction {
    margin-top: 3px; color: var(--text); font-size: 15px;
  }
  .request-meta { margin-top: 7px; color: var(--muted); font-size: var(--text-small); }
  .request-actions { display: flex; align-items: center; gap: 8px; }
  .ctl.cancel:hover { color: var(--danger); border-color: var(--danger); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr));
    gap: 16px;
    justify-content: start;
    align-items: start;
  }
  /* The outer container stacks sections; only each section's body is a grid. */
  .sections { display: block; }
  .section + .section { margin-top: 32px; }
  .section-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-bottom: 12px; padding-bottom: 10px;
    border-bottom: 1px solid var(--line);
  }
  .section-title {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .section-count { flex: none; }
  .card {
    display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 12px;
    border: 1px solid var(--line); border-radius: var(--radius);
    background: var(--surface);
    transition: border-color .16s ease;
  }
  .card.compact {
    display: grid; grid-template-columns: var(--compact-thumb) minmax(0, 1fr) auto;
    align-items: center; gap: 12px;
  }
  .card:hover, .card:focus-within { border-color: var(--line-strong); }
  .card.compact .frame {
    width: var(--compact-thumb); height: var(--compact-thumb); aspect-ratio: auto;
  }
  .card.compact .close { opacity: 1; width: 24px; height: 24px; top: 5px; right: 5px; }
  .card.compact .controls { padding: 0; flex-direction: column; align-items: stretch; }
  .card.compact .trail { display: none; }
  .frame {
    position: relative;
    aspect-ratio: 16 / 10;
    background: var(--surface-soft);
    border: 1px solid var(--line);
    border-radius: calc(var(--radius) - 2px);
    overflow: hidden;
    cursor: pointer;
    transition: border-color .16s ease;
  }
  .frame:hover { border-color: var(--line-strong); }
  .frame img {
    width: 100%; height: 100%; object-fit: cover; object-position: top center;
    display: block;
    transition: transform .28s ease-out, transform-origin .28s ease-out;
  }
  /* A working space is cropped to where its agent is, so the frame shows the
     action rather than the whole page — say so, or the zoom looks like a bug. */
  .frame.live img, .frame.recent img { object-position: center; }
  .live-chip {
    position: absolute; left: 9px; bottom: 9px; right: 9px;
    display: flex; align-items: center; gap: 7px;
    padding: 5px 11px 5px 9px; border-radius: 6px;
    background: #171717; color: #fff;
    font-size: var(--text-small); font-weight: 500; line-height: 1.35;
    pointer-events: none;
  }
  .live-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live-chip i {
    flex: none; width: 7px; height: 7px; border-radius: 50%;
    background: #50d098; animation: breathe 1.7s ease-in-out infinite;
  }
  .live-chip.recent i {
    background: #a1a1a1; animation: none;
  }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  .frame.empty {
    display: grid; place-items: center; padding: 18px 4px 4px;
    color: var(--muted); font-size: 12px; text-align: center;
  }
  .meta { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 0 3px; }
  .meta-top, .page-meta {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    min-width: 0;
  }
  .card.compact :is(.meta-top, .page-meta) {
    justify-content: flex-start; flex-wrap: wrap; gap: 3px 8px;
  }
  .name, .page-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name { font-size: 16px; font-weight: 620; }
  .page-title { color: var(--muted); font-size: 14px; }
  .page-context { color: var(--muted); font-size: var(--text-small); overflow-wrap: anywhere; }
  .status { flex: none; font-weight: 600; }
  .card:has(.frame.live) .status { color: var(--live); }
  .status.agentDelegatedToUser {
    color: var(--warm); background: var(--warm-soft);
    border-color: transparent;
  }
  .close {
    position: absolute; top: 9px; right: 9px;
    width: 25px; height: 25px; border-radius: 5px;
    border: 1px solid var(--line); background: var(--surface); color: var(--muted);
    font-size: 15px; line-height: 1; cursor: pointer;
    opacity: 0; transition: opacity .14s ease;
  }
  .frame:hover .close, .frame:focus-within .close { opacity: 1; }
  .close:hover { color: var(--danger); }
  .add {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  }
  .grid > .add {
    min-height: calc(var(--compact-thumb) + 26px);
    border-style: dashed;
  }
  .controls { display: flex; gap: 8px; padding: 0 3px; }
  .ctl {
    min-height: 36px; font: inherit; font-size: 14px; line-height: 1.2;
    padding: 8px 12px; border-radius: 6px;
    border: 1px solid var(--line); background: var(--surface); color: var(--text);
    font-weight: 550;
    cursor: pointer;
    transition: color .14s ease, border-color .14s ease, background .14s ease;
  }
  .ctl:hover {
    border-color: var(--line-strong); background: var(--surface-soft);
  }
  .ctl.primary, .ctl.done {
    color: var(--bg); border-color: transparent; background: var(--text);
  }
  .ctl.primary:hover, .ctl.done:hover {
    border-color: transparent; background: var(--primary-hover);
  }
  .note {
    margin-top: 34px; padding-top: 16px; border-top: 1px solid var(--line);
    color: var(--muted); font-size: 14px; max-width: 62ch;
  }
  .note:empty { display: none; }
  /* What the space actually did, so a card that has gone quiet still says
     something. Reads newest first, like a log. */
  .trail { display: flex; flex-direction: column; gap: 2px; padding: 2px 3px 0; }
  .trail div {
    display: flex; gap: 7px; color: var(--muted); font-size: var(--text-small);
    overflow: hidden; white-space: nowrap;
  }
  .trail div span:first-child { overflow: hidden; text-overflow: ellipsis; }
  .trail div span:last-child { flex: none; opacity: .72; }
  .trail div:first-child { color: var(--text); opacity: .82; }
  .empty-state {
    padding: 36px 16px; text-align: center; border: 1px solid var(--line);
    border-radius: var(--radius); background: var(--surface);
  }
  .empty-state h2 { margin: 0; font-size: 18px; font-weight: 650; }
  .empty-state p { margin: 6px 0 18px; color: var(--muted); font-size: 14px; }
  button:focus-visible, .frame:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 3px;
  }
  @media (max-width: 700px) {
    header { position: static; margin-bottom: 24px; padding: 20px 0 14px; }
    .request-card { grid-template-columns: 1fr; }
    .request-actions { justify-content: flex-end; flex-wrap: wrap; }
    .card.compact { grid-template-columns: 72px minmax(0, 1fr); }
    .card.compact .frame { width: 72px; height: 72px; }
    .card.compact .controls { grid-column: 1 / -1; flex-direction: row; }
    .grid > .add { min-height: 48px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
    }
  }
</style>
</head>
<body>
  <div class="app-shell">
  <header>
    <div>
      <h1>Spaces</h1>
      <span class="sub">Workspaces you and your agents share.</span>
    </div>
    <span class="summary" id="summary"></span>
  </header>
  <section class="inbox" id="inbox" hidden></section>
  <div class="sections" id="grid"></div>
  <p class="note" id="note"></p>
  </div>

<script>
const grid = document.getElementById("grid");
const inbox = document.getElementById("inbox");
const note = document.getElementById("note");
const summary = document.getElementById("summary");
let busy = false;
let refreshInFlight = null;

const fragmentToken = new URLSearchParams(location.hash.slice(1)).get("token");
if (fragmentToken) {
  sessionStorage.setItem("ego-spaces-token", fragmentToken);
  history.replaceState(null, "", location.pathname + location.search);
}
const daemonToken = sessionStorage.getItem("ego-spaces-token") || "";

const profileLabel = ${profileLabel.toString()};
const spacePriority = ${spacePriority.toString()};
const compareSpaces = ${compareSpaces.toString()};
const compareSpaceGroups = ${compareSpaceGroups.toString()};
const activityStatus = ${activityStatus.toString()};

async function api(path, options) {
  if (!daemonToken) throw new Error("missing Spaces access token");
  const response = await fetch(path, {
    ...options,
    headers: {
      ...options?.headers,
      "content-type": "application/json",
      "x-ego-daemon-token": daemonToken,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || "request failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/**
 * What the agent in this space is doing, over the thumbnail. The cursor itself
 * is only a few pixels at card scale, so the chip — not the crop — is what makes
 * activity readable at a glance.
 */
function liveChip(activity) {
  const chip = document.createElement("div");
  chip.className = "live-chip" + (activity.live ? "" : " recent");
  const seconds = Math.round(activity.ageMs / 1000);
  const when = seconds < 2 ? "now" : seconds + "s ago";
  const text = document.createElement("span");
  text.textContent =
    (activity.name || "agent") +
    (activity.label ? " \\u00b7 " + activity.label : "") +
    " \\u00b7 " +
    when;
  chip.append(document.createElement("i"), text);
  return chip;
}

function pageContext(space) {
  let host = "";
  try {
    host = new URL(space.url).hostname;
  } catch {
    // A missing or internal URL has no useful host label.
  }
  const tabs = space.tabCount + (space.tabCount === 1 ? " tab" : " tabs");
  return host ? host + " \\u00b7 " + tabs : tabs;
}

function card(space) {
  const wrap = document.createElement("div");
  wrap.className = "card compact";
  if (space.activity) wrap.className = "card";

  const frame = document.createElement("div");
  frame.className =
    "frame" +
    (space.thumbnail ? "" : " empty") +
    (space.activity ? (space.activity.live ? " live" : " recent") : "");
  frame.title = space.url || "";
  if (space.thumbnail) {
    const img = document.createElement("img");
    img.src = space.thumbnail;
    img.alt = space.title || space.name;
    // A screencast frame is the whole viewport, where the cursor is about five
    // pixels wide in a card — unreadable. The server used to crop to the cursor;
    // now the frames arrive continuously and the zoom happens here instead, so
    // motion stays smooth and the action still fills the card.
    const spot = space.activity;
    if (spot && spot.fx != null && spot.fy != null) {
      img.style.transformOrigin =
        (spot.fx * 100).toFixed(1) + "% " + (spot.fy * 100).toFixed(1) + "%";
      img.style.transform = "scale(2.4)";
    }
    frame.append(img);
  } else {
    frame.textContent = "No preview";
  }
  if (space.activity) frame.append(liveChip(space.activity));
  frame.addEventListener("click", () => act("/api/spaces/" + space.id + "/use", "POST"));

  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "\\u00d7";
  close.title = "close this space";
  close.setAttribute("aria-label", "Close " + space.name);
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    act("/api/spaces/" + space.id + "/close", "POST");
  });
  frame.append(close);

  const meta = document.createElement("div");
  meta.className = "meta";

  const metaTop = document.createElement("div");
  metaTop.className = "meta-top";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = space.name;

  const status = document.createElement("span");
  status.className = "status " + space.ownership;
  status.textContent =
    activityStatus(space) ||
    (space.ownership === "agentDelegatedToUser" ? "Your control" : "Personal");
  metaTop.append(name, status);

  const pageMeta = document.createElement("div");
  pageMeta.className = "page-meta";
  const pageTitle = document.createElement("span");
  pageTitle.className = "page-title";
  pageTitle.textContent = space.title || "No page yet";
  pageTitle.title = space.url || "";
  const context = document.createElement("span");
  context.className = "page-context";
  context.textContent = pageContext(space);
  pageMeta.append(pageTitle, context);
  meta.append(metaTop, pageMeta);

  // The ownership handshake, the same pair the native app puts on its Space
  // overlay: stop hands the space back to you and the agent's cursor goes away;
  // take over gives it back.
  const controls = document.createElement("div");
  controls.className = "controls";
  const open = document.createElement("button");
  open.className = "ctl primary";
  open.textContent = "Open";
  open.title = "open this space";
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    act("/api/spaces/" + space.id + "/use", "POST");
  });
  const agentOwned = space.ownership === "agent";
  const action = document.createElement("button");
  action.className = "ctl";
  action.textContent = agentOwned ? "Stop" : "Take over";
  action.title = agentOwned
    ? "hand this space back to you — the agent stops driving it"
    : "let the agent drive this space again";
  action.addEventListener("click", (event) => {
    event.stopPropagation();
    act("/api/spaces/" + space.id + "/" + (agentOwned ? "stop" : "takeover"), "POST");
  });
  controls.append(open, action);

  wrap.append(frame, meta, controls);
  if (space.trail?.length) wrap.append(trail(space.trail));
  return wrap;
}

/** Rough, human ages: nobody reads a card to the second. */
function ago(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? minutes + "m ago" : Math.round(minutes / 60) + "h ago";
}

function requestAge(request) {
  return ago(Math.max(0, Date.now() - Number(request.createdAt || Date.now())));
}

function requestCard(request, spacesById) {
  const space = spacesById.get(request.taskSpaceId);
  const card = document.createElement("article");
  card.className = "request-card";

  const copy = document.createElement("div");
  copy.className = "request-copy";
  const title = document.createElement("div");
  title.className = "request-title";
  title.textContent = request.taskSpaceName || space?.name || "Task space";
  const instruction = document.createElement("div");
  instruction.className = "request-instruction";
  instruction.textContent = request.instruction;
  const meta = document.createElement("div");
  meta.className = "request-meta";
  let host = "No page available";
  try {
    host = new URL(space?.url).hostname || host;
  } catch {}
  meta.textContent =
    profileLabel(request.agentProfile || space?.profile || "") +
    " \u00b7 " +
    (space ? host + " \u00b7 waiting " + requestAge(request) : "Task space closed");
  copy.append(title, instruction, meta);

  const actions = document.createElement("div");
  actions.className = "request-actions";
  const endpoint = "/api/collaboration/requests/" + request.id;
  const cancel = document.createElement("button");
  cancel.className = "ctl cancel";
  cancel.textContent = space ? request.cancelLabel || "Cancel" : "Dismiss";
  cancel.addEventListener("click", () =>
    act(endpoint + "/respond", "POST", {
      requestVersion: request.version,
      response: { kind: "cancel" },
    }),
  );
  if (space?.tabCount > 0) {
    const open = document.createElement("button");
    open.className = "ctl";
    open.textContent = "Open page";
    open.addEventListener("click", () =>
      act(endpoint + "/open", "POST", { requestVersion: request.version }),
    );
    actions.append(open);
  }
  actions.append(cancel);
  if (space) {
    const done = document.createElement("button");
    done.className = "ctl done";
    done.textContent = request.doneLabel || "Done";
    done.addEventListener("click", () =>
      act(endpoint + "/respond", "POST", {
        requestVersion: request.version,
        response: { kind: "done" },
      }),
    );
    actions.append(done);
  }
  card.append(copy, actions);
  return card;
}

function renderInbox(collaboration, spaces) {
  const requests = collaboration?.requests || [];
  if (collaboration?.enabled !== true || requests.length === 0) {
    inbox.hidden = true;
    inbox.replaceChildren();
    return;
  }
  const head = document.createElement("div");
  head.className = "inbox-head";
  const title = document.createElement("h2");
  title.className = "inbox-title";
  title.textContent = "Needs You";
  const count = document.createElement("span");
  count.className = "section-count";
  count.textContent = requests.length + (requests.length === 1 ? " request" : " requests");
  head.append(title, count);
  const list = document.createElement("div");
  list.className = "inbox-list";
  const spacesById = new Map(spaces.map((space) => [space.id, space]));
  list.append(...requests.map((request) => requestCard(request, spacesById)));
  inbox.replaceChildren(head, list);
  inbox.hidden = false;
}

/** What the space actually did, newest first. */
function trail(entries) {
  const list = document.createElement("div");
  list.className = "trail";
  for (const entry of entries) {
    const row = document.createElement("div");
    const what = document.createElement("span");
    what.textContent = entry.text;
    const when = document.createElement("span");
    when.textContent = ago(entry.ageMs);
    row.append(what, when);
    list.append(row);
  }
  return list;
}

function newSpaceButton({ primary = false } = {}) {
  const button = document.createElement("button");
  button.className = "ctl add" + (primary ? " primary" : "");
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "+";
  button.append(icon, document.createTextNode("New space"));
  button.addEventListener("click", async () => {
    const name = prompt("Name this space", "new space");
    if (name === null) return;
    await act("/api/spaces", "POST", { name: name.trim() || "new space" });
  });
  return button;
}

async function act(path, method, body) {
  if (busy) return;
  busy = true;
  try {
    const result = await api(path, { method, body: body ? JSON.stringify(body) : undefined });
    if (result?.visible === false) {
      if (result.reason === "headless") {
        note.textContent =
          "handed off, but the browser is headless; unset EGO_LINUX_HEADLESS and run ego-browser --open";
      } else if (result.reason === "no-live-tab") {
        note.textContent = "handed off, but this space has no live tab left";
      } else {
        note.textContent =
          "handed off, but the browser window could not be raised; open the ego lite window manually";
      }
    } else {
      note.textContent = "";
    }
    // A refresh started before the POST can still contain the old request.
    await refreshInFlight;
    await refresh();
  } catch (error) {
    if (error.status === 409 || error.status === 410) {
      await refreshInFlight;
      await refresh();
      note.textContent = error.status === 409
        ? "Already answered. Reloaded the winning response."
        : "The requested page is no longer available.";
    } else {
      note.textContent = "action failed: " + error.message;
    }
  } finally {
    busy = false;
  }
}

/**
 * Several cue profiles can drive the browser at once, so the overview groups by
 * the profile that opened each space. Without that, a row of cards from three
 * different agents reads as one undifferentiated pile.
 */
function groupByProfile(spaces) {
  const groups = new Map();
  for (const space of spaces) {
    const key = space.profile || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(space);
  }
  for (const list of groups.values()) list.sort(compareSpaces);
  return [...groups.entries()].sort(compareSpaceGroups);
}

function section(profile, spaces, withAddCard) {
  const wrap = document.createElement("section");
  wrap.className = "section";

  const head = document.createElement("div");
  head.className = "section-head";
  const title = document.createElement("h2");
  title.className = "section-title";
  title.textContent = profileLabel(profile);
  title.title = profile ? "cue profile: " + profile : "spaces created by you";
  const count = document.createElement("span");
  count.className = "section-count";
  const sessions = new Set(spaces.map((s) => s.session).filter(Boolean));
  count.textContent =
    spaces.length +
    (spaces.length === 1 ? " space" : " spaces") +
    (sessions.size > 1 ? " \\u00b7 " + sessions.size + " sessions" : "");
  count.title = title.title;
  head.append(title, count);

  const body = document.createElement("div");
  body.className = "grid";
  body.append(...spaces.map(card));
  if (withAddCard) body.append(newSpaceButton());

  wrap.append(head, body);
  return wrap;
}

async function loadSpaces(withPreviews) {
  try {
    const [{ spaces }, collaboration] = await Promise.all([
      api(withPreviews ? "/api/spaces" : "/api/spaces?preview=0"),
      api("/api/collaboration/requests"),
    ]);
    renderInbox(collaboration, spaces);
    const groups = groupByProfile(spaces);
    const liveCount = spaces.filter((space) => space.activity?.live).length;
    const profileCount = new Set(spaces.map((space) => space.profile).filter(Boolean)).size;
    const pendingCount = collaboration?.pendingCount || 0;
    summary.textContent = spaces.length
      ? spaces.length + (spaces.length === 1 ? " space" : " spaces") +
        (withPreviews ? " · " + liveCount + " live" : "") +
        " · " + profileCount + (profileCount === 1 ? " profile" : " profiles") +
        (pendingCount ? " · " + pendingCount + " need you" : "")
      : "No spaces";

    if (!spaces.length) {
      const empty = document.createElement("section");
      empty.className = "empty-state";
      const title = document.createElement("h2");
      title.textContent = "No spaces yet";
      const detail = document.createElement("p");
      detail.textContent = "Create a space, or let an agent open its own.";
      empty.append(title, detail, newSpaceButton({ primary: true }));
      grid.replaceChildren(empty);
    } else {
      grid.replaceChildren(
        ...groups.map(([profile, list], index) =>
          section(profile, list, index === groups.length - 1),
        ),
      );
    }

    note.textContent = spaces.length
      ? "Spaces share the live agent profile by default, so logins and site storage carry between them."
      : "";
  } catch (error) {
    note.textContent = "cannot reach the browser: " + error.message;
  }
}

function refresh(withPreviews = true) {
  if (!refreshInFlight) {
    refreshInFlight = loadSpaces(withPreviews).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// State-file writes and screencast frames wake the panel through authenticated SSE.
// A slow reconciliation remains for missed filesystem events, activity expiry,
// and stream reconnects.
const FALLBACK_POLL_MS = 15000;
let timer = null;

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(tick, FALLBACK_POLL_MS);
}

async function tick() {
  if (!busy && !document.hidden) await refresh();
  schedule();
}

async function watchEvents() {
  while (daemonToken) {
    try {
      const response = await fetch("/api/events", {
        headers: { "x-ego-daemon-token": daemonToken },
        cache: "no-store",
      });
      if (!response.ok || !response.body) throw new Error("events unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf("\\n\\n")) >= 0) {
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (/^event:\\s*refresh$/m.test(event) && !busy && !document.hidden) {
            void refresh();
          }
        }
      }
    } catch {
      // The daemon may be upgrading. Polling below remains the recovery path.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !busy) void refresh();
});

if (daemonToken) {
  void watchEvents();
  // Show usable cards before asking Chrome for thumbnails and cursor activity.
  refresh(false).then(() => {
    schedule();
    if (!busy) void refresh();
  });
} else {
  note.textContent = "Open Spaces through the Ego Lite launcher to authenticate this panel.";
}
</script>
</body>
</html>
`;
