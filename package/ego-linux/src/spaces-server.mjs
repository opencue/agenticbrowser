import { createServer } from "node:http";

import { CURSOR_PROBE_EXPRESSION } from "./cursor.mjs";
import { SPACES_HTML } from "./spaces-ui.mjs";

/**
 * The Spaces overview.
 *
 * Upstream draws this inside the browser's own chrome, which a Chromium fork can
 * do and a stock Chromium cannot: Chrome 137 removed --load-extension, and the
 * CDP Extensions domain reports "Method not available", so nothing can inject UI
 * into the tab strip from outside. What is reachable is an --app window: no tab
 * strip, no toolbar, its own app_id — a standalone panel that behaves like part
 * of the browser.
 *
 * The server is the only source of truth's front door: it reads and writes the
 * same task-space state file the CLI uses, so the overview and the agent never
 * disagree about which spaces exist.
 */

const THUMBNAIL = {
  format: "jpeg",
  quality: 60,
};

/** How long after its last pointer event a space still counts as being worked in. */
const ACTIVE_WINDOW_MS = 30_000;

/** The crop used while an agent is active. Matches the card's 16/10 frame. */
const FOLLOW = { width: 760, aspect: 16 / 10 };

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/** Where the agent's cursor is in this page, or null if none has acted here. */
async function readCursor(cdp, sessionId) {
  try {
    const { result } = await cdp.call(
      "Runtime.evaluate",
      { expression: CURSOR_PROBE_EXPRESSION, returnByValue: true },
      sessionId,
    );
    return result?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * A crop centred on the cursor, clamped to the visible viewport.
 *
 * A full-page thumbnail scaled into a ~294px card renders the cursor about five
 * pixels wide, which reads as "nothing is happening" even while the agent is
 * clicking. Cropping to where it is working makes the activity legible; the
 * clamp keeps the rect inside what captureBeyondViewport:false actually paints.
 */
function followClip(cursor) {
  const width = Math.min(FOLLOW.width, cursor.viewportWidth);
  const height = Math.min(width / FOLLOW.aspect, cursor.viewportHeight);
  const left = clamp(cursor.x - width / 2, 0, cursor.viewportWidth - width);
  const top = clamp(cursor.y - height / 2, 0, cursor.viewportHeight - height);
  // The overlay is viewport-fixed; the clip is in page coordinates.
  return {
    x: left + cursor.scrollX,
    y: top + cursor.scrollY,
    width,
    height,
    scale: 1,
  };
}

async function captureCard(cdp, targetId) {
  try {
    const { sessionId } = await cdp.call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    try {
      const cursor = await readCursor(cdp, sessionId);
      const active = Boolean(cursor) && cursor.ageMs < ACTIVE_WINDOW_MS;
      const shot = await cdp.call(
        "Page.captureScreenshot",
        {
          format: THUMBNAIL.format,
          quality: THUMBNAIL.quality,
          captureBeyondViewport: false,
          ...(active ? { clip: followClip(cursor) } : {}),
        },
        sessionId,
      );
      return {
        thumbnail: shot.data ? `data:image/jpeg;base64,${shot.data}` : null,
        activity: active
          ? { name: cursor.name, label: cursor.label, ageMs: Math.round(cursor.ageMs) }
          : null,
        // The trail outlives the activity window: what a space did five minutes
        // ago is exactly what you want to know about one that has gone quiet.
        trail: cursor?.trail?.slice(-3).reverse() ?? [],
      };
    } finally {
      await cdp.call("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  } catch {
    return { thumbnail: null, activity: null, trail: [] };
  }
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * Start the overview server.
 * @param {object} shim The live ego shim (ego + cdp).
 * @returns {Promise<{port:number, close:() => void}>}
 */
export async function startSpacesServer(shim) {
  const { ego, cdp } = shim;

  const server = createServer(async (request, response) => {
    // Bound to loopback, but a page in the agent's own browser can still reach
    // it, so only same-origin callers get to act.
    const origin = request.headers.origin;
    if (origin && !origin.startsWith("http://127.0.0.1:")) {
      json(response, 403, { error: "cross-origin request refused" });
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/") {
      const html = SPACES_HTML;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
      });
      response.end(html);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/spaces") {
      const { taskSpaces = [] } = await ego.listTaskSpaces();
      // Deliberately NOT ego.listTabs(): that is scoped to the selected space,
      // which is right for an agent (it should only see its own tabs) and wrong
      // for an overview of every space — every non-selected card would report
      // zero tabs, no title and no thumbnail. The panel needs the whole browser.
      const { targetInfos = [] } = await cdp.call("Target.getTargets");
      const byTarget = new Map(
        targetInfos
          .filter((target) => target.type === "page")
          .map((target) => [target.targetId, target]),
      );

      const spaces = await Promise.all(
        taskSpaces.map(async (space) => {
          const live = (space.targetIds || []).filter((id) => byTarget.has(id));
          const lead = live[0];
          const card = lead
            ? await captureCard(cdp, lead)
            : { thumbnail: null, activity: null, trail: [] };
          return {
            id: space.id,
            name: space.name,
            ownership: space.ownership,
            profile: space.profile || null,
            session: space.session || null,
            tabCount: live.length,
            title: lead ? byTarget.get(lead).title : "",
            url: lead ? byTarget.get(lead).url : "",
            thumbnail: card.thumbnail,
            activity: card.activity,
            trail: card.trail,
          };
        }),
      );
      json(response, 200, { spaces });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/spaces") {
      const { name } = await readBody(request);
      const space = await ego.createTaskSpace(name || "new space");
      json(response, 200, { space });
      return;
    }

    // takeover / stop are the panel's half of the ownership handshake the
    // native app puts on its Space overlay: stop hands the space back to you
    // (the agent's cursor goes away), takeover claims it for the agent again.
    const match = /^\/api\/spaces\/(\d+)\/(use|close|stop|takeover)$/.exec(url.pathname);
    if (request.method === "POST" && match) {
      const id = Number(match[1]);
      if (match[2] === "use") {
        await ego.useTaskSpace(id);
      } else if (match[2] === "stop") {
        await ego.handOffTaskSpace(id);
      } else if (match[2] === "takeover") {
        await ego.takeOverTaskSpace(id);
      } else {
        await ego.closeTaskSpace(id);
      }
      json(response, 200, { done: true });
      return;
    }

    json(response, 404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => server.close(),
  };
}
