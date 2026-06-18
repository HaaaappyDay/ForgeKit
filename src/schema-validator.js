function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "object") return actual === "object";
  return actual === expected;
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateNode(schema, value, path, errors) {
  if (schema.const !== undefined && !sameJsonValue(schema.const, value)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
    return;
  }

  if (schema.enum && !schema.enum.some((item) => sameJsonValue(item, value))) {
    errors.push(`${path}: expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    return;
  }

  if (schema.type && !matchesType(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return;
  }

  if (schema.type === "string" && schema.minLength && value.length < schema.minLength) {
    errors.push(`${path}: expected string length >= ${schema.minLength}`);
  }

  if (schema.type === "integer" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: expected integer >= ${schema.minimum}`);
  }

  if (schema.type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors));
    }
  }

  if (schema.type === "object") {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}: missing required property ${key}`);
      }
    }

    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateNode(child, value[key], `${path}.${key}`, errors);
      }
    }

    const known = new Set(Object.keys(properties));
    for (const key of Object.keys(value)) {
      if (known.has(key)) continue;
      if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property ${key}`);
      } else if (typeof schema.additionalProperties === "object") {
        validateNode(schema.additionalProperties, value[key], `${path}.${key}`, errors);
      }
    }
  }
}

export function validateJson(schema, value) {
  const errors = [];
  validateNode(schema, value, "$", errors);
  return {
    valid: errors.length === 0,
    errors
  };
}

