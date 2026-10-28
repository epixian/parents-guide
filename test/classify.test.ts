import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { CATEGORIES } from "../src/shared/categories.js";
import { hasMood } from "../src/shared/mood.js";
import type { Mood } from "../src/shared/types.js";
import type { WorkDetails } from "../src/server/catalog/types.js";
import {
  bookCategoriesFromMessage,
  buildBookCategoriesRequest,
  buildMoodRequest,
  buildRequest,
  moodFromMessage,
  normalizeMood,
  reportFromMessage,
} from "../src/server/classify.js";
import { estimateCost } from "../src/server/usage.js";

const work: WorkDetails = {
  title: "Test Movie",
  subtitle: null,
  releaseDate: "2020-05-01",
  released: true,
  context: ["Type: movie", "Title: Test Movie"],
  info: { years: "2020", rating: null, credits: [], imageUrl: null, source: null },
};

function message(text: string, stop: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    stop_reason: stop,
    // Haiku 5.5 thinks by default: the answer comes after an (empty) thinking block.
    content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }],
    usage: { input_tokens: 3000, output_tokens: 1500 },
  } as unknown as Anthropic.Message;
}

const output = {
  summary: "A short test summary.",
  confidence: "high",
  categories: Object.fromEntries(
    CATEGORIES.map((c) => [c.id, c.hasTreatment ? { score: 1, treatment: "Critical", notes: "n" } : { score: 2, notes: "n" }]),
  ),
  positives: ["courage"],
  themes: ["friendship"],
  theme_tags: ["Friendship", "not-a-tag"],
  mood: { tone: 4.4, feeling: 9, depth: 1.6, note: " Warm and gentle. " },
  original_publisher: "",
  book_categories: [],
};

test("buildRequest uses a plain JSON schema, so it also works in a batch", () => {
  const req = buildRequest(work);
  assert.equal(req.model, "claude-haiku-5-5");
  assert.equal(req.output_config?.effort, "high");
  // Haiku 5.5 must use its own knowledge (summaries leave out storylines), and keep doubts out of the summary.
  assert.match(String(req.system), /Do not score a category 0 only because the metadata does not mention it/);
  assert.match(String(req.system), /never in the summary/);
  assert.equal(req.thinking, undefined); // Adaptive thinking, the default.
  assert.ok(req.max_tokens >= 16000);
  const format = req.output_config?.format as { type: string; schema: unknown; parse?: unknown };
  assert.equal(format.type, "json_schema");
  assert.equal(typeof format.schema, "object");
  assert.equal(format.parse, undefined);
});

test("reportFromMessage builds a normalized report", () => {
  const report = reportFromMessage("tmdb-movie-1", "movie", work, new Date("2026-10-14T00:00:00Z"), message(JSON.stringify(output)));
  assert.equal(report.title, "Test Movie");
  assert.equal(report.categories.lgbtq.treatment, "critical");
  assert.equal(report.categories.violence.treatment, null);
  assert.deepEqual(report.themeTags, ["friendship"]);
  assert.deepEqual(report.mood, { tone: 4, feeling: 5, depth: 2, note: "Warm and gentle.", version: 2 });
  assert.equal(report.refreshedAt, "2026-10-14T00:00:00.000Z");
});

test("reportFromMessage keeps book categories for books only", () => {
  const out = JSON.stringify({ ...output, book_categories: ["Young Adult", "fiction", "fantasy", "middle-grade", "made-up"] });
  const at = new Date();
  const book = reportFromMessage("ol-OL1W", "book", work, at, message(out));
  assert.deepEqual(book.bookCategories, ["young-adult", "fiction", "fantasy"]);
  const movie = reportFromMessage("tmdb-movie-1", "movie", work, at, message(out));
  assert.equal("bookCategories" in movie, false);
});

test("buildBookCategoriesRequest sends the saved summary and the category list; bookCategoriesFromMessage normalizes", () => {
  const report = reportFromMessage("ol-OL1W", "book", work, new Date(), message(JSON.stringify(output)));
  const req = buildBookCategoriesRequest(report);
  assert.equal(req.output_config?.effort, "low");
  assert.match(String(req.system), /graphic-novel/);
  assert.match(JSON.stringify(req.messages), /A short test summary/);
  const answer = message(JSON.stringify({ book_categories: ["Graphic Novel", "nonfiction", "Biography & Memoir"] }));
  assert.deepEqual(bookCategoriesFromMessage(answer), ["nonfiction", "graphic-novel", "biography-memoir"]);
});

