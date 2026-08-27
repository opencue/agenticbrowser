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
  if (space.activity) return 0;
  if (space.ownership === "agentDelegatedToUser") return 1;
  if (space.ownership === "user") return 2;
  return 3;
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
    --bg: #eef1f7;
    --card: #ffffff;
    --line: rgba(15, 18, 25, 0.10);
    --text: #12151c;
    --muted: #6b7280;
    --accent: #2f6df6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161b;
      --card: #1c1f26;
      --line: rgba(255, 255, 255, 0.10);
      --text: #eef0f4;
      --muted: #9aa1ad;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    padding: 34px 40px 48px;
    background:
      radial-gradient(1200px 460px at 12% -8%, rgba(47, 109, 246, .10), transparent 60%),
      radial-gradient(900px 420px at 92% 4%, rgba(120, 90, 220, .09), transparent 62%),
      var(--bg);
    color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 18px; margin-bottom: 26px;
  }
  .heading { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
  h1 { font-size: 19px; font-weight: 650; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; }
  .summary {
    flex: none; color: var(--muted); font-size: 12px;
    padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px;
    background: color-mix(in srgb, var(--card) 72%, transparent);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 310px), 1fr));
    gap: 28px 20px;
    justify-content: start;
  }
  /* The outer container stacks sections; only each section's body is a grid. */
  .sections { display: block; }
  .section + .section { margin-top: 38px; }
  .section-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-bottom: 14px; padding-bottom: 9px;
    border-bottom: 1px solid var(--line);
  }
  .section-title {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 15px; font-weight: 650; letter-spacing: -0.01em;
  }
  .section-count {
    color: var(--muted); font-size: 11.5px;
    padding: 3px 8px; border: 1px solid var(--line); border-radius: 999px;
  }
  .card { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .frame {
    position: relative;
    aspect-ratio: 16 / 10;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    overflow: hidden;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(10, 14, 25, .05);
    transition: box-shadow .18s ease, transform .18s ease, border-color .18s ease;
  }
  .frame:hover {
    box-shadow: 0 14px 34px rgba(10, 14, 25, .16);
    transform: translateY(-3px);
    border-color: rgba(47, 109, 246, .35);
  }
  .dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    margin-right: 8px; vertical-align: middle;
    background: var(--accent);
  }
  .dot.user { background: var(--muted); }
  .dot.agentDelegatedToUser { background: #e0a02a; }
  .frame img {
    width: 100%; height: 100%; object-fit: cover; object-position: top center;
    display: block;
    transition: transform .28s ease-out, transform-origin .28s ease-out;
  }
  /* A working space is cropped to where its agent is, so the frame shows the
     action rather than the whole page — say so, or the zoom looks like a bug. */
  .frame.live { border-color: rgba(217, 119, 87, .55); }
  .frame.live img { object-position: center; }
  .live-chip {
    position: absolute; left: 9px; bottom: 9px; right: 9px;
    display: flex; align-items: center; gap: 7px;
    padding: 5px 11px 5px 9px; border-radius: 999px;
    background: rgba(24, 24, 27, .92); color: #fff;
    font-size: 11.5px; font-weight: 500; line-height: 1.35;
    box-shadow: 0 6px 16px rgba(0, 0, 0, .28);
    pointer-events: none;
  }
  .live-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live-chip i {
    flex: none; width: 7px; height: 7px; border-radius: 50%;
    background: #d97757; animation: breathe 1.7s ease-in-out infinite;
  }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  .frame.empty { display: grid; place-items: center; color: var(--muted); font-size: 13px; }
  .meta { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 0 3px; }
  .meta-top, .page-meta {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    min-width: 0;
  }
  .name, .page-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name { font-size: 14px; font-weight: 620; }
  .page-title { color: var(--muted); font-size: 12px; }
  .page-context { flex: none; color: var(--muted); font-size: 11.5px; }
  .status {
    flex: none; padding: 3px 8px; border-radius: 999px;
    color: var(--muted); background: rgba(127, 127, 127, .08);
    font-size: 11px; font-weight: 600;
  }
  .status.agent { color: #d97757; background: rgba(217, 119, 87, .12); }
  .status.agentDelegatedToUser { color: #c7891f; background: rgba(224, 160, 42, .12); }
  .close {
    position: absolute; top: 9px; right: 9px;
    width: 25px; height: 25px; border-radius: 50%;
    border: 1px solid var(--line); background: var(--card); color: var(--muted);
    font-size: 15px; line-height: 1; cursor: pointer;
    opacity: 0; transition: opacity .14s ease;
  }
  .frame:hover .close, .frame:focus-within .close { opacity: 1; }
  .close:hover { color: #d3453c; }
  .add {
    aspect-ratio: 16 / 10;
    border: 1px dashed var(--line);
    border-radius: 13px;
    background: transparent;
    color: var(--muted);
    font-size: 30px; font-weight: 300;
    cursor: pointer;
    transition: border-color .16s ease, color .16s ease, background .16s ease;
  }
  .add:hover { border-color: var(--accent); color: var(--accent); background: var(--card); }
  .controls { display: flex; gap: 8px; padding: 0 3px; }
  .ctl {
    font: inherit; font-size: 12px; line-height: 1;
    padding: 6px 12px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--card); color: var(--muted);
    cursor: pointer;
    transition: color .14s ease, border-color .14s ease, background .14s ease;
  }
  .ctl:hover { color: var(--text); border-color: var(--accent); background: var(--card); }
  .ctl.primary { color: var(--accent); border-color: rgba(47, 109, 246, .45); }
  .note {
    margin-top: 34px; padding-top: 16px; border-top: 1px solid var(--line);
    color: var(--muted); font-size: 12px; max-width: 62ch;
  }
  /* What the space actually did, so a card that has gone quiet still says
     something. Reads newest first, like a log. */
  .trail { display: flex; flex-direction: column; gap: 2px; padding: 2px 3px 0; }
  .trail div {
    display: flex; gap: 7px; color: var(--muted); font-size: 11.5px;
    overflow: hidden; white-space: nowrap;
  }
  .trail div span:first-child { overflow: hidden; text-overflow: ellipsis; }
  .trail div span:last-child { flex: none; opacity: .72; }
  .trail div:first-child { color: var(--text); opacity: .82; }
  .empty-state { color: var(--muted); padding: 40px 0; }
</style>
</head>
<body>
  <header>
    <div class="heading">
      <h1>Spaces</h1>
      <span class="sub">workspaces you and your agents share</span>
    </div>
    <span class="summary" id="summary"></span>
  </header>
  <div class="sections" id="grid"></div>
  <p class="note" id="note"></p>

<script>
const grid = document.getElementById("grid");
const note = document.getElementById("note");
const summary = document.getElementById("summary");
let busy = false;
let refreshInFlight = null;

const profileLabel = ${profileLabel.toString()};
const spacePriority = ${spacePriority.toString()};
const compareSpaces = ${compareSpaces.toString()};
const compareSpaceGroups = ${compareSpaceGroups.toString()};

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

/**
 * What the agent in this space is doing, over the thumbnail. The cursor itself
 * is only a few pixels at card scale, so the chip — not the crop — is what makes
 * activity readable at a glance.
 */
function liveChip(activity) {
  const chip = document.createElement("div");
  chip.className = "live-chip";
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
  wrap.className = "card";

  const frame = document.createElement("div");
  frame.className =
    "frame" + (space.thumbnail ? "" : " empty") + (space.activity ? " live" : "");
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
    frame.textContent = "no page yet";
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
  const dot = document.createElement("i");
  dot.className = "dot " + space.ownership;
  dot.title =
    space.ownership === "user"
      ? "yours"
      : space.ownership === "agentDelegatedToUser"
        ? "handed to you"
        : "an agent is working here";
  name.append(dot, document.createTextNode(space.name));

  const status = document.createElement("span");
  status.className = "status " + space.ownership;
  status.textContent =
    space.ownership === "agent"
      ? space.activity
        ? "Live"
        : "Agent"
      : space.ownership === "agentDelegatedToUser"
        ? "Your control"
        : "Personal";
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
  // take over gives it back. Shown on hover so a wall of cards stays calm.
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
  action.className = "ctl" + (agentOwned ? "" : " primary");
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

function addCard() {
  const wrap = document.createElement("div");
  wrap.className = "card";
  const button = document.createElement("button");
  button.className = "add";
  button.textContent = "+";
  button.title = "new space";
  button.addEventListener("click", async () => {
    const name = prompt("Name this space", "new space");
    if (name === null) return;
    await act("/api/spaces", "POST", { name: name.trim() || "new space" });
  });
  wrap.append(button);
  return wrap;
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
    await refresh();
  } catch (error) {
    note.textContent = "action failed: " + error.message;
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
  const title = document.createElement("span");
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
  if (withAddCard) body.append(addCard());

  wrap.append(head, body);
  return wrap;
}

async function loadSpaces() {
  try {
    const { spaces } = await api("/api/spaces");
    const groups = groupByProfile(spaces);
    const liveCount = spaces.filter((space) => space.activity).length;
    const profileCount = new Set(spaces.map((space) => space.profile).filter(Boolean)).size;
    summary.textContent = spaces.length
      ? spaces.length + " spaces · " + liveCount + " live · " + profileCount + " profiles"
      : "No spaces";

    if (!spaces.length) {
      const body = document.createElement("div");
      body.className = "grid";
      body.append(addCard());
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No spaces yet. Create one, or let an agent open its own.";
      grid.replaceChildren(empty, body);
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

function refresh() {
  if (!refreshInFlight) {
    refreshInFlight = loadSpaces().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// State-file writes and screencast frames wake the panel through EventSource.
// A slow reconciliation remains for missed filesystem events, activity expiry,
// and older browsers without EventSource support.
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

if ("EventSource" in window) {
  const events = new EventSource("/api/events");
  events.addEventListener("refresh", () => {
    if (!busy && !document.hidden) void refresh();
  });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !busy) void refresh();
});

refresh().then(schedule);
</script>
</body>
</html>
`;
