import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CookieJar } from "../../src/auth/cookie-jar.js";
import type { AuthAdapter, AuthenticatedSession } from "../../src/auth/auth-adapter.js";
import { SessionManager } from "../../src/auth/session-manager.js";
import { loadConfig } from "../../src/config.js";
import type { HttpTransport } from "../../src/http/http-client.js";
import { createApp } from "../../src/server.js";
import { decodeReference, encodeReference } from "../../src/source-contract/references.js";
import { UpstreamApiClient } from "../../src/upstream/upstream-client.js";

const config = loadConfig({
  UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
  UPSTREAM_PROMPT_VALUE: "synthetic-prompt",
  SESSION_ENCRYPTION_KEY: "a".repeat(64),
  SOURCE_REF_ACTIVE_KEY_ID: "v1",
  SOURCE_REF_KEYS_JSON: JSON.stringify({ v1: "b".repeat(64) }),
  PUBLIC_BASE_URL: "https://bankone.cars.tk",
});
const session: AuthenticatedSession = {
  source: "server",
  cookieJar: CookieJar.fromSetCookie(["SessionIdentifier=synthetic; Path=/"], 1_700_000_000),
  createdAt: 1_700_000_000,
};
const adapter: AuthAdapter = { authenticate: async () => session, validate: async () => ({ valid: true }) };
const store = { load: async () => session, save: async () => undefined };
function json(body: unknown) {
  return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ header: { statusCode: 200 }, body })) };
}
async function appWithTransport(transport: HttpTransport, appConfig = config) {
  return createApp({
    config: appConfig,
    upstreamClient: new UpstreamApiClient(appConfig, transport),
    sessionManager: new SessionManager(adapter, store, { refreshSkewSeconds: 300 }),
  });
}

const fordSelector = { year: 2016, make: "Ford Truck", model: "Expedition 4wd", configuration: "3.5 L 4WD", region: "US" };
const fordModelId = "2016%3AFord%3AExpedition";
const fordEnginesPath = `/m1/api/source/Ford/${fordModelId}/motorvehicles`;

