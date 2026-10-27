import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadEnvFile } from "../dist/src/env.js";

function withEnvFile(content, fn) {
  const envPath = join(
    tmpdir(),
    `ego-env-test-${process.pid}-${Date.now()}.env`,
  );
  writeFileSync(envPath, content, "utf8");
  try {
    return fn(envPath);
  } finally {
    try {
      unlinkSync(envPath);
    } catch {}
  }
}

test("loadEnvFile strips matching double quotes", () => {
  const key = `EGO_TEST_DQ_${Date.now()}`;
  withEnvFile(`${key}="hello world"\n`, (p) => loadEnvFile(p));
  assert.equal(process.env[key], "hello world");
  delete process.env[key];
});

test("loadEnvFile strips matching single quotes", () => {
  const key = `EGO_TEST_SQ_${Date.now()}`;
  withEnvFile(`${key}='hello world'\n`, (p) => loadEnvFile(p));
  assert.equal(process.env[key], "hello world");
  delete process.env[key];
});

test("loadEnvFile does not strip mismatched quotes", () => {
  const key = `EGO_TEST_MQ_${Date.now()}`;
  withEnvFile(`${key}="value'\n`, (p) => loadEnvFile(p));
  assert.equal(process.env[key], `"value'`);
  delete process.env[key];
});

test("loadEnvFile preserves unquoted values", () => {
  const key = `EGO_TEST_UQ_${Date.now()}`;
  withEnvFile(`${key}=plain_value\n`, (p) => loadEnvFile(p));
  assert.equal(process.env[key], "plain_value");
  delete process.env[key];
});
