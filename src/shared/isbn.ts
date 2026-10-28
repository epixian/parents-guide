// The barcode on the back of a book is its ISBN-13 as an EAN-13: 13 digits
// that start with 978 or 979. Other retail barcodes (UPC-A on many US
// mass-market paperbacks, EAN-8, UPC-E) do not give the ISBN.

/** True when the last digit of the EAN-13 is its check digit. */
function validEan13(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

/** The ISBN-13 in a scanned barcode, or null when the barcode is not an ISBN. */
export function isbnFromBarcode(text: string): string | null {
  const digits = text.trim();
  return /^97[89]\d{10}$/.test(digits) && validEan13(digits) ? digits : null;
}
