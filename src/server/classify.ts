import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  CATEGORIES,
  SCORE_LABELS,
  SCORE_MAX,
  SCORE_MIN,
  TREATMENTS,
  type CategoryId,
  type TreatmentId,
} from "../shared/categories.js";
import { DEPTH_MAX, FEELING_MAX, MOOD_RULES, MOOD_VERSION, TONE_MAX } from "../shared/mood.js";
import { THEME_TAGS, normalizeThemeTags } from "../shared/themes.js";
import { SCHEMA_VERSION, type CategoryRating, type Mood, type Report, type WorkInfo } from "../shared/types.js";
import type { WorkDetails } from "./catalog/types.js";
import { config } from "./config.js";
import { HttpError } from "./http.js";
import { recordUsage } from "./usage.js";

/** Bump when the prompt or the category list changes. Stored in each cached result. */
export const PROMPT_VERSION = 6;

// The API does not enforce numeric ranges or enums inside nested objects; the
// SDK only checks them after the response arrives, and a failed check wastes
// the paid call. So accept loose values here and correct them in normalize().
const score = z.number().describe(`Integer from ${SCORE_MIN} to ${SCORE_MAX}`);
const treatment = z.string().describe(`One of: ${TREATMENTS.map((t) => t.id).join(", ")}`);

const moodSchema = z.object({
  tone: z.number().describe(`Integer from 1 to ${TONE_MAX}`),
  feeling: z.number().describe(`Integer from 1 to ${FEELING_MAX}`),
  depth: z.number().describe(`Integer from 1 to ${DEPTH_MAX}`),
  note: z.string(),
});

const plainRating = z.object({ score, notes: z.string() });
const treatedRating = z.object({ score, treatment, notes: z.string() });

const outputSchema = z.object({
  summary: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  categories: z.object(
    Object.fromEntries(CATEGORIES.map((c) => [c.id, c.hasTreatment ? treatedRating : plainRating])) as Record<
      CategoryId,
      typeof plainRating | typeof treatedRating
    >,
  ),
  positives: z.array(z.string()),
  themes: z.array(z.string()),
  theme_tags: z.array(z.string()).describe(`Two to five of: ${THEME_TAGS.join(", ")}`),
  mood: moodSchema,
  original_publisher: z.string(),
});

const SYSTEM_PROMPT = `You help parents decide whether a movie, TV season, or book is right for their child.
You rate the work for content that some parents may find objectionable or want to discuss.
Parents who use this service hold many different values, so your job is to describe, not to judge.

Rate every category below. Use an integer score from ${SCORE_MIN} to ${SCORE_MAX}:
${Object.entries(SCORE_LABELS)
  .map(([score, label]) => `- ${score}: ${label}`)
  .join("\n")}

The score reflects how much of the content is present and how prominent or graphic it is. It does not reflect whether the content is good or bad.

Categories:
${CATEGORIES.map((c) => `- ${c.id} (${c.label})${c.hasTreatment ? " [treatment]" : ""}: ${c.description}`).join("\n")}

Categories marked [treatment] also get a treatment: how the work as a whole presents that content.
${TREATMENTS.map((t) => `- ${t.id}: ${t.description}`).join("\n")}

Treatment rules:
- Use not_present if and only if the score is 0.
- Rate where the work ends up, not what individual characters say along the way. Example: a father rejects his gay son, and the film ends with acceptance -> approving. Put the characters' views in the notes.
- For moral messages, approving means the story rewards or excuses the wrongdoing; critical means it shows consequences or condemns it.
- For faith and religious people, approving means faith and believers are shown with respect or in a good light; critical means they are mocked or shown as harmful.
- A nonfiction work that argues for one position is approving or critical. One that lays out several positions is balanced.

Other rules:
- Use the catalog metadata provided and your own knowledge of the work.
- Be factual and neutral. Describe what is in the work; do not moralize or tell parents what to decide.
- In each category's notes, give one to three short sentences with specific examples (scenes, words, themes). Mild spoilers are acceptable when needed to describe content. If a score is 0, say briefly that the content is absent or negligible.
- themes lists three to six major themes of the work in a few words each, such as "grief and loss", "coming of age", "friendship", "redemption", or "power and corruption".
- theme_tags lists two to five tags from this fixed list that best match the major themes, spelled exactly as shown: ${THEME_TAGS.join(", ")}.
- original_publisher: for a book, the publisher of the first edition (e.g. "George Allen & Unwin" for The Hobbit), or an empty string if you are not sure. For movies and TV, always an empty string.
- positives lists up to five short positive elements, such as courage, honesty, sacrifice, forgiveness, faith, strong family bonds, or educational value. Use an empty list if there are none.
- The summary is three to five sentences: the overall content profile and the most important concerns.
- Set confidence to "high" if you know the work well, "medium" if you know it partly, and "low" if you rely mostly on the metadata. Never invent specific scenes you do not know about; with low confidence, say in the notes that details are uncertain.

${MOOD_RULES}`;

