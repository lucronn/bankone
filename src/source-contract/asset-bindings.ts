import { decodeHTML, decodeHTMLAttribute } from "entities";
import { Parser } from "htmlparser2";
import { targetForUrl, type AssetTarget } from "../content/url-rewriter.js";

export type AssetBinding = { source_url: string; resource_ref: string };
const MAX_BINDINGS = 128;

// Match the ingestion runtime's Python 3.14 HTMLParser attribute semantics.
// Numeric references use html.unescape; named references use attribute mode.
function decodeSourceAttribute(value: string): string {
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)[;=]?/g, (reference: string, entity: string) => {
    if (entity[0] === "#") {
      const numeric = entity.slice(1);
      const codepoint = numeric[0]?.toLowerCase() === "x" ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
      // html.unescape drops these invalid numeric codepoints; mapped C1 values
      // and U+0000 are left to the HTML5 decoder below.
      if ((codepoint >= 1 && codepoint <= 8) || codepoint === 11 || codepoint === 12
        || (codepoint >= 14 && codepoint <= 31) || codepoint === 127
        || (codepoint >= 0xfdd0 && codepoint <= 0xfdef)
        || (codepoint <= 0x10ffff && (codepoint & 0xffff) >= 0xfffe)) return "";
    }
    return entity[0] === "#" ? decodeHTML(reference) : decodeHTMLAttribute(reference);
  });
}

/** Bind only actual image sources; never interpret provider-supplied ref attributes. */
export function collectAssetBindings(
  html: string,
  upstreamOrigin: string,
  register: (target: AssetTarget) => string | undefined,
): AssetBinding[] {
  const bindings: AssetBinding[] = [];
  const seen = new Set<string>();
  let source: string | undefined;
  const parser = new Parser({
    onopentagname() { source = undefined; },
    onattribute(name, value) {
      // HTMLParser produces all attributes and dict(attrs) keeps the last one.
      if (name === "src") source = decodeSourceAttribute(value);
    },
    onopentag(name) {
      if (name !== "img" || !source || source.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/.test(source)
        || bindings.length >= MAX_BINDINGS || seen.has(source)) return;
      const target = targetForUrl(source, { upstreamOrigin, connectorAssetUrl: () => "" });
      if (!target) return;
      const reference = register(target);
      if (!reference || reference.length > 2048) return;
      seen.add(source);
      bindings.push({ source_url: source, resource_ref: reference });
    },
  }, { decodeEntities: false });
  parser.end(html);
  return bindings;
}
