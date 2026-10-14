import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CATEGORIES, SCORE_LABELS, SCORE_MAX, SCORE_MIN, type CategoryId } from "../shared/categories.js";
import type { CategoryRating, Report } from "../shared/types.js";
import type { WorkDetails } from "./catalog/types.js";
import { config } from "./config.js";
import { HttpError } from "./http.js";

/** Bump when the prompt or the category list changes. Stored in each cached result. */
export const PROMPT_VERSION = 1;

const rating = z.object({
  score: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  notes: z.string(),
});

const outputSchema = z.object({
  summary: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  categories: z.object(
    Object.fromEntries(CATEGORIES.map((c) => [c.id, rating])) as Record<CategoryId, typeof rating>,
  ),
});

const SYSTEM_PROMPT = `You help parents decide whether a movie, TV season, or book is right for their child.
You rate the work for content that some parents may find objectionable or want to discuss.

Rate every category below. Use an integer score from ${SCORE_MIN} to ${SCORE_MAX}:
${Object.entries(SCORE_LABELS)
  .map(([score, label]) => `- ${score}: ${label}`)
  .join("\n")}

The score reflects how much of the content is present and how prominent or graphic it is.

Categories:
${CATEGORIES.map((c) => `- ${c.id} (${c.label}): ${c.description}`).join("\n")}

Rules:
- Use the catalog metadata provided and your own knowledge of the work.
- Be factual and neutral. Describe what is in the work; do not moralize or tell parents what to decide.
- In each category's notes, give one to three short sentences with specific examples (scenes, words, themes). Mild spoilers are acceptable when needed to describe content. If a score is 0, say briefly that the content is absent or negligible.
- The summary is three to five sentences: the overall content profile and the most important concerns.
- Set confidence to "high" if you know the work well, "medium" if you know it partly, and "low" if you rely mostly on the metadata. Never invent specific scenes you do not know about; with low confidence, say in the notes that details are uncertain.`;

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
      max_tokens: 4000,
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
    schemaVersion: 1,
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
    categories: out.categories as Record<CategoryId, CategoryRating>,
  };
}
