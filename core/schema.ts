// core/schema.ts — schema validation as data plus one small function.
//
// WHY THIS IS IN core/: it is the check that makes "the schema is data the model fills" true
// rather than a claim about the model's behaviour. It is pure and it runs in any placement, so
// the browser host and a future machine host refuse the same inputs for the same named reasons.
//
// Every failure carries a CODE, and the code is what the refusal prints: a refusal that only
// says "invalid" is a description, and this project has already paid for that distinction.

export type FieldType = "string" | "enum";

export interface SchemaProperty {
  type: FieldType;
  enum?: string[];
  maxLength?: number;
  description?: string;
}

export interface ToolSchema {
  title: string;
  capabilities: string[];
  properties: Record<string, SchemaProperty>;
  required: string[];
  /** Host-side ceiling on any single string field — check 7's "huge body". */
  maxBytes?: number;
}

export type ValidationOk = { ok: true; value: Record<string, string> };
export type ValidationFail = { ok: false; rule: string; why: string };

export function validate(schema: ToolSchema, input: unknown): ValidationOk | ValidationFail {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, rule: "malformed-input", why: "the tool input is not an object" };
  }
  const record = input as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      return {
        ok: false,
        rule: "unknown-field",
        why: `'${key}' is not a field of ${schema.title}; the model's output is data and an unknown field is not silently dropped`,
      };
    }
  }

  const value: Record<string, string> = {};
  for (const key of schema.required) {
    if (!(key in record)) {
      return { ok: false, rule: "missing-field", why: `'${key}' is required by ${schema.title}` };
    }
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in record)) continue;
    const raw = record[key];
    if (prop.type === "string" || prop.type === "enum") {
      if (typeof raw !== "string") {
        return { ok: false, rule: "malformed-field", why: `'${key}' must be a string` };
      }
      if (prop.type === "enum" && prop.enum && !prop.enum.includes(raw)) {
        return {
          ok: false,
          rule: "unknown-kind",
          why: `'${key}' is '${raw}', which is not one of ${prop.enum.join(", ")}`,
        };
      }
      const cap = prop.maxLength ?? schema.maxBytes;
      if (cap !== undefined && raw.length > cap) {
        return {
          ok: false,
          rule: "too-large",
          why: `'${key}' is ${raw.length} characters, over the ${cap} this placement accepts`,
        };
      }
      value[key] = raw;
    }
  }

  return { ok: true, value };
}