/** The AI knows original publishers better than Open Library's edition data does. */
function withPublisher(info: WorkInfo, publisher: string): WorkInfo {
  if (!publisher) return info;
  const others = info.credits.filter((c) => c.label !== "Publisher");
  return { ...info, credits: [...others, { label: "Publisher", entries: [{ name: publisher, url: null }] }] };
}

const TREATMENT_IDS = new Set<string>(TREATMENTS.map((t) => t.id));

/** Clamp scores, map treatment spellings to ids, and keep score and treatment consistent. */
export function normalizeCategories(
  raw: Record<string, { score: number; notes: string; treatment?: string }>,
): Record<CategoryId, CategoryRating> {
  const out = {} as Record<CategoryId, CategoryRating>;
  for (const c of CATEGORIES) {
    const r = raw[c.id] ?? { score: 0, notes: "" };
    const s = Math.min(SCORE_MAX, Math.max(SCORE_MIN, Math.round(Number(r.score) || 0)));
    let t: TreatmentId | null = null;
    if (c.hasTreatment) {
      const key = (r.treatment ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      t = TREATMENT_IDS.has(key) ? (key as TreatmentId) : "matter_of_fact";
      if (s === 0) t = "not_present";
      else if (t === "not_present") t = "matter_of_fact";
    }
    out[c.id] = { score: s, treatment: t, notes: r.notes };
  }
  return out;
}

/** Clamp to whole numbers on each scale; a non-number becomes the middle. A missing mood stays missing; it is not guessed. */
export function normalizeMood(
  raw: { tone: number; feeling: number; depth: number; note: string } | null | undefined,
): Mood | undefined {
  if (!raw) return undefined;
  const clamp = (n: number, max: number) => {
    const value = Number(n);
    return Number.isFinite(value) ? Math.min(max, Math.max(1, Math.round(value))) : Math.ceil(max / 2);
  };
  return {
    tone: clamp(raw.tone, TONE_MAX),
    feeling: clamp(raw.feeling, FEELING_MAX),
    depth: clamp(raw.depth, DEPTH_MAX),
    note: String(raw.note ?? "").trim(),
    version: MOOD_VERSION,
  };
}

let client: Anthropic | null = null;
export function getClient(): Anthropic {
  if (!config.anthropicApiKey) throw new HttpError(503, "ANTHROPIC_API_KEY is not configured");
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

const MAX_TOKENS = 8000;

function userMessage(work: WorkDetails): string {
  return `Rate this work.\n\nCatalog metadata:\n${work.context.join("\n")}`;
}

/** Request parameters for one rating. The batch script sends the same request at batch prices. */
export function buildRequest(work: WorkDetails): Anthropic.MessageCreateParamsNonStreaming {
  const format = zodOutputFormat(outputSchema);
  return {
    model: config.model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage(work) }],
    // Plain JSON schema (no parse helper), so the request can also go into a batch.
    output_config: { format: { type: "json_schema", schema: format.schema } },
  };
}

type Output = z.infer<typeof outputSchema>;

