// Catalog transport for the engine's CollectionSetup configuration algebra.
// This module validates/lifts declarations only. It never merges collection YAML.
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = (value) => value === null || typeof value === "string"
  || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const invalid = () => { throw new Error("invalid_collection_setup: invalid catalog configuration declaration"); };

function members(value, names) {
  if (!object(value) || Object.keys(value).some((key) => !names.includes(key))) invalid();
  if (names.some((key) => !Object.hasOwn(value, key))) invalid();
}

function pointer(path) {
  if (typeof path !== "string" || Buffer.byteLength(path) > 1024 || !path.startsWith("/")) invalid();
  const encoded = path.slice(1).split("/");
  if (encoded.length < 2 || encoded.length > 16) invalid();
  const segments = encoded.map((part) => {
    if (/~(?![01])/u.test(part)) invalid();
    const decoded = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!decoded || decoded === "-" || /^\d+$/u.test(decoded) || /\p{Cc}/u.test(decoded)) invalid();
    return decoded;
  });
  if (path !== "/settings/record_extensions" && !/^x-[a-z0-9][a-z0-9-]*$/u.test(segments[0])) invalid();
}

/** Validate optional setup.configuration: the existing requirement/provision arrays. */
export function validateConfigurationSetup(setup) {
  if (setup === undefined) return;
  members(setup, ["configuration"]);
  const { requirements, provisions } = setup.configuration ?? {};
  members(setup.configuration, ["requirements", "provisions"]);
  if (!Array.isArray(requirements) || !Array.isArray(provisions)
    || requirements.length > 128 || provisions.length > 128) invalid();
  const indexed = new Map();
  for (const requirement of requirements) {
    members(requirement, ["id", "path", "predicate", "value"]);
    if (typeof requirement.id !== "string" || requirement.id.length > 128
      || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(requirement.id)
      || requirement.predicate !== "contains" || !scalar(requirement.value)) invalid();
    pointer(requirement.path);
    if (requirement.path === "/settings/record_extensions"
      && (typeof requirement.value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/u.test(requirement.value))) invalid();
    if (indexed.has(requirement.id)) invalid();
    indexed.set(requirement.id, requirement);
  }
  const linked = new Set();
  for (const provision of provisions) {
    members(provision, ["requirement", "operation", "path", "value"]);
    const requirement = indexed.get(provision.requirement);
    if (provision.operation !== "set_add" || !scalar(provision.value)
      || !requirement || provision.path !== requirement.path || provision.value !== requirement.value
      || linked.has(provision.requirement)) invalid();
    linked.add(provision.requirement);
  }
  if (linked.size !== indexed.size) invalid();
}

/** Lift validated catalog clauses into CollectionSetup (identity/type packs supplied by installer). */
export function liftConfigurationSetup(setup) {
  validateConfigurationSetup(setup);
  const configuration = setup?.configuration ?? { requirements: [], provisions: [] };
  return structuredClone({
    requirements: { configuration: configuration.requirements },
    provisions: { configuration: configuration.provisions },
  });
}
