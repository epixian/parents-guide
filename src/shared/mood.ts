// Mood: the feel of the whole work, shown as three bars in the Summary
// section. Tone (1-5, shown as "Outlook") runs from bleak to uplifting,
// feeling (1-3, shown as "Pull") from low-key to strong, and depth (1-5)
// from silly to profound. Both the full rating prompt and the light
// backfill prompt use MOOD_RULES, so they cannot drift apart.

import type { Mood } from "./types.js";

export const TONE_MAX = 5;
export const FEELING_MAX = 3;
export const DEPTH_MAX = 5;

export const TONE_LABELS: Record<number, string> = {
  1: "Bleak",
  2: "Somber",
  3: "Even",
  4: "Hopeful",
  5: "Uplifting",
};

export const FEELING_LABELS: Record<number, string> = {
  1: "Low-key",
  2: "Moderate",
  3: "Strong",
};

export const DEPTH_LABELS: Record<number, string> = {
  1: "Silly",
  2: "Lighthearted",
  3: "Moderate",
  4: "Thoughtful",
  5: "Profound",
};

/** True when the result has a complete mood. Moods saved before depth existed have no depth. */
export function hasMood(r: { mood?: Mood }): r is { mood: Mood } {
  return typeof r.mood?.depth === "number";
}

export const MOOD_RULES = `mood describes the feel of the work as a whole, on three separate integer scales.

tone (1 to ${TONE_MAX}): where the work leaves the audience overall. Weigh the ending most, but count the journey too.
- 1 bleak: despairing or crushing, little or no hope (e.g. Grave of the Fireflies, The Road).
- 2 somber: serious, sad, or heavy, with some light (e.g. Schindler's List, Bridge to Terabithia).
- 3 even: neither heavy nor uplifting, such as a light mystery or a documentary; or sad and hopeful in equal measure (bittersweet, e.g. Charlotte's Web, Toy Story 3).
- 4 hopeful: warm and optimistic; troubles are real but overcome (e.g. Coco, Wonder).
- 5 uplifting: joyful, inspiring, feel-good throughout (e.g. Paddington 2, Mamma Mia!).

feeling (1 to ${FEELING_MAX}): how strongly the work is likely to stir the audience's emotions, such as sadness, tenderness, joy, or grief. It is not excitement, suspense, action, or fear: a tense thriller or a jump-scare horror film can be low on feeling.
- 1 low-key: little emotional pull (e.g. a light sitcom, a heist caper, a reference book).
- 2 moderate: some moving moments, but not the focus.
- 3 strong: deeply affecting; likely to move many people to tears (e.g. Up, The Fault in Our Stars).

depth (1 to ${DEPTH_MAX}): how much the work gives the audience to think about: ideas, questions, and meaning. It is not emotion: a tearjerker romance can be lighthearted, and a calm documentary can be profound.
- 1 silly: pure fun; nothing to think about afterwards (e.g. Minions, a slapstick comedy). Nonfiction is never 1.
- 2 lighthearted: mostly fun, with a small, simple message such as "be kind" (e.g. Paddington, Kung Fu Panda).
- 3 moderate: some ideas worth discussing, but not the focus (e.g. Shrek, Harry Potter and the Sorcerer's Stone).
- 4 thoughtful: real ideas about people or the world are a main part of the work (e.g. Wonder, Zootopia).
- 5 profound: serious ideas about life, morality, or society are central (e.g. To Kill a Mockingbird, Schindler's List).

A bittersweet work is tone 3 with feeling 3. Rate the three scales independently.
note: one short sentence that explains the values.`;