describe("Bankone source contract", () => {
  it("resolves ambiguous model trims to stable opaque vehicle references", async () => {
    const paths: string[] = [];
    const app = await appWithTransport(async (request) => {
      paths.push(new URL(request.url).pathname);
      if (request.url.endsWith("/year/2024/makes")) return json([{ makeName: "Toyota" }]);
      if (request.url.endsWith("/year/2024/make/Toyota/models")) return json([{ modelName: "4Runner Base", vehicleIds: ["v1", "v2"] }]);
      if (request.url.includes("/source/Toyota/vehicles")) return json([{ vehicleId: "v1", vehicleName: "4Runner Base" }, { vehicleId: "v2", vehicleName: "4Runner SR5" }]);
      throw new Error(`Unexpected upstream request: ${request.url}`);
    });
    const first = await app.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: { year: 2024, make: "Toyota", model: "4 Runner 4wd" } });
    const second = await app.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: { year: 2024, make: "Toyota", model: "4 Runner 4wd" } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ provider: "bankone", selector: { year: 2024, make: "Toyota", model: "4 Runner 4wd" } });
    expect(first.json().candidates).toHaveLength(2);
    expect(first.json().candidates.map((candidate: { opaque_ref: string }) => candidate.opaque_ref)).toEqual(second.json().candidates.map((candidate: { opaque_ref: string }) => candidate.opaque_ref));
    expect(first.json().candidates[0].opaque_ref).not.toContain("vehicleId");
    expect(paths).toContain("/m1/api/source/Toyota/vehicles");
    await app.close();
  });

  it("excludes vehicle rows with an explicitly conflicting market or displacement", async () => {
    const app = await appWithTransport(async (request) => {
      if (request.url.endsWith("/year/2016/makes")) return json([{ makeName: "Ford" }]);
      if (request.url.endsWith("/year/2016/make/Ford/models")) {
        return json([{ modelName: "Expedition", vehicleIds: ["us", "ca", "different-engine", "unmarked"] }]);
      }
      if (request.url.includes("/source/Motor/vehicles")) return json([
        { vehicleId: "us", vehicleName: "Expedition 3.5L 4WD", region: "United States" },
        { vehicleId: "ca", vehicleName: "Expedition 3.5L 4WD", market: "CA" },
        { vehicleId: "different-engine", vehicleName: "Expedition 13.5L 4WD", engineDescription: "13.5 L", region: "US" },
        { vehicleId: "unmarked", vehicleName: "Expedition 3.5L 4WD" },
      ]);
      throw new Error(`Unexpected fixture route: ${new URL(request.url).pathname}`);
    });
    try {
      const resolve = async (region?: string, configuration?: string) => {
        const response = await app.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: {
          year: 2016, make: "Ford Truck", model: "Expedition 4WD", region, configuration,
        } });
        expect(response.statusCode).toBe(200);
        return response.json().candidates.map((candidate: { opaque_ref: string }) =>
          decodeReference(candidate.opaque_ref, config.sourceRefs, "vehicle").vehicleId);
      };
      expect(await resolve("US", "3.5L 4WD")).toEqual(["us", "unmarked"]);
      expect(await resolve("Canada", "3.5L 4WD")).toEqual(["ca", "unmarked"]);
      expect(await resolve(undefined, "3.5L 4WD")).toEqual(["us", "ca", "unmarked"]);
      expect(await resolve("US")).toEqual(["us", "different-engine", "unmarked"]);
    } finally {
      await app.close();
    }
  });

  it("resolves a Ford Expedition engine to the scoped Motor vehicle and opens its articles", async () => {
    const requests: Parameters<HttpTransport>[0][] = [];
    const engineIds = ["12345:678", "12345:679", "12345:680", "12345:681"];
    const motorVehiclesPath = "/m1/api/source/Motor/vehicles";
    const selectedVehiclePath = "/m1/api/source/Motor/vehicle/12345%3A678";
    const vehicle = {
      vehicleId: engineIds[0],
      vehicleName: "Expedition 3.5L 4WD",
      engineDescription: "3.5 L",
      drivetrain: "4WD",
      region: "US",
    };
    const articleHtml = "<h1>Oil Pump Replacement</h1>";
    const app = await appWithTransport(async (request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/m1/api/year/2016/makes") return json([{ makeName: "Ford" }]);
      if (path === "/m1/api/year/2016/make/Ford/models") {
        return json({ contentSource: "Ford", models: [{ id: fordModelId, model: "Expedition" }] });
      }
      if (path === fordEnginesPath) {
        return json([{ model: "Expedition", engines: engineIds.map((id) => ({ id, name: "Expedition engine" })) }]);
      }
      if (path === motorVehiclesPath) {
        return json([
          { ...vehicle, vehicleId: "99999:999" },
          { ...vehicle, vehicleId: engineIds[1], region: "CA" },
          { ...vehicle, vehicleId: engineIds[2], drivetrain: "RWD" },
          { ...vehicle, vehicleId: engineIds[3], engineDescription: "5.0 L" },
          vehicle,
        ]);
      }
      if (path === `${selectedVehiclePath}/articles/v2`) return json({ articleDetails: [{ id: "a1", title: "Oil Pump Replacement" }] });
      if (path === `${selectedVehiclePath}/article/a1`) return json({ html: articleHtml });
      throw new Error(`Unexpected fixture route: ${path}`);
    });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: fordSelector });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ provider: "bankone", selector: fordSelector });
      const { candidates } = response.json();
      expect(candidates).toHaveLength(1);
      const { opaque_ref: vehicleRef } = candidates[0];
      expect(decodeReference(vehicleRef, config.sourceRefs, "vehicle")).toEqual({ kind: "vehicle", catalog: "Motor", vehicleId: "12345:678" });

      const workshopSelection = await app.inject({
        method: "POST", url: "/v1/vehicle-resolutions", payload: { ...fordSelector, configuration: "3.5 L" },
      });
      expect(workshopSelection.statusCode, workshopSelection.body).toBe(200);
      expect(workshopSelection.json().candidates).toHaveLength(1);
      expect(workshopSelection.json().candidates[0].opaque_ref).toBe(vehicleRef);

      const list = await app.inject({ method: "GET", url: `/v1/vehicles/${vehicleRef}/articles` });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().articles).toMatchObject([{ title: "Oil Pump Replacement" }]);
      const [article] = list.json().articles;
      const content = await app.inject({ method: "GET", url: `/v1/resources/${article.resource_ref}` });
      expect(content.statusCode, content.body).toBe(200);
      expect(content.json().content).toBe(articleHtml);

      const legacyFord = await app.inject({ method: "GET", url: `/v1/api/catalog/Ford/${fordModelId}/vehicle-details` });
      expect(legacyFord.statusCode).toBe(400);
      expect(legacyFord.json().error.code).toBe("invalid_request");
      expect(requests.map((request) => {
        const url = new URL(request.url);
        return `${request.method} ${url.pathname}${url.search}`;
      })).toEqual([
        "GET /m1/api/year/2016/makes",
        "GET /m1/api/year/2016/make/Ford/models",
        `GET ${fordEnginesPath}`,
        `POST ${motorVehiclesPath}`,
        `GET ${selectedVehiclePath}/articles/v2`,
        `GET ${selectedVehiclePath}/article/a1`,
      ]);
      const batch = requests.find((request) => request.method === "POST")!;
      expect(batch.headers?.["content-type"]).toMatch(/^application\/json\b/i);
      expect(JSON.parse(batch.body!.toString())).toEqual({ vehicleIds: engineIds });
    } finally {
      await app.close();
    }
  });

  it.each([
    { reason: "missing Ford model ID", model: { model: "Expedition" }, engines: undefined, status: 502 },
    { reason: "double-encoded Ford model ID", model: { id: "2016%253AFord%253AExpedition", model: "Expedition" }, engines: undefined, status: 502 },
    { reason: "missing Motor engine ID", model: { id: fordModelId, model: "Expedition" }, engines: [{ name: "3.5 L 4WD" }], status: 502 },
    { reason: "untrusted Motor engine ID", model: { id: fordModelId, model: "Expedition" }, engines: [{ id: fordModelId, name: "3.5 L 4WD" }], status: 502 },
    { reason: "explicitly empty Ford engine list", model: { id: fordModelId, model: "Expedition" }, engines: [], status: 200 },
  ])("distinguishes vehicle availability with $reason", async ({ model, engines, status }) => {
    const paths: string[] = [];
    const app = await appWithTransport(async (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/m1/api/year/2016/makes") return json([{ makeName: "Ford" }]);
      if (path === "/m1/api/year/2016/make/Ford/models") return json({ contentSource: "Ford", models: [model] });
      if (path === fordEnginesPath && engines !== undefined) return json([{ model: "Expedition", engines }]);
      throw new Error(`Unexpected fixture route: ${path}`);
    });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: fordSelector });
      expect(response.statusCode, response.body).toBe(status);
      if (status === 200) {
        expect(response.json().candidates).toEqual([]);
      } else {
        expect(response.json().error.code).toBe("INVALID_UPSTREAM_RESPONSE");
        expect(response.json()).not.toHaveProperty("candidates");
      }
      expect(paths).toEqual([
        "/m1/api/year/2016/makes",
        "/m1/api/year/2016/make/Ford/models",
        ...(engines === undefined ? [] : [fordEnginesPath]),
      ]);
    } finally {
      await app.close();
    }
  });

  it.each([
    { reason: "partial Motor batch", batchComplete: false, nameStatus: 200 },
    { reason: "no drivetrain", batchComplete: true, nameStatus: 200 },
    { reason: "name not found", batchComplete: true, nameStatus: 404 },
    { reason: "different model", batchComplete: true, nameStatus: 200, name: "2016 Ford F-150 3.5 L 4WD" },
    { reason: "malformed wrapper", batchComplete: true, nameStatus: 200, name: { value: ["Expedition 3.5 L 4WD"] } },
    { reason: "repeated name", batchComplete: true, nameStatus: 200, name: "Expedition 3.5 L 4WD", lookupBoth: true },
  ])("does not treat incomplete Ford details as absent ($reason)", async ({ batchComplete, nameStatus, name, lookupBoth }) => {
    const app = await appWithTransport(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/m1/api/year/2016/makes") return json([{ makeName: "Ford" }]);
      if (path === "/m1/api/year/2016/make/Ford/models") {
        return json({ contentSource: "Ford", models: [{ id: fordModelId, model: "Expedition" }] });
      }
      if (path === fordEnginesPath) {
        return json([{ model: "Expedition", engines: [
          { id: "12345:678", name: "3.5 L" }, { id: "12345:679", name: "3.5 L" },
        ] }]);
      }
      if (path === "/m1/api/source/Motor/vehicles") {
        return json({ items: [
          { vehicleId: "12345:678", model: "Expedition", engineDescription: "3.5 L" },
          ...(batchComplete ? [{ vehicleId: "12345:679", model: "Expedition", ...(lookupBoth ? {} : { drivetrain: "2WD" }) }] : []),
        ] });
      }
      if (path === `/m1/api/source/Ford/${fordModelId}/name`)
        return { ...json(name ?? "Expedition 3.5 L"), status: nameStatus };
      throw new Error("Unexpected fixture route");
    });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: fordSelector });
      expect(response.statusCode, response.body).toBe(502);
      expect(response.json().error.code).toBe("INVALID_UPSTREAM_RESPONSE");
      expect(response.json().error.message).toBe(batchComplete
        ? "Ford lookup lacks required vehicle details"
        : "Motor lookup did not confirm the mapped engines");
    } finally {
      await app.close();
    }
  });

  it("uses the supplier name for the mapped engine and keeps catalog labels tied to source data", async () => {
    const checkedNames: string[] = [];
    const ids = ["12345:678", "12346:678", "12347:678", "12348:678", "12349:678"];
    const app = await appWithTransport(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/m1/api/year/2016/makes") return json([{ makeName: "Ford" }]);
      if (url.pathname === "/m1/api/year/2016/make/Ford/models")
        return json({ contentSource: "Ford", models: [{ id: fordModelId, model: "Expedition" }] });
      if (url.pathname === fordEnginesPath) return json([
        { model: "Expedition XLT", engines: [{ id: ids[0], name: "3.5 L V6" }, { id: ids[1], name: "3.5 L V6" }] },
        { model: "Expedition XL", engines: [{ id: ids[2], name: "3.5 L V6" }] },
        { engines: [{ id: ids[3] }] },
        { model: "Expedition Touring", engines: [{ id: ids[4], name: "3.5 L V6" }] },
      ]);
      if (url.pathname === "/m1/api/source/Motor/vehicles")
        return json(ids.map((vehicleId) => ({ vehicleId })));
      if (url.pathname === `/m1/api/source/Ford/${fordModelId}/name`) {
        const id = url.searchParams.get("motorVehicleId") ?? "";
        checkedNames.push(id);
        if (id === ids[0]) return json({ value: "Expedition XLT 4-Wheel Drive" });
        if (id === ids[1]) return json("Expedition XLT RWD");
        if (id === ids[2]) return json("Expedition XL 4x4 5.0 L");
        if (id === ids[3]) return json("Expedition Limited 2WD 3.5 L");
        if (id === ids[4]) return json("Expedition Touring 4x4 / 4x2");
      }
      throw new Error("Unexpected fixture route");
    });
    try {
      const catalog = await app.inject({
        method: "GET", url: "/v1/catalog/configurations?year=2016&make=Ford%20Truck&model=Expedition%204wd",
      });
      expect(catalog.statusCode, catalog.body).toBe(200);
      const { items } = catalog.json();
      expect(items.map((item: { label: string }) => item.label)).toEqual([
        "Expedition XLT 3.5 L V6", "Expedition XLT 3.5 L V6", "Expedition XL 3.5 L V6",
        "2016 Ford Truck configuration", "Expedition Touring 3.5 L V6",
      ]);
      expect(items[0].configuration).toBe(items[0].label);
      expect(items[3]).not.toHaveProperty("configuration");
      expect(checkedNames).toEqual([]);

      const response = await app.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: fordSelector });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().candidates).toEqual([expect.objectContaining({ label: "Expedition XLT 4-Wheel Drive" })]);
      expect(response.json().candidates[0].opaque_ref).toBe(items[0].opaque_ref);
      expect(checkedNames.sort()).toEqual(ids);
    } finally {
      await app.close();
    }
  });

  it("paginates catalog data and binds the cursor to its scope", async () => {
    const app = await appWithTransport(async () => json(Array.from({ length: 101 }, (_, year) => 1900 + year)));
    const first = await app.inject({ method: "GET", url: "/v1/catalog/years" });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(100);
    expect(first.json().complete).toBe(false);
    expect(first.json().next_cursor.length).toBeLessThan(512);
    const next = await app.inject({ method: "GET", url: `/v1/catalog/years?cursor=${encodeURIComponent(first.json().next_cursor)}` });
    expect(next.json().items).toHaveLength(1);
    expect(next.json().complete).toBe(true);
    const wrongScope = await app.inject({ method: "GET", url: `/v1/catalog/makes?year=2024&cursor=${encodeURIComponent(first.json().next_cursor)}` });
    expect(wrongScope.statusCode).toBe(400);
    expect(wrongScope.json().error.code).toBe("INVALID_INPUT");
    await app.close();
  });

  it("rejects a page cursor after the source revision changes", async () => {
    const firstApp = await appWithTransport(async () => json(Array.from({ length: 101 }, (_, year) => 1900 + year)));
    const first = await firstApp.inject({ method: "GET", url: "/v1/catalog/years" });
    await firstApp.close();
    const secondApp = await appWithTransport(async () => json(Array.from({ length: 101 }, (_, year) => 1901 + year)));
    const next = await secondApp.inject({ method: "GET", url: `/v1/catalog/years?cursor=${encodeURIComponent(first.json().next_cursor)}` });
    expect(next.statusCode).toBe(409);
    expect(next.json().error.message).toMatch(/restart pagination/);
    await secondApp.close();
  });

  it("projects vehicle articles and returns hashed article, labor, and binary resources", async () => {
    const app = await appWithTransport(async (request) => {
      if (request.url.includes("/articles/v2")) return json({ articleDetails: [{ id: "a1", title: "Water Pump Replacement", bucketName: "Cooling", component: "Pump", laborArticleId: "a1", graphicIds: ["g1"] }] });
      if (request.url.includes("/article/a1")) return json({ html: "<h1>Water Pump Replacement</h1><mtr-image id=\"g1\"></mtr-image>" });
      if (request.url.includes("/labor/a1")) return json({ hours: 1.5 });
      if (request.url.includes("/graphic/g1")) return { status: 200, headers: { "content-type": "image/png" }, body: Buffer.from([0, 1, 2]) };
      throw new Error(`Unexpected upstream request: ${request.url}`);
    });
    const vehicleRef = encodeReference({ kind: "vehicle", catalog: "Toyota", vehicleId: "v1" }, config.sourceRefs);
    const list = await app.inject({ method: "GET", url: `/v1/vehicles/${vehicleRef}/articles` });
    expect(list.statusCode).toBe(200);
    expect(list.json().articles).toHaveLength(1);
    const article = list.json().articles[0];
    expect(article.asset_resource_refs).toHaveLength(1);
    const search = await app.inject({ method: "POST", url: `/v1/vehicles/${vehicleRef}/article-search`, payload: { query: "water pump" } });
    expect(search.statusCode).toBe(200);
    expect(search.json().articles[0].opaque_ref).toBe(article.opaque_ref);
    const body = await app.inject({ method: "GET", url: `/v1/resources/${article.resource_ref}` });
    expect(body.statusCode).toBe(200);
    expect(body.json().content).toBe('<h1>Water Pump Replacement</h1><mtr-image id="g1"></mtr-image>');
    expect(body.json().content).not.toContain("/v1/resources/");
    expect(body.json().asset_resource_refs).toHaveLength(1);
    expect(body.json().sha256).toBe(createHash("sha256").update(body.json().content).digest("hex"));
    expect(body.headers["x-request-id"]).toBe(body.json().request_id);
    expect(body.headers["x-provider"]).toBe("bankone");
    expect(body.headers["x-source-revision"]).toBe(body.json().source_revision);
    expect(body.headers["x-fetched-at"]).toBe(body.json().fetched_at);
    expect(body.headers["x-source-locator"]).toBe(body.json().source_locator);
    expect(body.headers["x-source-sha256"]).toBe(body.json().sha256);
    expect(body.headers["x-source-media-type"]).toBe(body.json().media_type);
    const labor = await app.inject({ method: "GET", url: `/v1/resources/${article.labor_resource_ref}` });
    expect(labor.json().kind).toBe("labor");
    expect(labor.headers["x-source-sha256"]).toBe(labor.json().sha256);
    const assetRef = body.json().asset_resource_refs[0];
    expect(assetRef).toBe(article.asset_resource_refs[0]);
    const asset = await app.inject({ method: "GET", url: `/v1/resources/${assetRef}` });
    expect(asset.json()).toMatchObject({ kind: "asset", media_type: "image/png", content_base64: "AAEC" });
    expect(asset.json().sha256).toBe(createHash("sha256").update(Buffer.from([0, 1, 2])).digest("hex"));
    expect(asset.headers["x-source-media-type"]).toBe("image/png");
    const rawAsset = await app.inject({ method: "GET", url: `/v1/resources/${assetRef}`, headers: { accept: "application/octet-stream" } });
    expect(rawAsset.statusCode).toBe(200);
    expect(rawAsset.rawPayload).toEqual(Buffer.from([0, 1, 2]));
    expect(rawAsset.headers["content-type"]).toContain("application/octet-stream");
    expect(rawAsset.headers["x-source-media-type"]).toBe("image/png");
    expect(rawAsset.headers["x-source-sha256"]).toBe(asset.json().sha256);
    const imageAccept = await app.inject({ method: "GET", url: `/v1/resources/${assetRef}`, headers: { accept: "image/png" } });
    expect(imageAccept.headers["content-type"]).toContain("application/json");
    expect(imageAccept.json().media_type).toBe("image/png");
    await app.close();
  });


  it("binds exact authored document IDs to existing same-vehicle article refs after key rotation", async () => {
    const targetId = "1234567:12345678";
    const html = '<p><mtr-doc-link id="1234567&#58;12345678">Timing Cover</mtr-doc-link></p>'
      + '<mtr-doc-link id="1234567:12345678">Timing Cover</mtr-doc-link>'
      + '<mtr-doc-link id="duplicate" id="forged">Duplicate</mtr-doc-link>'
      + '<template><mtr-doc-link id="template">Template</mtr-doc-link></template>'
      + '<section aria-hidden="true"><img src="x"><mtr-doc-link id="hidden">Hidden</mtr-doc-link></section>'
      + '<div style="display : none !important"><mtr-doc-link id="css-hidden">Hidden</mtr-doc-link></div>'
      + '<mtr-doc-link id="a1">Source article</mtr-doc-link>';
    const upstreamCalls: string[] = [];
    const transport: HttpTransport = async (request) => {
      upstreamCalls.push(new URL(request.url).pathname);
      if (request.url.endsWith("/articles/v2")) return json({ articleDetails: [
        { id: "a1", title: "Engine Procedure" },
        { id: "other-title-match", title: "Timing Cover" },
        { id: targetId, title: "Timing Cover" },
      ] });
      if (request.url.endsWith("/article/a1")) return json({ html });
      throw new Error("Unexpected target request");
    };
    const before = await appWithTransport(transport);
    const vehicleRef = encodeReference({ kind: "vehicle", catalog: "Toyota", vehicleId: "v1" }, config.sourceRefs);
    const index = await before.inject({ method: "GET", url: `/v1/vehicles/${vehicleRef}/articles` });
    expect(index.statusCode).toBe(200);
    await before.close();
    const [opened, duplicateTitle, target] = index.json().articles;
    const rotated = { ...config, sourceRefs: {
      activeKeyId: "v2", keys: { ...config.sourceRefs.keys, v2: Buffer.alloc(32, 0x33) },
    } };
    const after = await appWithTransport(transport, rotated);
    const previousClient = await after.inject({ method: "GET", url: `/v1/resources/${opened.resource_ref}` });
    expect(previousClient.statusCode).toBe(200);
    expect(previousClient.json().content).toBe(html);
    expect(previousClient.json()).not.toHaveProperty("article_link_bindings");
    expect(previousClient.headers.vary).toContain("Prefer");
    const response = await after.inject({
      method: "GET", url: `/v1/resources/${opened.resource_ref}`,
      headers: { prefer: 'respond-async, include="article-link-bindings"' },
    });
    expect(response.statusCode).toBe(200);
    await after.close();
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const body = response.json();
    expect(body.content).toBe(html);
    expect(body.sha256).toBe(digest(html));
    expect(body.article_link_bindings).toEqual([{
      source_id_sha256: digest(targetId),
      target_ref_sha256: digest(target.opaque_ref),
    }]);
    expect(body.article_link_bindings[0].target_ref_sha256).not.toBe(digest(duplicateTitle.opaque_ref));
    const anotherVehicle = encodeReference({
      catalog: "Toyota", vehicleId: "v2", articleId: targetId, kind: "article",
    }, config.sourceRefs);
    expect(body.article_link_bindings[0].target_ref_sha256).not.toBe(digest(anotherVehicle));
    expect(response.body).not.toContain(target.opaque_ref);
    expect(response.headers.vary).toContain("Prefer");
    expect(upstreamCalls).toHaveLength(2);
  });

  it("binds decoded image sources to authenticated refs without changing raw source evidence", async () => {
    const html = '<p>Before</p><img src="api/asset/second"><table><tr><td><img src="/m1/api/asset/first&#58;diagram"></td></tr></table>'
      + '<img src="api/asset/second"><img src="/api/asset/amp&amp;part">'
      + '<img src="/api/asset/ambiguous&notit;=x"><img src="/api/asset/erase&#11;x">'
      + '<img src="/api/asset/wrong" SRC="/api/asset/last"><p>After</p>';
    const app = await appWithTransport(async (request) => {
      if (request.url.includes("/article/a1")) return json({ html });
      if (request.url.endsWith("/asset/second")) return { status: 200, headers: { "content-type": "image/png" }, body: Buffer.from([1, 2, 3]) };
      throw new Error("Unexpected upstream target");
    });
    const articleRef = encodeReference({ kind: "article", catalog: "Toyota", vehicleId: "v1", articleId: "a1" }, config.sourceRefs);
    const response = await app.inject({ method: "GET", url: `/v1/resources/${articleRef}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.content).toBe(html);
    expect(body.sha256).toBe(createHash("sha256").update(html).digest("hex"));
    expect(response.headers["x-source-sha256"]).toBe(body.sha256);
    expect(body.source_revision).toBe(`sha256:${createHash("sha256").update(json({ html }).body).digest("hex")}`);
    expect(body.asset_bindings.map((binding: { source_url: string }) => binding.source_url)).toEqual([
      "api/asset/second", "/m1/api/asset/first:diagram", "/api/asset/amp&part", "/api/asset/ambiguous&notit;=x", "/api/asset/erasex", "/api/asset/last",
    ]);
    const decoded = body.asset_bindings.map((binding: { resource_ref: string }) => {
      expect(body.asset_resource_refs).toContain(binding.resource_ref);
      return decodeReference(binding.resource_ref, config.sourceRefs, "asset");
    });
    expect(decoded).toEqual(["second", "first:diagram", "amp&part", "ambiguous&notit;=x", "erasex", "last"].map((assetId) => ({ kind: "asset", catalog: "Toyota", assetKind: "asset", assetId })));
    const asset = await app.inject({ method: "GET", url: `/v1/resources/${body.asset_bindings[0].resource_ref}` });
    expect(asset.statusCode).toBe(200);
    expect(asset.json()).toMatchObject({ media_type: "image/png", content_base64: "AQID" });
    await app.close();
  });

  it("does not bind forged, unrelated or malformed image URLs", async () => {
    const html = [
      "https://evil.invalid/api/asset/stolen", "https://sites.motor.com.evil.invalid/api/asset/stolen",
      "https://user:pass@sites.motor.com/api/asset/stolen", "//evil.invalid/api/asset/stolen",
      "javascript:alert(1)", "data:image/png;base64,AAEC", "/api/asset/a/extra", "/api/asset/%2Fsecret",
      "/api/asset/%ZZ", "/api/asset/a?token=secret", "/api/asset/a#fragment", "/api/source/Unknown/graphic/a",
    ].map((src) => `<img src="${src}" data-resource-ref="forged">`).join("");
    const app = await appWithTransport(async () => json({ html }));
    const ref = encodeReference({ kind: "article", catalog: "Toyota", vehicleId: "v1", articleId: "a1" }, config.sourceRefs);
    const response = await app.inject({ method: "GET", url: `/v1/resources/${ref}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().content).toBe(html);
    expect(response.json()).not.toHaveProperty("asset_bindings");
    await app.close();
  });

  it("binds supplier article links and embedded assets without modifying the original HTML", async () => {
    const html = '<p>Before</p><a href="/api/asset/local&#58;bulletin">Bulletin</a>'
      + '<iframe src="/m1/api/asset/embedded" title="Embedded bulletin"></iframe>'
      + '<object data="/api/asset/object-manual"></object><embed src="/api/asset/embed-manual">'
      + '<a href="/api/asset/local:bulletin">Same bulletin again</a>'
      + '<a href="https://external.invalid/api/asset/foreign">External</a>'
      + '<a href="/api/asset/other?preview=1">Separate document</a>'
      + '<a href="/api/source/Toyota/graphic/thumbnail">A graphic</a>'
      + '<div href="/api/asset/unrelated" data-resource-ref="forged"></div><p>After</p>';
    const pdf = Buffer.from("%PDF-1.7\n%%EOF\n");
    const app = await appWithTransport(async (request) => {
      if (request.url.includes("/article/a1")) return json({ html });
      if (request.url.endsWith("/asset/local%3Abulletin"))
        return { status: 200, headers: { "content-type": "application/pdf" }, body: pdf };
      throw new Error("Unexpected upstream target");
    });
    const ref = encodeReference({ kind: "article", catalog: "Toyota", vehicleId: "v1", articleId: "a1" }, config.sourceRefs);
    const response = await app.inject({ method: "GET", url: `/v1/resources/${ref}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.content).toBe(html);
    expect(body.sha256).toBe(createHash("sha256").update(html).digest("hex"));
    expect(body.asset_bindings.map((binding: { source_url: string }) => binding.source_url)).toEqual([
      "/api/asset/local:bulletin", "/m1/api/asset/embedded", "/api/asset/object-manual", "/api/asset/embed-manual",
    ]);
    for (const binding of body.asset_bindings) expect(body.asset_resource_refs).toContain(binding.resource_ref);
    const asset = await app.inject({
      method: "GET", url: `/v1/resources/${body.asset_bindings[0].resource_ref}`,
      headers: { accept: "application/octet-stream" },
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["x-source-media-type"]).toBe("application/pdf");
    expect(asset.headers["x-source-sha256"]).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect(asset.rawPayload).toEqual(pdf);
    await app.close();
  });

  it("bounds image bindings to declared refs and preserves first source order", async () => {
    const html = Array.from({ length: 130 }, (_, index) => `<img src="/api/asset/figure-${index}">`).join("");
    const app = await appWithTransport(async () => json({ html }));
    const ref = encodeReference({ kind: "article", catalog: "Toyota", vehicleId: "v1", articleId: "a1" }, config.sourceRefs);
    const response = await app.inject({ method: "GET", url: `/v1/resources/${ref}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.asset_bindings).toHaveLength(128);
    expect(body.asset_resource_refs).toHaveLength(128);
    expect(body.asset_bindings[127].source_url).toBe("/api/asset/figure-127");
    for (const binding of body.asset_bindings) expect(body.asset_resource_refs).toContain(binding.resource_ref);
    await app.close();
  });

  it("keeps provider search hits without literal title matches and omits unproven labor", async () => {
    const app = await appWithTransport(async (request) => {
      if (request.url.includes("searchTerm=timing")) return json({ articleDetails: [{ id: "a2", title: "Engine Procedure", bucketName: "Service" }] });
      throw new Error(`Unexpected upstream request: ${request.url}`);
    });
    const vehicleRef = encodeReference({ kind: "vehicle", catalog: "Toyota", vehicleId: "v1" }, config.sourceRefs);
    const result = await app.inject({ method: "POST", url: `/v1/vehicles/${vehicleRef}/article-search`, payload: { query: "timing" } });
    expect(result.statusCode).toBe(200);
    expect(result.json().articles).toHaveLength(1);
    expect(result.json().articles[0]).not.toHaveProperty("labor_resource_ref");
    await app.close();
  });

  it("keeps stored references valid across session and active reference-key rotation", async () => {
    const ref = encodeReference({ kind: "vehicle", catalog: "Toyota", vehicleId: "v1" }, config.sourceRefs);
    const rotated = {
      ...config,
      session: { ...config.session, encryptionKey: Buffer.from("c".repeat(64), "hex") },
      sourceRefs: { activeKeyId: "v2", keys: { ...config.sourceRefs.keys, v2: Buffer.from("d".repeat(64), "hex") } },
    };
    const app = await appWithTransport(async () => json({ articleDetails: [] }), rotated);
    const result = await app.inject({ method: "GET", url: `/v1/vehicles/${ref}/articles` });
    expect(result.statusCode).toBe(200);
    expect(result.json().articles).toEqual([]);
    await app.close();
  });

  it("rejects forged references before using an upstream session", async () => {
    let calls = 0;
    const app = await appWithTransport(async () => { calls += 1; return json([]); });
    const response = await app.inject({ method: "GET", url: "/v1/vehicles/b1.invalid/articles" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_INPUT", retryable: false } });
    expect(calls).toBe(0);
    await app.close();
  });
});
