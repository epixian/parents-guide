// Scores every rated title for the taste model, off the page's thread, so the
// page stays responsive (see tasteClient.ts). It keeps the last title list, so
// the page sends the list only when it changes.

import { scoreTable, type ScoreTable, type TasteTitle } from "../shared/taste.js";

export interface TasteRequest {
  /** Matches the reply to the request. */
  n: number;
  /** A new title list; left out when it is the same as in the last request. */
  titles?: TasteTitle[];
  signals: [string, number][];
}

export interface TasteReply {
  n: number;
  table: ScoreTable | null;
}

// The DOM types have no worker scope: give self the two members used here.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<TasteRequest>) => void) | null;
  postMessage(reply: TasteReply, transfer: Transferable[]): void;
};

let titles: TasteTitle[] = [];

scope.onmessage = (e) => {
  if (e.data.titles) titles = e.data.titles;
  const table = scoreTable(titles, new Map(e.data.signals));
  scope.postMessage({ n: e.data.n, table }, table ? [table.scores.buffer, table.unmarked.buffer] : []);
};
