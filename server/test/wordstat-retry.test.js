import test from "node:test";
import assert from "node:assert/strict";
import { requestWordstatTop, WordstatRateLimitError, normalizeWordstatResponse } from "../wordstat.js";
process.env.YANDEX_API_KEY = "test-secret-not-real";
process.env.YANDEX_FOLDER_ID = "test-folder-not-real";
const time = Date.parse("2026-11-16T11:00:00Z");
const quota = (body, headers = {}, attempt = 0) => requestWordstatTop({ phrase: "seed", quotaAttempt: attempt }, {
  now: () => time, fetchImpl: async () => new Response(JSON.stringify(body), { status: 429, headers }),
});
test("429 fallback backs off from one minute to fifteen, and never exposes raw errors", async () => {
  for (const [attempt, seconds] of [[0, 60], [1, 120], [2, 240], [3, 480], [4, 900], [100, 900]]) {
    await assert.rejects(quota({ message: "test-secret-not-real" }, {}, attempt), error => {
      assert.ok(error instanceof WordstatRateLimitError);
      assert.equal(error.retryAt, time + seconds * 1000);
      assert.equal(error.diagnostics.retrySource, "fallback");
      assert.ok(!JSON.stringify(error).includes("test-secret-not-real"));
      assert.ok(!error.message.includes("test-secret-not-real"));
      return true;
    });
  }
});
test("explicit Retry-After wins over RetryInfo, and RetryInfo wins over fallback", async () => {
  const body = { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "9.5s" }] };
  await assert.rejects(quota(body, { "retry-after": "3600", "x-request-id": "fixture-id" }), error => {
    assert.equal(error.retryAt, time + 3600000);
    assert.equal(error.diagnostics.retrySource, "retry-after");
    assert.equal(error.diagnostics.requestId, "fixture-id");
    return true;
  });
  await assert.rejects(quota(body), error => error.retryAt === time + 9500 && error.diagnostics.retrySource === "retry-info");
  await assert.rejects(quota({ details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: { seconds: "12", nanos: 500000000 } }] }), error => error.retryAt === time + 12500);
  await assert.rejects(quota({ details: [{ "@type": "other", retryDelay: "1s" }] }), error => error.retryAt === time + 60000);
});
test("diagnostics classifies an upstream hourly quota without copying its message", async () => {
  await assert.rejects(quota({ message: "Quota exceeded: wordstatRequestsPerHour.rate; test-secret-not-real" }), error => {
    assert.equal(error.diagnostics.reportedQuotaScope, "hour");
    assert.ok(!JSON.stringify(error).includes("test-secret-not-real"));
    return true;
  });
});
test("valid ProtoJSON defaults are zero, while malformed and error payloads stay errors", async () => {
  assert.deepEqual(normalizeWordstatResponse({}), { totalCount: "0", results: [], associations: [] });
  const result = await requestWordstatTop({ phrase: "none" }, { fetchImpl: async () => Response.json({}) });
  assert.equal(result.totalCount, "0");
  assert.equal(normalizeWordstatResponse({ totalCount: "5", results: [{ phrase: "zero" }] }).results[0].count, "0");
  for (const invalid of [null, [], { error: "bad" }, { message: "bad" }, { totalCount: null }, { totalCount: "-1" }, { results: null }, { results: [{}] }]) {
    assert.throws(() => normalizeWordstatResponse(invalid));
  }
});