/** Turn the AI's JSON output into a saved result. */
function toReport(id: string, kind: Report["kind"], work: WorkDetails, now: Date, model: string, out: Output): Report {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    kind,
    title: work.title,
    subtitle: work.subtitle,
    releaseDate: work.releaseDate,
    refreshedAt: now.toISOString(),
    model,
    promptVersion: PROMPT_VERSION,
    summary: out.summary,
    confidence: out.confidence,
    categories: normalizeCategories(out.categories),
    positives: out.positives.slice(0, 5),
    themes: out.themes.slice(0, 6),
    themeTags: normalizeThemeTags(out.theme_tags).slice(0, 5),
    mood: normalizeMood(out.mood),
    info: withPublisher(work.info, kind === "book" ? out.original_publisher.trim() : ""),
  };
}

/** Check the stop reason, then parse the JSON text of a finished message with the given schema. */
function parseOutput<T extends z.ZodType>(message: Anthropic.Message, schema: T): z.infer<T> {
  if (message.stop_reason === "refusal") throw new HttpError(502, "The AI declined to rate this work.");
  if (message.stop_reason === "max_tokens") throw new HttpError(502, "The AI response was cut off.");
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new HttpError(502, "The AI response had no text.");
  try {
    return schema.parse(JSON.parse(text));
  } catch (err) {
    throw new HttpError(502, `AI output was not valid: ${(err as Error).message.slice(0, 200)}`);
  }
}

/** Build the saved result from a finished message. */
export function reportFromMessage(
  id: string,
  kind: Report["kind"],
  work: WorkDetails,
  now: Date,
  message: Anthropic.Message,
): Report {
  return toReport(id, kind, work, now, message.model, parseOutput(message, outputSchema));
}

/** One live API call, with errors turned into HTTP errors. Records the usage. */
async function send(id: string, params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  let message: Anthropic.Message;
  try {
    message = await getClient().messages.create(params);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, "AI service is busy. Try again soon.");
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `AI request failed (${err.status ?? "network"})`);
    throw new HttpError(502, `AI request failed: ${(err as Error).message}`);
  }
  await recordUsage({ id, mode: "live", model: message.model, usage: message.usage });
  return message;
}

export async function classify(id: string, kind: Report["kind"], work: WorkDetails, now: Date): Promise<Report> {
  return reportFromMessage(id, kind, work, now, await send(id, buildRequest(work)));
}

// ---------- Mood only ----------
// A light prompt that adds a mood to a result saved before moods existed. It
// sends the saved summary and themes, not the catalog data, so it is small:
// about 1,000 input tokens and 100 output tokens.

const MOOD_SYSTEM_PROMPT = `You help parents decide whether a movie, TV season, or book is right for their child.
Describe the mood of the work. Use the saved description below and your own knowledge of the work.

${MOOD_RULES}`;

const MOOD_KIND: Record<Report["kind"], string> = { movie: "Movie", "tv-season": "TV season", book: "Book" };

function moodUserMessage(r: Report): string {
  const lines = [
    `Title: ${r.title}${r.subtitle ? ` (${r.subtitle})` : ""}`,
    `Type: ${MOOD_KIND[r.kind]}`,
    r.info?.years ? `Years: ${r.info.years}` : "",
    `Summary of content: ${r.summary}`,
    r.themes?.length ? `Themes: ${r.themes.join("; ")}` : "",
    r.positives.length ? `Positive elements: ${r.positives.join("; ")}` : "",
  ];
  return `Describe the mood of this work.\n\n${lines.filter(Boolean).join("\n")}`;
}

/** Request parameters for the mood of a saved result. The backfill script sends the same request in a batch. */
export function buildMoodRequest(report: Report): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: config.model,
    max_tokens: 400,
    system: MOOD_SYSTEM_PROMPT,
    messages: [{ role: "user", content: moodUserMessage(report) }],
    output_config: { format: { type: "json_schema", schema: zodOutputFormat(moodSchema).schema } },
  };
}

export function moodFromMessage(message: Anthropic.Message): Mood {
  return normalizeMood(parseOutput(message, moodSchema))!;
}

/** Rate the mood of a saved result now (live price). */
export async function rateMood(report: Report): Promise<Mood> {
  return moodFromMessage(await send(report.id, buildMoodRequest(report)));
}
