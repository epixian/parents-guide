import assert from "node:assert/strict";
import { test } from "node:test";
import { s3Config } from "../src/server/config.js";

const KEYS = { S3_BUCKET: "b", S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret" };

test("s3Config is off without S3_BUCKET", () => {
  assert.equal(s3Config({}), null);
  assert.equal(s3Config({ S3_BUCKET: "  " }), null);
});

test("s3Config turns off, without throwing, when a key is missing", () => {
  assert.equal(s3Config({ S3_BUCKET: "b", S3_ACCESS_KEY_ID: "id" }), null);
  assert.equal(s3Config({ S3_BUCKET: "b", S3_SECRET_ACCESS_KEY: "secret" }), null);
});

test("s3Config turns off when S3_ENDPOINT is not an http or https URL", () => {
  assert.equal(s3Config({ ...KEYS, S3_ENDPOINT: "nyc3.digitaloceanspaces.com" }), null);
  assert.equal(s3Config({ ...KEYS, S3_ENDPOINT: "ftp://example.com" }), null);
});

test("s3Config reads good settings", () => {
  assert.deepEqual(s3Config({ ...KEYS, S3_ENDPOINT: "https://nyc3.digitaloceanspaces.com", S3_PREFIX: "/cache" }), {
    endpoint: "https://nyc3.digitaloceanspaces.com",
    region: "us-east-1",
    bucket: "b",
    accessKeyId: "id",
    secretAccessKey: "secret",
    prefix: "cache/",
    forcePathStyle: false,
  });
});
