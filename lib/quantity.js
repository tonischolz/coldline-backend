/*
  Parses free-text quantity strings into a weight in pounds, so capacity
  can be tracked consistently even though bags come in two sizes
  (Coldline: large bag = 16 lb, small bag = 7 lb).

  Handles:
    "200 lbs" / "200 lb" / "200 pounds"      -> 200 (size doesn't matter)
    "20 large bags" / "5 small bags"         -> looked up from clientConfig
    "20 bags" (no size) + a known productName -> uses that product's weight
    "20 bags" (no size, no product known)     -> unclear: true (must ask)

  Returns { lbs, unclear }. Callers should treat unclear: true as "ask the
  customer which bag size they mean" rather than guessing.
*/
export function parseQuantityToLbs(quantityText, clientConfig, productName) {
  if (!quantityText) return { lbs: null, unclear: true };
  const text = String(quantityText).toLowerCase();

  // Direct pounds - unambiguous regardless of bag size.
  const lbsMatch = text.match(/([\d.]+)\s*(lbs?|pounds?)\b/);
  if (lbsMatch) {
    return { lbs: parseFloat(lbsMatch[1]), unclear: false };
  }

  // Bag count, optionally with a size word: "20 large bags", "5 small bags", "10 bags"
  const bagMatch = text.match(/([\d.]+)\s*(large|small)?\s*bags?/);
  if (bagMatch) {
    const count = parseFloat(bagMatch[1]);
    const sizeWord = bagMatch[2]; // "large" | "small" | undefined

    let product = null;
    if (sizeWord) {
      product = clientConfig.products.find((p) => p.size === sizeWord);
    } else if (productName) {
      product = clientConfig.products.find(
        (p) => p.name.toLowerCase() === productName.toLowerCase()
      );
    }

    if (product) {
      return { lbs: count * product.weightLbs, unclear: false };
    }
    return { lbs: null, unclear: true }; // bag count given, but size still unknown
  }

  return { lbs: null, unclear: true };
}
