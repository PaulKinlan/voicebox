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
  additionalProperties?: boolean;
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
  const SUPPORTED_PROPERTY_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
  const properties = (p.properties && typeof p.properties === "object" && !Array.isArray(p.properties))
    ? (p.properties as Record<string, WebMcpParameterSchema>)
    : {};

  for (const [propName, propSchema] of Object.entries(properties)) {
    if (!propSchema || typeof propSchema !== "object" || Array.isArray(propSchema)) {
      return refusal("invalid-tool-parameters", `property '${propName}' schema must be an object`);
    }
    if (propSchema.type !== undefined) {
      if (typeof propSchema.type !== "string" || !SUPPORTED_PROPERTY_TYPES.has(propSchema.type)) {
        return refusal("invalid-tool-parameters", `unsupported parameter type '${String(propSchema.type)}' for property '${propName}'`);
      }
    }
    if (propSchema.type === "array" && propSchema.items !== undefined) {
      if (!propSchema.items || typeof propSchema.items !== "object" || Array.isArray(propSchema.items)) {
        return refusal("invalid-tool-parameters", `items schema for array property '${propName}' must be an object`);
      }
      const itemSchema = propSchema.items as Record<string, unknown>;
      if (itemSchema.type !== undefined && (typeof itemSchema.type !== "string" || !SUPPORTED_PROPERTY_TYPES.has(itemSchema.type))) {
        return refusal("invalid-tool-parameters", `unsupported items type '${String(itemSchema.type)}' for array property '${propName}'`);
      }
    }
  }

  const required = Array.isArray(p.required)
    ? p.required.filter((k): k is string => typeof k === "string")
    : [];
  const additionalProperties = p.additionalProperties === false ? false : undefined;

  return {
    ok: true,
    value: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        ...(additionalProperties === false ? { additionalProperties: false } : {}),
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

  const byteLen = typeof Buffer !== "undefined"
    ? Buffer.byteLength(jsonStr, "utf8")
    : (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(jsonStr).length : jsonStr.length);

  if (byteLen > MINI_APP_BOUNDS.maxArgsBytes) {
    return refusal(
      "invalid-tool-arguments",
      `tool arguments size (${byteLen} bytes) exceeds maximum allowed bound of ${MINI_APP_BOUNDS.maxArgsBytes} bytes`
    );
  }

  const params = tool?.parameters ?? { type: "object", properties: {} };
  const properties = (params.properties && typeof params.properties === "object" && !Array.isArray(params.properties))
    ? params.properties
    : {};
  const required = Array.isArray(params.required) ? params.required : [];

  for (const reqKey of required) {
    if (typeof reqKey === "string" && (!Object.hasOwn(args, reqKey) || args[reqKey] === undefined || args[reqKey] === null)) {
      return refusal("missing-argument", `missing required argument '${reqKey}' for mini-app tool '${tool.name}'`);
    }
  }

  if ((params as Record<string, unknown>).additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) {
        return refusal("invalid-argument", `unrecognized argument '${key}' not permitted by tool schema`);
      }
    }
  }

  for (const [key, val] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) continue;
    const schema = properties[key];
    if (schema) {
      if (val === null) {
        return refusal("invalid-argument-type", `argument '${key}' cannot be null`);
      }
      if (val !== undefined) {
        if (schema.type) {
          switch (schema.type) {
            case "string":
              if (typeof val !== "string") {
                return refusal("invalid-argument-type", `argument '${key}' must be a string, got ${typeof val}`);
              }
              if (typeof schema.maxLength === "number" && val.length > schema.maxLength) {
                return refusal("invalid-argument-length", `argument '${key}' length (${val.length}) exceeds maxLength ${schema.maxLength}`);
              }
              if (typeof schema.minLength === "number" && val.length < schema.minLength) {
                return refusal("invalid-argument-length", `argument '${key}' length (${val.length}) below minLength ${schema.minLength}`);
              }
              break;
            case "number":
              if (typeof val !== "number" || !Number.isFinite(val)) {
                return refusal("invalid-argument-type", `argument '${key}' must be a finite number, got ${typeof val === "number" ? "NaN/Infinity" : typeof val}`);
              }
              if (typeof schema.maximum === "number" && val > schema.maximum) {
                return refusal("invalid-argument-range", `argument '${key}' value ${val} exceeds maximum ${schema.maximum}`);
              }
              if (typeof schema.minimum === "number" && val < schema.minimum) {
                return refusal("invalid-argument-range", `argument '${key}' value ${val} below minimum ${schema.minimum}`);
              }
              break;
            case "integer":
              if (typeof val !== "number" || !Number.isInteger(val)) {
                return refusal("invalid-argument-type", `argument '${key}' must be an integer, got ${val}`);
              }
              if (typeof schema.maximum === "number" && val > schema.maximum) {
                return refusal("invalid-argument-range", `argument '${key}' value ${val} exceeds maximum ${schema.maximum}`);
              }
              if (typeof schema.minimum === "number" && val < schema.minimum) {
                return refusal("invalid-argument-range", `argument '${key}' value ${val} below minimum ${schema.minimum}`);
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
              if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
                const itemSchema = schema.items as Record<string, unknown>;
                const itemType = typeof itemSchema.type === "string" ? itemSchema.type : null;
                for (let i = 0; i < val.length; i++) {
                  const item = val[i];
                  if (item === null) {
                    return refusal("invalid-argument-type", `array item at index ${i} in '${key}' cannot be null`);
                  }
                  if (itemType) {
                    if (itemType === "string" && typeof item !== "string") {
                      return refusal("invalid-argument-type", `array item at index ${i} in '${key}' must be a string, got ${typeof item}`);
                    }
                    if (itemType === "number" && (typeof item !== "number" || !Number.isFinite(item))) {
                      return refusal("invalid-argument-type", `array item at index ${i} in '${key}' must be a number, got ${typeof item}`);
                    }
                    if (itemType === "integer" && (typeof item !== "number" || !Number.isInteger(item))) {
                      return refusal("invalid-argument-type", `array item at index ${i} in '${key}' must be an integer, got ${typeof item}`);
                    }
                    if (itemType === "boolean" && typeof item !== "boolean") {
                      return refusal("invalid-argument-type", `array item at index ${i} in '${key}' must be a boolean, got ${typeof item}`);
                    }
                    if (itemType === "object" && (typeof item !== "object" || Array.isArray(item))) {
                      return refusal("invalid-argument-type", `array item at index ${i} in '${key}' must be an object, got ${Array.isArray(item) ? "array" : typeof item}`);
                    }
                  }
                  if (Array.isArray(itemSchema.enum) && !itemSchema.enum.includes(item)) {
                    return refusal("invalid-argument-enum", `array item at index ${i} in '${key}' value ${JSON.stringify(item)} is not one of allowed enum values`);
                  }
                }
              }
              break;
            case "object":
              if (typeof val !== "object" || Array.isArray(val)) {
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
  }

  return { ok: true, value: args };
}
