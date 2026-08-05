const fixture = process.env.FIXTURE_URL;
const HOST = "document.getElementById('ego-agent-cursor-overlay')";
const SHADOW = `${HOST}.__egoShadow`;
const probe = (expression) => page.evaluate(expression);

await page.goto(fixture);
await page.waitForLoadState();

const center = await page.elementCenter("loc=css:#click-button");
await page.mouse.click(center.x, center.y, { label: "counting" });

// The overlay is drawn fire-and-forget so it can never delay an action, which
// means the injection may still be in flight when the click returns.
for (let attempt = 0; attempt < 40; attempt += 1) {
  if (await probe(`!!${HOST}`)) break;
  await page.waitForTimeout(50);
}

console.log("1. overlay present:      " + (await probe(`!!${HOST}`)));

const transform = await probe(`${SHADOW}.getElementById('pointer').style.transform`);
// Drop the function name before reading the numbers — translate3d carries a 3.
const args = String(transform).replace(/^[^(]*\(/, "");
const [x, y] = (args.match(/-?[\d.]+/g) || []).map(Number);
console.log(
  "2. cursor tracks click:  " +
    (Math.abs(x - center.x) < 1 && Math.abs(y - center.y) < 1) +
    ` (${transform} vs ${center.x},${center.y})`,
);

console.log("3. badge text:           " + (await probe(`${SHADOW}.getElementById('text').textContent`)));

// The load-bearing property: pointer-events:none, so the harness's own
// elementFromPoint hit-tests (wheel and drag fallbacks) still see the page.
console.log("4. hit test at cursor:   " + (await probe(`document.elementFromPoint(${center.x}, ${center.y}).id`)));
console.log("5. click still landed:   " + (await probe("document.getElementById('count').textContent")));

const snap = await page.snapshotRaw({ scope: "full_page" });
console.log("6. overlay in snapshot:  " + snap.content.includes("ego-agent-cursor"));

// A wheel carries coordinates that default to (0, 0) but moves no pointer:
// following them would snap the cursor into the corner on every scroll.
await page.mouse.wheel(0, 200);
await page.waitForTimeout(200);
const afterScroll = await probe(`${SHADOW}.getElementById('pointer').style.transform`);
console.log("7. cursor held on wheel: " + (afterScroll === transform));

// Press and release are asserted apart, because a click's own press lasts 25ms
// — the held floor is what makes it visible, not something a test can catch.
const pressState = () => probe(`${SHADOW}.getElementById('pointer').className`);
await page.mouse.move(center.x, center.y);
await page.mouse.down();
await page.waitForTimeout(80);
console.log("8. pressed on down:      " + ((await pressState()) === "press"));

await page.mouse.up();
await page.waitForTimeout(400);
console.log("9. released on up:       " + ((await pressState()) === ""));
