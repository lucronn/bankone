import { describe, expect, it } from "vitest";
import { buildUpstreamRequest, UPSTREAM_ROUTES } from "../../src/upstream/route-registry.js";

describe("UPSTREAM route registry", () => {
  it("encodes the article id as one path segment and forwards only allowed queries", () => {
    const request = buildUpstreamRequest("article", {
      contentSource: "GeneralMotors",
      vehicleId: "100342221",
      articleId: "4481222:17911387",
      bucketName: "Component Location Diagrams",
      articleSubtype: "",
      searchTerm: "",
      ignored: "drop-me",
    }, "https://sites.motor.com");

    expect(request.url).toBe("https://sites.motor.com/m1/api/source/GeneralMotors/vehicle/100342221/article/4481222%3A17911387?bucketName=Component%20Location%20Diagrams&articleSubtype=&searchTerm=");
    expect(request.url).not.toContain("ignored");
    expect(request.method).toBe("GET");
  });

  it("rejects a content source outside the configured allowlist", () => {
    expect(() => buildUpstreamRequest("article", {
      contentSource: "UntrustedSource", vehicleId: "1", articleId: "2",
    }, "https://sites.motor.com", ["GeneralMotors"])).toThrow(/content source/i);
  });

  it("uses POST only for the read-only, scoped Motor engine lookup", () => {
    const routes = Object.values(UPSTREAM_ROUTES);
    expect(routes.filter((route) => route.method !== "GET").map((route) => route.id)).toEqual(["motorVehicleBatch"]);
    expect(routes.some((route) => route.id === "bookmark" || route.id === "feedback")).toBe(false);
    expect(buildUpstreamRequest("motorVehicleBatch", { vehicleIds: ["12345:678"] }, "https://sites.motor.com"))
      .toEqual({ url: "https://sites.motor.com/m1/api/source/Motor/vehicles", method: "POST",
        responseKind: "json", body: '{"vehicleIds":["12345:678"]}' });
    expect(() => buildUpstreamRequest("motorVehicleBatch", { vehicleIds: ["2016:Ford:Expedition"] }, "https://sites.motor.com"))
      .toThrow(/engine references/);
  });

  it("scopes the Ford model mapping to the enabled Motor source", () => {
    const request = buildUpstreamRequest("fordMotorVehicles", { vehicleId: "2016:Ford:Expedition" }, "https://sites.motor.com");
    expect(request.url).toBe("https://sites.motor.com/m1/api/source/Ford/2016%3AFord%3AExpedition/motorvehicles");
    expect(() => buildUpstreamRequest("fordMotorVehicles", { vehicleId: "2016:Ford:Expedition" },
      "https://sites.motor.com", ["GeneralMotors"])).toThrow(/Motor content source/);
    expect(() => buildUpstreamRequest("fordMotorVehicles", { vehicleId: "2016:Ford:%2e%2e%2f" },
      "https://sites.motor.com")).toThrow(/model reference/);
  });
});
