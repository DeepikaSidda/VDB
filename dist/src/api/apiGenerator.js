/**
 * API_Generator — CRUD endpoint surface generation.
 *
 * Deterministic projection of a {@link DataModel} into the *API surface*: the
 * set of REST endpoints that exist for every entity, plus the per-entity
 * metadata a runtime needs to serve them. Like the Schema_Generator and the
 * Admin_Dashboard descriptor, this is a pure function of the Data_Model (the
 * "one IR, many projections" principle), so the generated surface is
 * deterministic and directly testable against the model.
 *
 * Scope of this module (task 7.1 — endpoint generation, Req 5.1):
 * - for every entity, produce the five CRUD operations
 *   (create / read / update / delete / list) as endpoint descriptors, each
 *   carrying its operation kind, HTTP method, and path;
 * - attach the per-entity metadata (entity name, base path, primary key, and a
 *   reference to the entity's attributes/constraints) needed to later serve and
 *   validate requests.
 *
 * Deliberately NOT implemented here (task 7.2, `src/api/crudRuntime.ts`):
 * - the request-handling runtime: persistence, constraint validation, the
 *   created/updated-record responses, not-found handling, and list pagination
 *   (Req 5.2–5.9). This module only describes *what endpoints exist*; the
 *   runtime describes *how they behave*.
 *
 * REST mapping (conventional, one collection per entity):
 *
 *   | Operation | Method | Path                 |
 *   | --------- | ------ | -------------------- |
 *   | CREATE    | POST   | /{entity}            |
 *   | READ      | GET    | /{entity}/{id}       |
 *   | UPDATE    | PUT    | /{entity}/{id}       |
 *   | DELETE    | DELETE | /{entity}/{id}       |
 *   | LIST      | GET    | /{entity}            |
 *
 * Path naming: the base path for an entity is `/` followed by the entity name
 * lowercased (e.g. entity `BookingGuest` -> base path `/bookingguest`). The
 * single-record paths append a `/{id}` path-parameter segment. The descriptor
 * preserves the original `entityName` separately so a runtime can map a path
 * back to the exact entity in the model regardless of casing.
 */
// ---------------------------------------------------------------------------
// Path naming
// ---------------------------------------------------------------------------
/**
 * The path-parameter placeholder used for the primary key in single-record
 * paths. A single, shared constant so the runtime (task 7.2) and the surface
 * agree on the segment name.
 */
export const ID_PATH_PARAM = '{id}';
/**
 * Derive an entity's collection base path: `/` followed by the entity name
 * lowercased. Lowercasing gives conventional, case-insensitive REST collection
 * paths; the original `entityName` is preserved on the descriptor so a runtime
 * can still resolve the path back to the exact entity in the model.
 */
function basePathFor(entity) {
    return `/${entity.name.toLowerCase()}`;
}
// ---------------------------------------------------------------------------
// Endpoint construction
// ---------------------------------------------------------------------------
/**
 * Build the five CRUD endpoint descriptors for an entity, given its base path.
 *
 * Collection endpoints (CREATE, LIST) are mounted at the base path; single-
 * record endpoints (READ, UPDATE, DELETE) append the `{id}` path parameter.
 * The endpoints are emitted in the Req 5.1 order: create, read, update,
 * delete, list.
 */
function buildEndpoints(basePath) {
    const recordPath = `${basePath}/${ID_PATH_PARAM}`;
    return [
        { operation: 'CREATE', method: 'POST', path: basePath },
        { operation: 'READ', method: 'GET', path: recordPath },
        { operation: 'UPDATE', method: 'PUT', path: recordPath },
        { operation: 'DELETE', method: 'DELETE', path: recordPath },
        { operation: 'LIST', method: 'GET', path: basePath },
    ];
}
/**
 * Project a single entity into its API descriptor.
 */
function toEntityApiDescriptor(entity) {
    const basePath = basePathFor(entity);
    return {
        entityName: entity.name,
        basePath,
        // Carry the primary key and attributes by reference from the model so the
        // runtime (task 7.2) can address records and validate payloads.
        primaryKey: entity.primaryKey,
        attributes: entity.attributes,
        endpoints: buildEndpoints(basePath),
    };
}
// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------
/**
 * Generate the CRUD API surface for a Data_Model (Req 5.1).
 *
 * Pure function: same model in, same surface out, with no side effects. Every
 * entity in the model — including synthesized many-to-many join entities,
 * which hold real association records — produces exactly one
 * {@link EntityApiDescriptor} with the full set of five CRUD endpoints, in
 * model order.
 *
 * This is the structural "what endpoints exist" layer; the request-handling
 * runtime (validation, persistence, pagination) is generated separately by the
 * CRUD runtime (task 7.2).
 */
export function generate(model) {
    return {
        entities: model.entities.map((entity) => toEntityApiDescriptor(entity)),
    };
}
//# sourceMappingURL=apiGenerator.js.map