// A small, deterministic JSON-Schema validator.
//
// The registry is the single source of truth for input and output schemas, and
// both the MCP layer and the manifest read from it. To avoid drift we validate
// against the very same schemas at call time rather than re-describing inputs
// in code. The subset supported here is exactly what the catalog uses:
// type (object/string/integer/number/boolean/array/null and unions),
// required, properties, additionalProperties:false, enum, minimum/maximum,
// minLength/maxLength, pattern, items, minItems/maxItems and const.
//
// It returns { valid, errors: [{path, message}] } and never throws on ordinary
// invalid input.

export function validate(schema, value, path = '') {
  const errors = [];
  check(schema, value, path, errors);
  return { valid: errors.length === 0, errors };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // string|number|boolean|object|undefined
}

function matchesType(t, v) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'integer') return actual === 'integer';
  return actual === t;
}

function check(schema, value, path, errors) {
  if (schema == null || typeof schema !== 'object') return;

  if ('const' in schema && !deepEqual(schema.const, value)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push({ path, message: `expected ${types.join(' or ')}, got ${typeOf(value)}` });
      return;
    }
  }

  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }

  const kind = typeOf(value);

  if (kind === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} characters` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `must match ${schema.pattern}` });
    }
  }

  if (kind === 'number' || kind === 'integer') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (kind === 'array' && schema.items) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({ path, message: `must have at most ${schema.maxItems} items` });
    }
    value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }

  if (kind === 'object' && (schema.properties || schema.required || 'additionalProperties' in schema)) {
    const props = schema.properties || {};
    const additional = schema.additionalProperties;
    for (const req of schema.required || []) {
      if (!(req in value) || value[req] === undefined) {
        errors.push({ path: path ? `${path}.${req}` : req, message: 'is required' });
      }
    }
    for (const key of Object.keys(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (props[key]) {
        check(props[key], value[key], childPath, errors);
      } else if (additional === false) {
        errors.push({ path: childPath, message: 'is not a recognised input' });
      } else if (additional && typeof additional === 'object') {
        check(additional, value[key], childPath, errors);
      }
    }
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
