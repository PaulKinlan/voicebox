// core/mini-app.ts — Sandboxed Web MCP mini-apps contract & validation (voicebox-beads-q8d)
//
// Defines the security policy, Web MCP tool declaration schemas, wire envelopes,
// and execution bounds for the double-iframe mini-app architecture.
//
// Pure TypeScript: no platform or DOM imports.

export interface WebMcpParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
  [key: string]: unknown;
}

export interface WebMcpToolParameters {
  type: "object";
  properties: Record<string, WebMcpParameterSchema>;
  required?: string[];
}

export interface WebMcpToolDeclaration {
  name: string;
  description: string;
  parameters: WebMcpToolParameters;
}

export interface WebMcpToolCall {
  callId: string;
  appId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface WebMcpToolResult {
  callId: string;
  appId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface MiniAppManifest {
  id: string;
  title: string;
  tools: WebMcpToolDeclaration[];
  declaredAt: string;
}

export const MINI_APP_BOUNDS = Object.freeze({
  maxTools: 16,
  maxOutputBytes: 65536, // 64KB
  maxArgsBytes: 65536,   // 64KB max incoming tool arguments
  callTimeoutMs: 5000,   // 5s per tool execution
  maxNameLength: 64,
  maxDescriptionLength: 1024,
  maxAppIdLength: 64,
  sandboxPolicy: "allow-scripts", // strictly NO allow-same-origin
});

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; refused: string; why: string };

const refusal = (refused: string, why: string): { ok: false; refused: string; why: string } => ({
  ok: false,
  refused,
  why,
});

/**
 * Validate a Web MCP tool declaration submitted by a mini-app.
 */
export function validateWebMcpTool(raw: unknown): ValidationResult<WebMcpToolDeclaration> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return refusal("invalid-tool-declaration", "tool declaration must be an object");
  }
  const t = raw as Record<string, unknown>;
  const name = typeof t.name === "string" ? t.name.trim() : "";
  if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return refusal("invalid-tool-name", `tool name must be 1-64 alphanumeric characters, underscores or dashes, got '${name}'`);
  }
  const description = typeof t.description === "string" ? t.description.trim() : "";
  if (!description || description.length > MINI_APP_BOUNDS.maxDescriptionLength) {
    return refusal("invalid-tool-description", `tool description must be a string up to ${MINI_APP_BOUNDS.maxDescriptionLength} characters`);
  }
  const rawParams = t.parameters ?? t.inputSchema ?? { type: "object", properties: {} };
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return refusal("invalid-tool-parameters", "tool parameters must be a JSON schema object with type: 'object'");
  }
  const p = rawParams as Record<string, unknown>;
  if (p.type !== "object") {
    return refusal("invalid-tool-parameters", "tool parameters schema must specify type: 'object'");
  }
  const properties = (p.properties && typeof p.properties === "object" && !Array.isArray(p.properties))
    ? (p.properties as Record<string, WebMcpParameterSchema>)
    : {};
  const required = Array.isArray(p.required)
    ? p.required.filter((k): k is string => typeof k === "string")
    : [];

  return {
    ok: true,
    value: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
      },
    },
  };
}

/**
 * Convert a list of Web MCP tool declarations to live model function declarations.
 */
export function toolsToFunctionDeclarations(tools: WebMcpToolDeclaration[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Validate arguments supplied to a mini-app tool against its declared JSON schema.
 */
export function validateMiniAppToolArgs(
  tool: WebMcpToolDeclaration,
  rawArgs: unknown
): ValidationResult<Record<string, unknown>> {
  if (rawArgs === null || rawArgs === undefined) {
    rawArgs = {};
  }
  if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return refusal("invalid-tool-arguments", `tool arguments must be an object, got ${Array.isArray(rawArgs) ? "array" : typeof rawArgs}`);
  }

  const args = rawArgs as Record<string, unknown>;

  let jsonStr = "";
  try {
    jsonStr = JSON.stringify(args);
  } catch {
    return refusal("invalid-tool-arguments", "tool arguments must be serializable JSON");
  }
  if (jsonStr.length > MINI_APP_BOUNDS.maxArgsBytes) {
    return refusal(
      "invalid-tool-arguments",
      `tool arguments size (${jsonStr.length} bytes) exceeds maximum allowed bound of ${MINI_APP_BOUNDS.maxArgsBytes} bytes`
    );
  }

  const params = tool?.parameters ?? { type: "object", properties: {} };
  const properties = (params.properties && typeof params.properties === "object" && !Array.isArray(params.properties))
    ? params.properties
    : {};
  const required = Array.isArray(params.required) ? params.required : [];

  for (const reqKey of required) {
    if (typeof reqKey === "string" && (!(reqKey in args) || args[reqKey] === undefined || args[reqKey] === null)) {
      return refusal("missing-argument", `missing required argument '${reqKey}' for mini-app tool '${tool.name}'`);
    }
  }

  for (const [key, val] of Object.entries(args)) {
    const schema = properties[key];
    if (schema && val !== undefined && val !== null) {
      if (schema.type) {
        switch (schema.type) {
          case "string":
            if (typeof val !== "string") {
              return refusal("invalid-argument-type", `argument '${key}' must be a string, got ${typeof val}`);
            }
            break;
          case "number":
            if (typeof val !== "number" || !Number.isFinite(val)) {
              return refusal("invalid-argument-type", `argument '${key}' must be a finite number, got ${typeof val === "number" ? "NaN/Infinity" : typeof val}`);
            }
            break;
          case "integer":
            if (typeof val !== "number" || !Number.isInteger(val)) {
              return refusal("invalid-argument-type", `argument '${key}' must be an integer, got ${val}`);
            }
            break;
          case "boolean":
            if (typeof val !== "boolean") {
              return refusal("invalid-argument-type", `argument '${key}' must be a boolean, got ${typeof val}`);
            }
            break;
          case "array":
            if (!Array.isArray(val)) {
              return refusal("invalid-argument-type", `argument '${key}' must be an array, got ${typeof val}`);
            }
            break;
          case "object":
            if (typeof val !== "object" || val === null || Array.isArray(val)) {
              return refusal("invalid-argument-type", `argument '${key}' must be an object, got ${Array.isArray(val) ? "array" : typeof val}`);
            }
            break;
        }
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(val as string)) {
        return refusal(
          "invalid-argument-enum",
          `argument '${key}' value ${JSON.stringify(val)} is not one of the allowed enum values: [${schema.enum.map((e) => JSON.stringify(e)).join(", ")}]`
        );
      }
    }
  }

  return { ok: true, value: args };
}
