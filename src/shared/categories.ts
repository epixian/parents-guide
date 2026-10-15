// Concern categories. The AI prompt always covers every category; the client
// hides the ones a user marks as non-concern. Changing this list changes the
// AI output schema, so bump PROMPT_VERSION in src/server/classify.ts too.
//
// Descriptions are factual on purpose: the AI reports what a work contains
// and how it presents it, not whether that is good or bad. Parents with
// different values then read the same result and hide what they do not need.
//
// hasTreatment: the AI also reports how the work presents the content
// (see TREATMENTS). Only useful where the stance of the work varies.

export const CATEGORIES = [
  {
    id: "gods_name",
    label: "Misuse of God's name",
    description: "God, Jesus, or Christ used as a curse or exclamation, and other blasphemy.",
    hasTreatment: false,
  },
  {
    id: "profanity",
    label: "Profanity and crude language",
    description: "Swear words, vulgar words, insults, crude humor, and obscene gestures.",
    hasTreatment: false,
  },
  {
    id: "sexual_content",
    label: "Sexual content",
    description: "Sex scenes, sexual references, innuendo, and sex outside marriage.",
    hasTreatment: true,
  },
  {
    id: "nudity",
    label: "Nudity and immodesty",
    description: "Nudity, partial nudity, revealing clothing, and camera or narrative focus on bodies.",
    hasTreatment: false,
  },
  {
    id: "romance",
    label: "Romance",
    description: "Kissing, dating, crushes, and romantic relationships, at a level that matters for young children.",
    hasTreatment: false,
  },
  {
    id: "lgbtq",
    label: "LGBTQ characters and themes",
    description: "Gay, lesbian, bisexual, or transgender characters, same-sex relationships, and related themes.",
    hasTreatment: true,
  },
  {
    id: "gender",
    label: "Gender roles and identity",
    description: "Gender identity themes, and how the work portrays the roles of men and women (traditional or nontraditional).",
    hasTreatment: true,
  },
  {
    id: "spiritual",
    label: "Spiritual content",
    description: "Witchcraft, magic, the occult, demons, angels, the afterlife, and religions or spiritual practices other than Christianity.",
    hasTreatment: true,
  },
  {
    id: "faith",
    label: "Faith and religious people",
    description: "Christianity, the Bible, prayer, churches, clergy, and religious characters.",
    hasTreatment: true,
  },
  {
    id: "family",
    label: "Family and authority",
    description: "Disrespect for parents, rebellion, foolish or absent parents, divorce, adultery, and attitudes toward teachers, police, and other authority.",
    hasTreatment: true,
  },
  {
    id: "morals",
    label: "Moral messages",
    description: "Lying, stealing, cheating, revenge, and other wrongdoing, and whether the story rewards or punishes it.",
    hasTreatment: true,
  },
  {
    id: "violence",
    label: "Violence",
    description: "Physical violence, fighting, weapons use, injury, gore, and death.",
    hasTreatment: false,
  },
  {
    id: "war",
    label: "Depictions of war",
    description: "Combat, battle scenes, military conflict, atrocities, and their aftermath.",
    hasTreatment: true,
  },
  {
    id: "frightening",
    label: "Frightening and dark content",
    description: "Horror, the demonic, suspense, and disturbing or emotionally intense scenes that may upset children.",
    hasTreatment: false,
  },
  {
    id: "substances",
    label: "Drugs, alcohol, and smoking",
    description: "Use of, or humor about, alcohol, tobacco, vaping, or drugs.",
    hasTreatment: true,
  },
  {
    id: "mature_themes",
    label: "Mature themes",
    description: "Abortion, suicide, self-harm, euthanasia, abuse, and similar heavy subjects.",
    hasTreatment: true,
  },
  {
    id: "racism",
    label: "Racism and prejudice",
    description: "Racism, ethnic or religious prejudice, slurs, and other prejudice shown or discussed.",
    hasTreatment: true,
  },
  {
    id: "product_placement",
    label: "Product placement",
    description: "Visible brands, named products, and commercial tie-ins featured in the work.",
    hasTreatment: false,
  },
] as const;

export type Category = (typeof CATEGORIES)[number];
export type CategoryId = Category["id"];

// Score scale: integer 0-5. The score measures how much of the content is
// present and how prominent or graphic it is.
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

// How the work presents the content. Rated on where the work ends up, not on
// what individual characters say along the way.
export const TREATMENTS = [
  { id: "not_present", label: "Not present", description: "The content does not occur (score 0)." },
  { id: "critical", label: "Critical", description: "The work presents it negatively, as wrong, harmful, or cautionary." },
  { id: "balanced", label: "Balanced", description: "The work discusses it with more than one viewpoint, or takes no side." },
  { id: "matter_of_fact", label: "Matter-of-fact", description: "Present as an ordinary part of life, without comment or judgment." },
  { id: "approving", label: "Approving", description: "The work presents it positively, celebrates or rewards it, or argues for it." },
] as const;

export type TreatmentId = (typeof TREATMENTS)[number]["id"];
