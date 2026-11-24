import type { Config } from "../config.js";
import { ConnectorError } from "../errors.js";
import { HttpClient, type HttpResponse, type HttpTransport } from "../http/http-client.js";
import type { AuthenticatedSession } from "../auth/auth-adapter.js";
import { buildUpstreamRequest, type UpstreamRequest, type UpstreamRouteId, type UpstreamRouteParams } from "./route-registry.js";

export type UpstreamEnvelope<T> = {
  header: Record<string, unknown>;
  body: T;
};

export class UpstreamApiClient {
  private readonly http: HttpClient;

  constructor(private readonly config: Config, transport?: HttpTransport) {
    this.http = new HttpClient(transport, {
      maxResponseBytes: config.limits.maxResponseBytes,
      timeoutMs: config.limits.requestTimeoutMs,
      maxConcurrentRequests: config.limits.maxConcurrentUpstream,
    });
  }

  buildRequest(routeId: UpstreamRouteId, params: UpstreamRouteParams): UpstreamRequest {
    return buildUpstreamRequest(
      routeId,
      params,
      this.config.upstream.apiOrigin,
      this.config.upstream.allowedContentSources,
    );
  }

  async executeResponse(routeId: UpstreamRouteId, params: UpstreamRouteParams, session: AuthenticatedSession, maxResponseBytes?: number): Promise<HttpResponse> {
    const request = this.buildRequest(routeId, params);
    const response = await this.http.request({
      method: request.method,
      url: request.url,
      headers: {
        accept: request.responseKind === "json" ? "application/json" : "text/plain, application/xml;q=0.9, */*;q=0.8",
        cookie: session.cookieJar.toHeader(Math.floor(Date.now() / 1000)),
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: request.body }),
    }, { maxResponseBytes });
    const setCookie = response.headers["set-cookie"];
    if (setCookie) session.cookieJar.addSetCookie(setCookie, Math.floor(Date.now() / 1000));
    return response;
  }

  async execute<T = unknown>(routeId: UpstreamRouteId, params: UpstreamRouteParams, session: AuthenticatedSession): Promise<UpstreamEnvelope<T>> {
    const response = await this.executeResponse(routeId, params, session);
    if (response.status < 200 || response.status >= 300) {
      throw new ConnectorError("upstream_error", "Upstream request failed", 502, response.status);
    }
    const request = this.buildRequest(routeId, params);
    if (request.responseKind === "text") {
      return { header: { statusCode: response.status }, body: response.body.toString("utf8") as T };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body.toString("utf8"));
    } catch (error) {
      throw new ConnectorError("upstream_error", "Upstream returned invalid JSON", 502, response.status, error);
    }
    if (!parsed || typeof parsed !== "object" || !("header" in parsed) || !("body" in parsed)) {
      throw new ConnectorError("upstream_error", "Upstream returned an invalid response envelope", 502, response.status);
    }
    return parsed as UpstreamEnvelope<T>;
  }
}