test("reportFromMessage rejects refusals, cut-off output, and bad JSON", () => {
  const at = new Date();
  assert.throws(() => reportFromMessage("x", "movie", work, at, message("{}", "refusal")), /declined/);
  assert.throws(() => reportFromMessage("x", "movie", work, at, message("{}", "max_tokens")), /cut off/);
  assert.throws(() => reportFromMessage("x", "movie", work, at, message("not json")), /not valid/);
});

test("estimateCost uses Haiku prices and halves batch requests", () => {
  const usage = { input_tokens: 3000, output_tokens: 1500 };
  const live = estimateCost({ id: "x", mode: "live", model: "claude-haiku-5-5", usage })!;
  assert.ok(Math.abs(live - 0.00105) < 1e-9);
  // Older usage lines keep their Haiku 4.5 price.
  assert.ok(Math.abs(estimateCost({ id: "x", mode: "live", model: "claude-haiku-4-5", usage })! - 0.0105) < 1e-9);
  assert.ok(Math.abs(estimateCost({ id: "x", mode: "batch", model: "claude-haiku-5-5", usage })! - live / 2) < 1e-9);
  assert.equal(estimateCost({ id: "x", mode: "live", model: "other-model", usage }), null);
});

test("normalizeMood rounds and clamps each scale to 1-5, adds the version, and keeps a missing mood missing", () => {
  assert.deepEqual(normalizeMood({ tone: 0, feeling: 1.6, depth: 0, note: "x" }), { tone: 1, feeling: 2, depth: 1, note: "x", version: 2 });
  assert.deepEqual(normalizeMood({ tone: 9, feeling: 7, depth: 9, note: "" }), { tone: 5, feeling: 5, depth: 5, note: "", version: 2 });
  assert.deepEqual(normalizeMood({ tone: Number.NaN, feeling: Number.NaN, depth: Number.NaN, note: "" }), {
    tone: 3,
    feeling: 3,
    depth: 3,
    note: "",
    version: 2,
  });
  assert.equal(normalizeMood(undefined), undefined);
  assert.equal(normalizeMood(null), undefined);
});

test("buildMoodRequest sends the saved summary and themes, with a small JSON schema", () => {
  const saved = reportFromMessage("tmdb-tv-1-s02", "tv-season", { ...work, subtitle: "Season 2" }, new Date(), message(JSON.stringify(output)));
  const req = buildMoodRequest(saved);
  assert.equal(req.model, "claude-haiku-5-5");
  assert.equal(req.output_config?.effort, "low");
  // Room for thinking, which counts toward max_tokens.
  assert.ok(req.max_tokens >= 2000);
  assert.match(String(req.system), /tone \(1 to 5\)/);
  assert.match(String(req.system), /feeling \(1 to 5\)/);
  const user = String(req.messages[0]?.content);
  assert.match(user, /Title: Test Movie \(Season 2\)/);
  assert.match(user, /Type: TV season/);
  assert.match(user, /Summary of content: A short test summary\./);
  assert.match(user, /Themes: friendship/);
  const format = req.output_config?.format as { type: string; schema: { properties: Record<string, unknown> } };
  assert.equal(format.type, "json_schema");
  assert.deepEqual(Object.keys(format.schema.properties).sort(), ["depth", "feeling", "note", "tone"]);
  assert.match(String(req.system), /depth \(1 to 5\)/);
});

test("moodFromMessage normalizes the mood and rejects bad output", () => {
  assert.deepEqual(moodFromMessage(message(JSON.stringify({ tone: 2, feeling: 4.2, depth: 3, note: "Sad but warm." }))), {
    tone: 2,
    feeling: 4,
    depth: 3,
    note: "Sad but warm.",
    version: 2,
  });
  assert.throws(() => moodFromMessage(message("{}", "refusal")), /declined/);
  assert.throws(() => moodFromMessage(message(JSON.stringify({ tone: 2 }))), /not valid/);
});

test("hasMood needs the current version, so moods on older scales are rated again", () => {
  assert.equal(hasMood({ mood: { tone: 4, feeling: 3, depth: 2, note: "", version: 2 } }), true);
  // Version 1 (feeling 1-3) saved no version.
  assert.equal(hasMood({ mood: { tone: 4, feeling: 3, depth: 2, note: "" } }), false);
  assert.equal(hasMood({ mood: { tone: 4, feeling: 3, note: "" } as unknown as Mood }), false);
  assert.equal(hasMood({}), false);
});
