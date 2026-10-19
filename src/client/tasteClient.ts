// The taste model for the page (see src/shared/taste.ts). A Web Worker scores
// every rated title, so the page stays responsive while it does (see
// tasteWorker.ts). The worker code is inline in the page's script, so it also
// works offline. Without workers, or when the worker fails, the page scores on
// its own thread, as before.

import { markSignals, MIN_MARKED, modelFromTable, signalsKey, tasteModel, type ScoreTable, type TasteModel, type Thumbs } from "../shared/taste.js";
import type { IndexEntry } from "../shared/types.js";
import { titleList } from "./titles.js";
import type { TasteReply, TasteRequest } from "./tasteWorker.js";
import TasteWorker from "./tasteWorker.ts?worker&inline";

let worker: Worker | null = null;
/** True after the worker failed once: the page then scores on its own thread. */
let broken = false;
/** The title list the worker has. */
let sent: readonly IndexEntry[] | null = null;
let next = 0;
const pending = new Map<number, { resolve: (table: ScoreTable | null) => void; reject: (err: Error) => void }>();

function fail(): void {
  broken = true;
  worker?.terminate();
  worker = null;
  sent = null;
  for (const p of pending.values()) p.reject(new Error("The taste worker failed"));
  pending.clear();
}

function getWorker(): Worker | null {
  if (broken || typeof Worker === "undefined") return null;
  if (!worker) {
    try {
      worker = new TasteWorker();
    } catch {
      broken = true;
      return null;
    }
    worker.onmessage = (e: MessageEvent<TasteReply>) => {
      pending.get(e.data.n)?.resolve(e.data.table);
      pending.delete(e.data.n);
    };
    worker.onerror = worker.onmessageerror = fail;
  }
  return worker;
}

function scoreInWorker(list: readonly IndexEntry[], signals: ReadonlyMap<string, number>): Promise<ScoreTable | null> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("No taste worker"));
  const n = ++next;
  const req: TasteRequest = { n, signals: [...signals] };
  // Only the fields the model reads: a much smaller copy than the whole list.
  if (sent !== list) req.titles = list.map(({ id, themeTags, genres, mood }) => ({ id, themeTags, genres, mood }));
  return new Promise((resolve, reject) => {
    pending.set(n, { resolve, reject });
    try {
      w.postMessage(req);
    } catch (err) {
      pending.delete(n);
      throw err;
    }
    // Only after the post: a failed post must send the list again next time.
    if (req.titles) sent = list;
  });
}

/** The model of each title list, for the last marks. */
const models = new WeakMap<readonly IndexEntry[], { key: string; model: Promise<TasteModel | null> }>();

/**
 * The taste model for the marks, or null (see tasteModel). index: from
 * titlesById. Kept for the title list until the marks change, so the home page
 * and the title pages share one scoring.
 */
export function tasteModelFor(
  index: Map<string, IndexEntry>,
  thumbs: Thumbs,
  notInterested: Readonly<Record<string, unknown>>,
): Promise<TasteModel | null> {
  const signals = markSignals(thumbs, notInterested);
  // Too few marks for a model: no need to start the worker.
  if (signals.size < MIN_MARKED) return Promise.resolve(null);
  const list = titleList(index);
  const key = signalsKey(signals);
  const kept = models.get(list);
  if (kept?.key === key) return kept.model;
  const model = scoreInWorker(list, signals).then(
    (table) => (table ? modelFromTable(table, index) : null),
    () => tasteModel(list, signals),
  );
  models.set(list, { key, model });
  return model;
}
