/**
 * Expand every acyclic, document-local JSON Schema reference.
 *
 * References whose target graph reaches itself remain references. They cannot
 * be finitely expanded and continue to rely on their original definitions.
 */
export function expandLocalReferences(schema) {
  const root = clone(schema);
  let expandedCount = 0;
  const recursiveReferences = new Set();

  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (!record(value)) return value;

    const reference = typeof value.$ref === "string" ? value.$ref : undefined;
    if (localPointer(reference)) {
      if (referenceIsRecursive(root, reference)) {
        recursiveReferences.add(reference);
        return Object.fromEntries(
          Object.entries(value).map(([key, candidate]) => [
            key,
            key === "$ref" ? candidate : visit(candidate),
          ]),
        );
      }
      const target = resolveLocalPointer(root, reference);
      const siblings = Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "$ref")
          .map(([key, candidate]) => [key, visit(candidate)]),
      );
      expandedCount += 1;
      const expandedTarget = visit(clone(target));
      return Object.keys(siblings).length
        ? { allOf: [expandedTarget, siblings] }
        : expandedTarget;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, candidate]) => [
        key,
        key === "$defs" ? candidate : visit(candidate),
      ]),
    );
  };

  const expanded = visit(root);
  if (appliedLocalReferences(expanded).length === 0 && record(expanded)) {
    delete expanded.$defs;
  }
  return {
    schema: expanded,
    expandedCount,
    recursiveReferences: [...recursiveReferences].sort(),
  };
}

export function localReferences(value) {
  const references = [];
  const visit = (candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!record(candidate)) return;
    if (localPointer(candidate.$ref)) references.push(candidate.$ref);
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  return [...new Set(references)].sort();
}

function appliedLocalReferences(value) {
  const references = [];
  const visit = (candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!record(candidate)) return;
    if (localPointer(candidate.$ref)) references.push(candidate.$ref);
    Object.entries(candidate).forEach(([key, nested]) => {
      if (key !== "$defs") visit(nested);
    });
  };
  visit(value);
  return [...new Set(references)].sort();
}

function referenceIsRecursive(root, initialReference) {
  const visit = (reference, path) => {
    if (path.has(reference)) return true;
    const nextPath = new Set(path).add(reference);
    const target = resolveLocalPointer(root, reference);
    return localReferences(target).some((nested) => visit(nested, nextPath));
  };
  return visit(initialReference, new Set());
}

function resolveLocalPointer(root, reference) {
  let current = root;
  for (const encoded of reference.slice(2).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!record(current) && !Array.isArray(current)) {
      throw new Error(`Local schema reference ${reference} does not resolve.`);
    }
    current = current[segment];
    if (current === undefined) {
      throw new Error(`Local schema reference ${reference} does not resolve.`);
    }
  }
  return current;
}

function localPointer(value) {
  return typeof value === "string" && value.startsWith("#/");
}

function clone(value) {
  return structuredClone(value);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
