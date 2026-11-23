const fixture = process.env.FIXTURE_URL;

const alpha = await taskSpace("port smoke alpha");
const alphaPage = alpha.page("p1");
console.log(
  "1. created:      " +
    JSON.stringify({
      id: alpha.spaceId,
      name: alpha.name,
      ownership: alpha.ownership,
    }),
);

await alphaPage.goto(fixture);
await alphaPage.waitForLoadState();
console.log("2. alpha page:   " + (await alphaPage.title()));

const beta = await taskSpace("port smoke beta");
const betaPage = beta.page("p1");
console.log(
  "3. second space: " + JSON.stringify({ id: beta.spaceId, name: beta.name }),
);
await betaPage.goto("about:blank#beta");
console.log("4. beta page:    " + (await betaPage.url()));

// Switching back must put the agent on alpha's page again. In v2 each
// TaskSpace has its own page handles that resolve regardless of which space
// is currently selected.
console.log("5. back in alpha:" + (await alphaPage.title()));

console.log(
  "6. list:         " +
    JSON.stringify(
      (await listTaskSpaces()).map((s) => ({
        id: s.id,
        name: s.name,
        ownership: s.ownership,
      })),
    ),
);

// Handing off flips ownership the way the native overlay does.
await handOffTaskSpace(alpha.spaceId);
console.log(
  "7. after handOff:" +
    JSON.stringify((await listTaskSpaces()).map((s) => s.ownership)),
);

// Take over alpha (agentDelegatedToUser → agent) before finishing it.
const alphaTask = await takeOverTaskSpace(alpha.spaceId);
await alphaTask.finish({ keep: [] });
await beta.finish({ keep: [] });
console.log("8. after cleanup:" + JSON.stringify(await listTaskSpaces()));
