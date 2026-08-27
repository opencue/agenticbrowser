import { createServer } from "node:http";

import { expectedState } from "./cases.mjs";

export async function startFixtureServer() {
  const states = new Map();
  const server = createServer(async (request, response) => {
    try {
      await route(request, response, states);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    stateFor(caseId, runId) {
      return structuredClone(ensureState(states, caseId, runId));
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Chromium can retain keep-alive sockets after the evaluated task space
        // closes. Do not let those fixture-only connections hold the report open.
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
    },
  };
}

async function route(request, response, states) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const runId = requiredParam(url, "run");

  if (url.pathname === "/api/save" && request.method === "POST") {
    const state = ensureState(states, "semantic-form", runId);
    const body = await jsonBody(request);
    state.saved = true;
    state.displayName = body.displayName;
    state.productUpdates = body.productUpdates === true;
    return json(response, { ok: true });
  }

  if (url.pathname === "/api/confirm" && request.method === "POST") {
    const state = ensureState(states, "dynamic-rerender", runId);
    state.confirmed = true;
    return json(response, { ok: true });
  }

  if (url.pathname === "/semantic-form") {
    ensureState(states, "semantic-form", runId);
    return html(response, semanticFormPage(runId));
  }

  if (url.pathname === "/dynamic-rerender") {
    ensureState(states, "dynamic-rerender", runId);
    return html(response, dynamicRerenderPage(runId));
  }

  if (url.pathname === "/viewport-extract") {
    const state = ensureState(states, "viewport-extract", runId);
    return html(response, viewportExtractPage(state.code));
  }

  if (url.pathname === "/new-tab") {
    const state = ensureState(states, "new-tab", runId);
    return html(response, newTabPage(runId, state.targetCode));
  }

  if (url.pathname === "/new-tab-target") {
    const state = ensureState(states, "new-tab", runId);
    state.targetVisited = true;
    return html(response, targetPage(state.targetCode));
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

function ensureState(states, caseId, runId) {
  const key = `${caseId}:${runId}`;
  if (!states.has(key)) {
    states.set(statesKey(caseId, runId), {
      caseId,
      runId,
      ...expectedState(caseId, runId),
    });
  }
  return states.get(key);
}

function statesKey(caseId, runId) {
  return `${caseId}:${runId}`;
}

function requiredParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`Missing ${name} query parameter`);
  return value;
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function json(response, value) {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function html(response, body) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ego agent eval</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 760px; margin: 32px auto; padding: 0 20px; }
    label { display: block; margin: 16px 0; }
    button, input { font: inherit; padding: 8px; }
    [role="status"] { margin-top: 16px; font-weight: 700; }
    .card { min-height: 72px; border: 1px solid #bbb; margin: 12px 0; padding: 12px; }
  </style>
</head>
<body>${body}</body>
</html>`);
}

function semanticFormPage(runId) {
  return `
<main>
  <h1>Contact preferences</h1>
  <form id="preferences">
    <label>Display name <input name="displayName" autocomplete="off"></label>
    <label><input name="productUpdates" type="checkbox"> Product updates</label>
    <button type="submit">Save settings</button>
  </form>
  <div role="status" id="status">Not saved</div>
</main>
<script>
  const runId = ${JSON.stringify(runId)};
  document.querySelector('#preferences').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await fetch('/api/save?run=' + encodeURIComponent(runId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: form.elements.displayName.value,
        productUpdates: form.elements.productUpdates.checked,
      }),
    });
    document.querySelector('#status').textContent = result.ok ? 'Saved' : 'Save failed';
  });
</script>`;
}

function dynamicRerenderPage(runId) {
  return `
<main>
  <h1>Generated item workflow</h1>
  <section id="step"><button id="load">Load next step</button></section>
  <div role="status" id="status">Waiting</div>
</main>
<script>
  const runId = ${JSON.stringify(runId)};
  document.querySelector('#load').addEventListener('click', () => {
    document.querySelector('#status').textContent = 'Loading';
    setTimeout(() => {
      document.querySelector('#step').innerHTML = '<button id="confirm">Confirm generated item</button>';
      document.querySelector('#status').textContent = 'Ready';
      document.querySelector('#confirm').addEventListener('click', async () => {
        const result = await fetch('/api/confirm?run=' + encodeURIComponent(runId), { method: 'POST' });
        document.querySelector('#status').textContent = result.ok ? 'Complete' : 'Failed';
      });
    }, 80);
  });
</script>`;
}

function viewportExtractPage(code) {
  const cards = Array.from(
    { length: 120 },
    (_, index) => `<article class="card">Archive row ${index + 1}</article>`,
  ).join("");
  return `
<main>
  <h1>Verification dashboard</h1>
  <p>The visible verification code is <strong>${escapeHtml(code)}</strong>.</p>
  ${cards}
</main>`;
}

function newTabPage(runId, targetCode) {
  const target = `/new-tab-target?run=${encodeURIComponent(runId)}`;
  return `
<main>
  <h1>Report launcher</h1>
  <a href="${target}" target="_blank">Open target report</a>
  <p>The report code is only shown in the target tab.</p>
  <span hidden>${escapeHtml(targetCode)}</span>
</main>`;
}

function targetPage(targetCode) {
  return `
<main>
  <h1>Target report</h1>
  <p>Target report code: <strong>${escapeHtml(targetCode)}</strong></p>
</main>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
