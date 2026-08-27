import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SPACES_HTML,
  activityStatus,
  compareSpaceGroups,
  compareSpaces,
  profileLabel,
} from "../src/spaces-ui.mjs";

function space(name, ownership = "agent", activity = null) {
  return { name, ownership, activity };
}

describe("Spaces overview organization", () => {
  it("turns composite Cue profiles into readable section labels", () => {
    assert.equal(
      profileLabel("medusa-vite+medusa-stack+resend"),
      "Medusa-vite · Medusa-stack · Resend",
    );
    assert.equal(profileLabel(""), "Personal");
  });

  it("orders live and actionable spaces before idle agent spaces", () => {
    const spaces = [
      space("idle"),
      space("personal", "user"),
      space("handed-off", "agentDelegatedToUser"),
      space("recent", "agent", { ageMs: 45_000, live: false }),
      space("live", "agent", { ageMs: 10, live: true }),
    ];

    spaces.sort(compareSpaces);

    assert.deepEqual(
      spaces.map(({ name }) => name),
      ["live", "recent", "handed-off", "personal", "idle"],
    );
  });

  it("orders profile groups by their most important space and keeps Personal last", () => {
    const groups = [
      ["", [space("personal", "user")]],
      ["python", [space("idle")]],
      [
        "medusa-vite+resend",
        [space("live", "agent", { ageMs: 10, live: true })],
      ],
    ];

    groups.sort(compareSpaceGroups);

    assert.deepEqual(
      groups.map(([profile]) => profile),
      ["medusa-vite+resend", "python", ""],
    );
    assert.equal(compareSpaceGroups(groups[2], groups[2]), 0);
  });

  it("distinguishes a moving cursor from a recent one", () => {
    assert.equal(
      activityStatus(space("live", "agent", { ageMs: 10, live: true })),
      "Live",
    );
    assert.equal(
      activityStatus(
        space("thinking", "agent", { ageMs: 45_000, live: false }),
      ),
      "Recent",
    );
    assert.equal(activityStatus(space("idle")), "Agent");
  });

  it("ships the summary and denser responsive grid in the served page", () => {
    assert.match(SPACES_HTML, /id="summary"/);
    assert.match(SPACES_HTML, /id="inbox"/);
    assert.match(SPACES_HTML, /className = "card compact"/);
    assert.match(SPACES_HTML, /Needs You/);
    assert.match(SPACES_HTML, /minmax\(min\(100%, 310px\), 1fr\)/);
    assert.doesNotMatch(SPACES_HTML, /agents\.join\(" \+ "\) \|\| "Agent"/);
    const script = SPACES_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
  });

  it("authenticates API calls and server-sent updates with the fragment token", () => {
    assert.match(SPACES_HTML, /location\.hash\.slice\(1\)/);
    assert.match(SPACES_HTML, /sessionStorage\.setItem\("ego-spaces-token"/);
    assert.match(SPACES_HTML, /history\.replaceState/);
    assert.match(SPACES_HTML, /fetch\("\/api\/events"/);
    assert.match(SPACES_HTML, /\/api\/collaboration\/requests/);
    assert.match(SPACES_HTML, /Already answered/);
    assert.match(SPACES_HTML, /"x-ego-daemon-token": daemonToken/);
    assert.doesNotMatch(SPACES_HTML, /new EventSource/);
    assert.match(SPACES_HTML, /FALLBACK_POLL_MS = 15000/);
    assert.doesNotMatch(SPACES_HTML, /LIVE_POLL_MS|IDLE_POLL_MS/);
  });
});
