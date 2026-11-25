import { decodeHTML, decodeHTMLAttribute } from "entities";
import { Parser } from "htmlparser2";
import { targetForUrl, type AssetTarget } from "../content/url-rewriter.js";

export type AssetBinding = { source_url: string; resource_ref: string };
export type ArticleLinkBinding = { source_id_sha256: string; target_ref_sha256: string };
const MAX_BINDINGS = 128;
const RESOURCE_ATTRIBUTES = new Map([
  ["img", "src"], ["a", "href"], ["iframe", "src"], ["object", "data"], ["embed", "src"],
]);
const NONDISPLAY_TAGS = new Set(["iframe", "noscript", "object", "script", "style", "template"]);
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\b/i;

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

/** Bind authored markup to connector references while preserving the input bytes. */
export function collectMarkupBindings(
  html: string,
  upstreamOrigin: string,
  register: (target: AssetTarget) => string | undefined,
  bindArticle: (id: string) => ArticleLinkBinding | undefined,
): { assets: AssetBinding[]; articles: ArticleLinkBinding[] } {
  const assets: AssetBinding[] = [];
  const articles: ArticleLinkBinding[] = [];
  const seenAssets = new Set<string>();
  const seenArticleIds = new Set<string>();
  const visibility: boolean[] = [];
  let documentLink: boolean;
  let documentId: string | undefined;
  let duplicateId: boolean;
  let hidden: boolean;
  let resourceAttribute: string | undefined;
  let source: string | undefined;
  const parser = new Parser({
    onopentagname(name) {
      resourceAttribute = RESOURCE_ATTRIBUTES.get(name);
      source = undefined;
      documentLink = name === "mtr-doc-link";
      documentId = undefined;
      duplicateId = false;
      hidden = (visibility.at(-1) ?? false) || NONDISPLAY_TAGS.has(name);
    },
    onattribute(name, value) {
      // HTMLParser produces all attributes and dict(attrs) keeps the last one.
      if (name === resourceAttribute) source = decodeSourceAttribute(value);
      if (documentLink && name === "id") {
        duplicateId = documentId !== undefined;
        documentId = decodeSourceAttribute(value);
      }
      if (name === "hidden" || (name === "aria-hidden" && decodeSourceAttribute(value).trim().toLowerCase() === "true")
        || (name === "style" && HIDDEN_STYLE.test(decodeSourceAttribute(value)))) hidden = true;
    },
    onopentag(name) {
      visibility.push(hidden);
      if (documentId && !hidden && !duplicateId && articles.length < MAX_BINDINGS
        && documentId.length <= 512 && documentId.trim() === documentId
        && !/[\u0000-\u001f\u007f-\u009f]/.test(documentId) && !seenArticleIds.has(documentId)) {
        const binding = bindArticle(documentId);
        if (binding) {
          seenArticleIds.add(documentId);
          articles.push(binding);
        }
      }
      if (!source || source.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/.test(source)
        || assets.length >= MAX_BINDINGS || seenAssets.has(source)) return;
      const target = targetForUrl(source, { upstreamOrigin, connectorAssetUrl: () => "" });
      if (!target || (name !== "img" && target.kind !== "asset")) return;
      const reference = register(target);
      if (!reference || reference.length > 2048) return;
      seenAssets.add(source);
      assets.push({ source_url: source, resource_ref: reference });
    },
    onclosetag() { visibility.pop(); },
  }, { decodeEntities: false });
  parser.end(html);
  return { assets, articles };
}
