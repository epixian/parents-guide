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
import { SCHEMA_VERSION, type CategoryRating, type Report } from "../shared/types.js";
import type { WorkDetails } from "./catalog/types.js";
import { config } from "./config.js";
import { HttpError } from "./http.js";

/** Bump when the prompt or the category list changes. Stored in each cached result. */
export const PROMPT_VERSION = 2;

// The API does not enforce numeric ranges or enums inside nested objects; the
// SDK only checks them after the response arrives, and a failed check wastes
// the paid call. So accept loose values here and correct them in normalize().
const score = z.number().describe(`Integer from ${SCORE_MIN} to ${SCORE_MAX}`);
const treatment = z.string().describe(`One of: ${TREATMENTS.map((t) => t.id).join(", ")}`);

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
- positives lists up to five short positive elements, such as courage, honesty, sacrifice, forgiveness, faith, strong family bonds, or educational value. Use an empty list if there are none.
- The summary is three to five sentences: the overall content profile and the most important concerns.
- Set confidence to "high" if you know the work well, "medium" if you know it partly, and "low" if you rely mostly on the metadata. Never invent specific scenes you do not know about; with low confidence, say in the notes that details are uncertain.`;

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

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropicApiKey) throw new HttpError(503, "ANTHROPIC_API_KEY is not configured");
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

export async function classify(id: string, kind: Report["kind"], work: WorkDetails, now: Date): Promise<Report> {
  const anthropic = getClient();
  let response;
  try {
    response = await anthropic.messages.parse({
      model: config.model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Rate this work.\n\nCatalog metadata:\n${work.context.join("\n")}`,
        },
      ],
      output_config: { format: zodOutputFormat(outputSchema) },
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, "AI service is busy. Try again soon.");
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `AI request failed (${err.status ?? "network"})`);
    throw new HttpError(502, `AI output was not valid: ${(err as Error).message}`);
  }

  if (response.stop_reason === "refusal") throw new HttpError(502, "The AI declined to rate this work.");
  if (response.stop_reason === "max_tokens") throw new HttpError(502, "The AI response was cut off.");
  const out = response.parsed_output;
  if (!out) throw new HttpError(502, "The AI response could not be parsed.");

  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    kind,
    title: work.title,
    subtitle: work.subtitle,
    releaseDate: work.releaseDate,
    refreshedAt: now.toISOString(),
    model: response.model,
    promptVersion: PROMPT_VERSION,
    summary: out.summary,
    confidence: out.confidence,
    categories: normalizeCategories(out.categories),
    positives: out.positives.slice(0, 5),
  };
}
