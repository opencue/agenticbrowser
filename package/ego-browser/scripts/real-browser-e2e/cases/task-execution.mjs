export function taskExecutionCase() {
  return `
    const executionName = taskName + " verified executor";
    let workCalls = 0;
    let verifyCalls = 0;

    const out = await taskSpaces.execute(executionName, {
      goal: "load and verify the real-browser fixture",
      risk: "read-only",
      retries: { max: 1, delay: 50, on: ["verification"] },
      keep: false,
      timeout: 10000,

      async work({ attempt }) {
        workCalls += 1;
        await page.goto(baseUrl + "/?execute-attempt=" + attempt, {
          waitUntil: "load",
          timeout: 10000,
        });
        const info = await page.info();
        return { attempt, url: info.url, title: info.title };
      },

      async verify({ result, attempt }) {
        verifyCalls += 1;
        const fixtureVisible = await page.locator("#click-button").isVisible();
        return {
          ok:
            attempt === 2 &&
            fixtureVisible &&
            result.url.startsWith(baseUrl + "/"),
          evidence: {
            forcedFirstFailurePassed: attempt === 2,
            fixtureVisible,
            url: result.url,
            title: result.title,
          },
        };
      },
    });

    assertEqual(workCalls, 2, "taskSpaces.execute retries read-only work once");
    assertEqual(verifyCalls, 2, "taskSpaces.execute verifies every attempt");
    assertEqual(out.attempts, 2, "taskSpaces.execute reports the successful attempt");
    assertEqual(out.result.attempt, 2, "taskSpaces.execute returns the verified work result");
    assertEqual(out.result.title, "ego-lite helper e2e", "taskSpaces.execute reads the live fixture title");
    assertEqual(out.verification.ok, true, "taskSpaces.execute returns verified success");
    assertEqual(out.verification.evidence.fixtureVisible, true, "taskSpaces.execute returns live verification evidence");
    assertEqual(out.receipt.status, "verified", "taskSpaces.execute marks its receipt verified");
    assertEqual(
      out.receipt.attempts.map((attempt) => attempt.outcome).join(","),
      "verification-failed,verified",
      "taskSpaces.execute records failed and successful verification outcomes"
    );
    assertEqual(out.completion.done, true, "taskSpaces.execute completes after verification");

    const spaces = await taskSpaces.list();
    assert(
      !spaces.some((space) => space.name === executionName),
      "taskSpaces.execute removes its completed task space"
    );

    await assertRejects(
      () =>
        taskSpaces.execute(taskName + " unsafe retry", {
          risk: "reversible",
          retries: { max: 1 },
          work() {},
          verify() {
            return true;
          },
        }),
      'automatic retries require risk: "read-only"',
      "taskSpaces.execute rejects automatic retries for mutating work"
    );
  `;
}
