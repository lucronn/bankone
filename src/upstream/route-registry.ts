import { ConnectorError } from "../errors.js";

export type UpstreamRouteParams = Record<string, unknown>;

export type UpstreamRequest = {
  method: "GET" | "POST";
  url: string;
  responseKind: "json" | "text";
  body?: string;
};

type RouteDefinition = {
  id: string;
  method: UpstreamRequest["method"];
  responseKind: "json" | "text";
  path: (params: UpstreamRouteParams) => string;
  query: readonly string[];
  body?: (params: UpstreamRouteParams) => string;
};

const segment = (params: UpstreamRouteParams, name: string): string => {
  const value = params[name];
  if (value === undefined || value === null || String(value).length === 0) {
    throw new ConnectorError("invalid_request", `${name} is required`, 400);
  }
  return encodeURIComponent(String(value));
};

const path = (...parts: string[]): string => `/m1/api/${parts.join("/")}`;

export function isMotorEngineId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,20}:[0-9]{1,20}$/.test(value);
}

function fordModelSegment(params: UpstreamRouteParams): string {
  if (typeof params.vehicleId !== "string" ||
      !/^[0-9]{4}:Ford:[^:/\\?#%\x00-\x1f\x7f]{1,160}$/.test(params.vehicleId)) {
    throw new ConnectorError("invalid_request", "Invalid Ford model reference", 400);
  }
  return segment(params, "vehicleId");
}

export const UPSTREAM_ROUTES = {
  years: {
    id: "years",
    method: "GET",
    responseKind: "json",
    path: () => path("years"),
    query: [],
  },
  makes: {
    id: "makes",
    method: "GET",
    responseKind: "json",
    path: (params) => path("year", segment(params, "year"), "makes"),
    query: [],
  },
  models: {
    id: "models",
    method: "GET",
    responseKind: "json",
    path: (params) => path("year", segment(params, "year"), "make", segment(params, "make"), "models"),
    query: [],
  },
  vinVehicle: {
    id: "vinVehicle",
    method: "GET",
    responseKind: "json",
    path: (params) => path("vin", segment(params, "vin"), "vehicle"),
    query: [],
  },
  vehicles: {
    id: "vehicles",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), "vehicles"),
    query: ["vehicleIds"],
  },
  fordMotorVehicles: {
    id: "fordMotorVehicles",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", "Ford", fordModelSegment(params), "motorvehicles"),
    query: [],
  },
  fordVehicleName: {
    id: "fordVehicleName",
    method: "GET",
    responseKind: "json",
    path: (params) => {
      if (!isMotorEngineId(params.motorVehicleId))
        throw new ConnectorError("invalid_request", "Invalid Motor engine reference", 400);
      return path("source", "Ford", fordModelSegment(params), "name");
    },
    query: ["motorVehicleId"],
  },
  motorVehicleBatch: {
    id: "motorVehicleBatch",
    method: "POST",
    responseKind: "json",
    path: () => path("source", "Motor", "vehicles"),
    query: [],
    body: ({ vehicleIds }) => {
      if (!Array.isArray(vehicleIds) || !vehicleIds.length || vehicleIds.length > 200 ||
          !vehicleIds.every(isMotorEngineId)) {
        throw new ConnectorError("invalid_request", "Invalid Motor engine references", 400);
      }
      return JSON.stringify({ vehicleIds });
    },
  },
  vehicleDetails: {
    id: "vehicleDetails",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), segment(params, "vehicleId"), "motorvehicles"),
    query: [],
  },
  vehicleName: {
    id: "vehicleName",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), segment(params, "vehicleId"), "name"),
    query: [],
  },
  articles: {
    id: "articles",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), "vehicle", segment(params, "vehicleId"), "articles", "v2"),
    query: ["bucketName", "articleSubtype", "searchTerm"],
  },
  article: {
    id: "article",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), "vehicle", segment(params, "vehicleId"), "article", segment(params, "articleId")),
    query: ["bucketName", "articleSubtype", "searchTerm"],
  },
  articleTitle: {
    id: "articleTitle",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), "vehicle", segment(params, "vehicleId"), "article", segment(params, "articleId"), "title"),
    query: [],
  },
  labor: {
    id: "labor",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), "vehicle", segment(params, "vehicleId"), "labor", segment(params, "articleId")),
    query: [],
  },
  maintenanceFrequency: {
    id: "maintenanceFrequency",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), "vehicle", segment(params, "vehicleId"), "maintenanceSchedules", "frequency"),
    query: [],
  },
  maintenanceIntervals: {
    id: "maintenanceIntervals",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), "vehicle", segment(params, "vehicleId"), "maintenanceSchedules", "intervals"),
    query: [],
  },
  maintenanceIndicators: {
    id: "maintenanceIndicators",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), "vehicle", segment(params, "vehicleId"), "maintenanceSchedules", "indicators"),
    query: [],
  },
  parts: {
    id: "parts",
    method: "GET",
    responseKind: "json",
    path: (params) => path("source", segment(params, "contentSource"), "vehicle", segment(params, "vehicleId"), "parts"),
    query: [],
  },
  graphic: {
    id: "graphic",
    method: "GET",
    responseKind: "text",
    path: (params) => path("source", segment(params, "contentSource"), "graphic", segment(params, "id")),
    query: [],
  },
  asset: {
    id: "asset",
    method: "GET",
    responseKind: "text",
    path: (params) => path("asset", segment(params, "handleId")),
    query: [],
  },
  xml: {
    id: "xml",
    method: "GET",
    responseKind: "text",
    path: (params) => path("source", segment(params, "contentSource"), "xml", segment(params, "articleId")),
    query: [],
  },
  userSettings: {
    id: "userSettings",
    method: "GET",
    responseKind: "json",
    path: () => path("ui", "usersettings"),
    query: [],
  },
} satisfies Record<string, RouteDefinition>;

export type UpstreamRouteId = keyof typeof UPSTREAM_ROUTES;

function queryValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String).join(",");
  return String(value);
}

function encodeQuery(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "%20");
}

export function buildUpstreamRequest(
  routeId: UpstreamRouteId,
  params: UpstreamRouteParams,
  apiOrigin: string,
  allowedContentSources: readonly string[] = ["GeneralMotors", "Motor", "Toyota"],
): UpstreamRequest {
  const route: RouteDefinition = UPSTREAM_ROUTES[routeId];
  const contentSource = params.contentSource;
  if (contentSource !== undefined && !allowedContentSources.includes(String(contentSource))) {
    throw new ConnectorError("invalid_request", "content source is not allowed", 400);
  }
  if ((routeId === "fordMotorVehicles" || routeId === "fordVehicleName" || routeId === "motorVehicleBatch") &&
      !allowedContentSources.includes("Motor")) {
    throw new ConnectorError("invalid_request", "Motor content source is not allowed", 400);
  }

  const origin = new URL(apiOrigin);
  if (origin.protocol !== "https:") throw new ConnectorError("blocked_upstream_target", "Only HTTPS upstream targets are allowed", 400);
  const url = new URL(route.path(params), origin);
  const query = route.query
    .map((name) => [name, queryValue(params[name])] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${encodeQuery(name)}=${encodeQuery(value)}`)
    .join("&");
  if (query) url.search = query;

  return {
    method: route.method, url: url.toString(), responseKind: route.responseKind,
    ...(route.body ? { body: route.body(params) } : {}),
  };
}
