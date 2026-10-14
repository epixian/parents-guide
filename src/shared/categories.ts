// Concern categories. The AI prompt always covers every category; the client
// hides the ones a user marks as non-concern. Changing this list changes the
// AI output schema, so bump PROMPT_VERSION in src/server/classify.ts too.

export const CATEGORIES = [
  {
    id: "violence",
    label: "Violence",
    description: "Physical violence, fighting, weapons use, injury, gore, or death.",
  },
  {
    id: "language",
    label: "Language",
    description: "Insults, slurs, name-calling, and crude or demeaning speech (other than swear words).",
  },
  {
    id: "profanity",
    label: "Profanity / vulgarity",
    description: "Swear words, obscene gestures, and vulgar or crude humor.",
  },
  {
    id: "war",
    label: "Depictions of war",
    description: "Combat, battle scenes, military conflict, atrocities, and their aftermath.",
  },
  {
    id: "sexual_content",
    label: "Sex scenes / sexual content",
    description: "Sex scenes, nudity, sexual references, innuendo, and romantic physical contact.",
  },
  {
    id: "gender_norms",
    label: "Gender norms",
    description:
      "How gender roles and norms are portrayed or discussed (traditional or nontraditional), including stereotypes, that parents may want to discuss.",
  },
  {
    id: "substances",
    label: "Drugs / alcohol / smoking",
    description: "Use, glamorization, or discussion of alcohol, tobacco, vaping, or drugs.",
  },
  {
    id: "frightening",
    label: "Frightening / intense scenes",
    description: "Scary, suspenseful, disturbing, or emotionally intense content that may upset children.",
  },
  {
    id: "self_harm",
    label: "Self-harm / suicide",
    description: "Depictions or discussion of self-harm, suicide, or suicidal thoughts.",
  },
  {
    id: "discrimination",
    label: "Discrimination",
    description: "Racism, sexism, homophobia, or other prejudice shown or discussed, and whether it is challenged.",
  },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

// Score scale: integer 0-5 (provisional default).
export const SCORE_MIN = 0;
export const SCORE_MAX = 5;
export const SCORE_LABELS: Record<number, string> = {
  0: "None",
  1: "Minimal",
  2: "Mild",
  3: "Moderate",
  4: "Strong",
  5: "Severe / explicit",
};
