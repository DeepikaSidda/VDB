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
import type { Attribute, DataModel } from '../model/types.js';
/** The CRUD operation an endpoint performs (Req 5.1). */
export type CrudOperation = 'CREATE' | 'READ' | 'UPDATE' | 'DELETE' | 'LIST';
/** The HTTP methods used by the generated CRUD surface. */
export type HttpMethod = 'POST' | 'GET' | 'PUT' | 'DELETE';
/**
 * A single generated endpoint: which CRUD operation it performs, the HTTP
 * method it responds to, and the path it is mounted at.
 */
export type EndpointDescriptor = {
    /** The CRUD operation this endpoint performs. */
    operation: CrudOperation;
    /** The HTTP method the endpoint responds to. */
    method: HttpMethod;
    /**
     * The path the endpoint is mounted at. Collection paths are the entity's
     * base path (e.g. `/booking`); single-record paths append `/{id}`
     * (e.g. `/booking/{id}`), where `{id}` is the primary-key path parameter.
     */
    path: string;
};
/**
 * The generated API surface for a single entity: its identifying metadata, the
 * primary key used to address single records, the five CRUD endpoints, and a
 * reference to the entity's attributes (which carry their constraints) so a
 * runtime has everything it needs to serve and validate requests.
 */
export type EntityApiDescriptor = {
    /** The name of the entity this API serves (matches `Entity.name`). */
    entityName: string;
    /**
     * The collection base path for the entity, `/` + the lowercased entity name
     * (e.g. `/booking`). Single-record endpoints extend this with `/{id}`.
     */
    basePath: string;
    /**
     * The entity's primary key. A composite primary key has more than one
     * element; the `{id}` path parameter addresses a record by these column(s).
     */
    primaryKey: string[];
    /**
     * The entity's attributes, carried by reference from the model. Each
     * attribute includes its `constraints`, giving the runtime the metadata it
     * needs to validate request payloads (task 7.2).
     */
    attributes: Attribute[];
    /** The five CRUD endpoints for this entity (Req 5.1). */
    endpoints: EndpointDescriptor[];
};
/**
 * The complete generated API surface: one {@link EntityApiDescriptor} per
 * entity in the model, in model order.
 */
export type ApiSurface = {
    entities: EntityApiDescriptor[];
};
/**
 * The path-parameter placeholder used for the primary key in single-record
 * paths. A single, shared constant so the runtime (task 7.2) and the surface
 * agree on the segment name.
 */
export declare const ID_PATH_PARAM = "{id}";
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
export declare function generate(model: DataModel): ApiSurface;
