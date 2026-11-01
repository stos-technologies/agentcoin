// Converts the tool JSON Schemas (subset) to a zod object with the caller's zod instance (v3 or v4).
import type { ToolSpec } from "./tools.ts";

export function toZodObject(z: any, params: ToolSpec["parameters"]): any {
  const req = new Set(params.required ?? []);
  const shape: Record<string, any> = {};
  for (const [k, s] of Object.entries(params.properties)) {
    let t: any;
    if (s.enum) t = z.enum(s.enum);
    else if (s.type === "string") { t = z.string(); if (s.minLength != null) t = t.min(s.minLength); if (s.maxLength != null) t = t.max(s.maxLength); if (s.pattern) t = t.regex(new RegExp(s.pattern)); }
    else if (s.type === "integer") { t = z.number().int(); if (s.minimum != null) t = t.min(s.minimum); if (s.maximum != null) t = t.max(s.maximum); }
    else if (s.type === "number") { t = z.number(); if (s.minimum != null) t = t.min(s.minimum); if (s.maximum != null) t = t.max(s.maximum); }
    else if (s.type === "boolean") t = z.boolean();
    else if (s.type === "object") t = z.record(z.string(), z.any());
    else t = z.any();
    if (s.description) t = t.describe(s.description);
    shape[k] = req.has(k) ? t : t.optional();
  }
  return z.object(shape).strict();
}
