import { test } from "node:test";
import assert from "node:assert/strict";
import { bookSubtitle } from "../src/server/catalog/openlibrary.js";

const eng = [{ key: "/languages/eng" }];

test("bookSubtitle uses the work's subtitle first, with a capital first letter", () => {
  assert.equal(bookSubtitle(" a novel in verse ", [{ subtitle: "Other" }]), "A novel in verse");
});

test("bookSubtitle uses an edition subtitle that more than half of the English editions share", () => {
  assert.equal(bookSubtitle(undefined, [{ subtitle: "the Graphic Novel" }]), "The Graphic Novel");
  assert.equal(
    bookSubtitle(undefined, [{ subtitle: "Book One", languages: eng }, { subtitle: "book one" }, { languages: eng }]),
    "Book One",
  );
  // French editions do not count.
  assert.equal(bookSubtitle(undefined, [{ subtitle: "Roman", languages: [{ key: "/languages/fre" }] }, {}]), null);
});

test("bookSubtitle leaves out rare and empty subtitles", () => {
  assert.equal(bookSubtitle(undefined, [{ subtitle: "Book One of the Lunar Chronicles" }, {}, {}]), null);
  assert.equal(bookSubtitle(undefined, [{ subtitle: "Chapters 1-5" }, {}]), null);
  assert.equal(bookSubtitle(undefined, [{ subtitle: "." }]), null);
  assert.equal(bookSubtitle(undefined, []), null);
});
