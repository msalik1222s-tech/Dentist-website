// A very small JSON Schema check for tool inputs.
//
// Tool arguments are model output, and model output is untrusted: a model can
// omit a required field, send a number where a string belongs, or paste a
// novel into a name. Validating here means a handler never has to re-check,
// and a bad call comes back as a readable error the model can act on instead
// of a 500.
//
// Only the keywords the tool schemas actually use are implemented — type,
// required, enum, maxLength, minimum/maximum. Anything else is ignored.

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validate(schema, input) {
  const errors = [];
  const properties = (schema && schema.properties) || {};
  const required = (schema && schema.required) || [];
  const out = {};

  for (const key of required) {
    const value = input[key];
    if (value === undefined || value === null || value === "") {
      errors.push(`Missing required field: ${key}`);
    }
  }

  for (const [key, spec] of Object.entries(properties)) {
    const value = input[key];
    if (value === undefined || value === null) continue;

    const expected = spec.type || "string";
    const actual = typeOf(value);

    // Models routinely send a number for a string field (a phone, a year).
    // Coercing is friendlier than bouncing the call.
    let coerced = value;
    if (expected === "string" && (actual === "number" || actual === "boolean")) {
      coerced = String(value);
    } else if (expected === "number" && actual === "string" && value.trim() !== "" && !isNaN(Number(value))) {
      coerced = Number(value);
    } else if (expected !== actual) {
      errors.push(`Field ${key} should be a ${expected}.`);
      continue;
    }

    if (expected === "string") {
      if (spec.maxLength && coerced.length > spec.maxLength) coerced = coerced.slice(0, spec.maxLength);
      if (spec.enum && !spec.enum.includes(coerced)) {
        errors.push(`Field ${key} must be one of: ${spec.enum.join(", ")}.`);
        continue;
      }
    }

    if (expected === "number") {
      if (spec.minimum !== undefined && coerced < spec.minimum) coerced = spec.minimum;
      if (spec.maximum !== undefined && coerced > spec.maximum) coerced = spec.maximum;
    }

    out[key] = coerced;
  }

  return { valid: errors.length === 0, errors, value: out };
}

module.exports = { validate };
