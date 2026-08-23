#!/usr/bin/env node
import { connectCdp } from "../dist/cdp-bridge.js";
import { loadConfig } from "../dist/config.js";

const config = await loadConfig();
if (config.headless) {
  throw new Error("focus smoke requires a headed browser");
}
const cdp = await connectCdp(config.cdpPort);
const created = [];

async function visibility(targetId) {
  const sessionId = await cdp.attach(targetId);
  try {
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression: "document.visibilityState", returnByValue: true },
      sessionId,
    );
    return result?.result?.value;
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

try {
  const user = await cdp.send("Target.createTarget", {
    url: "data:text/html,<title>User%20view</title><h1>User%20view</h1>",
  });
  created.push(user.targetId);
  await cdp.send("Target.activateTarget", { targetId: user.targetId });

  const agentId = await cdp.createTarget(
    "data:text/html,<title>Agent%20view</title><h1>Agent%20view</h1>",
  );
  created.push(agentId);
  const before = await visibility(user.targetId);
  if (before !== "visible") {
    throw new Error(`background target stole focus (user=${before})`);
  }

  await cdp.send("Target.activateTarget", { targetId: agentId });
  const sessionId = await cdp.attach(agentId);
  try {
    await cdp.send("Page.bringToFront", {}, sessionId);
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
  const after = await visibility(agentId);
  if (after !== "visible") {
    throw new Error(`explicit presentation failed (agent=${after})`);
  }
  console.log(JSON.stringify({ ok: true, before, after }));
} finally {
  for (const targetId of created) {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  await cdp.close().catch(() => {});
}
