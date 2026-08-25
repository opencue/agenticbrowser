import { createTaskSpacesApi } from "../../src/task-spaces.mjs";

const index = Number(process.argv[2]);
const targetId = `worker-target-${process.pid}-${index}`;
const cdp = {
  async call(method) {
    if (method === "Target.createTarget") return { targetId };
    if (method === "Target.attachToTarget") {
      return { sessionId: `worker-session-${process.pid}-${index}` };
    }
    return {};
  },
};

await createTaskSpacesApi(cdp).createTaskSpace(`parallel-process-${index}`);
