import { test } from "node:test";
import assert from "node:assert/strict";
import { isbnFromBarcode } from "../src/shared/isbn.js";

test("isbnFromBarcode accepts an EAN-13 that starts with 978 or 979 and has a valid check digit", () => {
  assert.equal(isbnFromBarcode("9780547928227"), "9780547928227");
  assert.equal(isbnFromBarcode(" 9791032305690 "), "9791032305690");
  assert.equal(isbnFromBarcode("9780547928228"), null); // Wrong check digit.
});

test("isbnFromBarcode rejects store barcodes", () => {
  assert.equal(isbnFromBarcode("036000291452"), null); // UPC-A
  assert.equal(isbnFromBarcode("0036000291452"), null); // UPC-A read as EAN-13
  assert.equal(isbnFromBarcode("4006381333931"), null); // EAN-13, not a book
  assert.equal(isbnFromBarcode("96385074"), null); // EAN-8
});
