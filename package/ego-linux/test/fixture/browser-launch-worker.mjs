import { ensureBrowser } from "../../src/chrome.mjs";

const result = await ensureBrowser({ headless: true });
process.stdout.write(`${JSON.stringify(result)}\n`);
