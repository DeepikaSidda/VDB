/**
 * Admin_Dashboard descriptor generation.
 *
 * The Admin_Dashboard is a descriptor-driven projection of the Data_Model:
 * the generated Next.js views render entirely from a `DashboardDescriptor`
 * that this module produces. Keeping descriptor generation a pure function of
 * the Data_Model (the "one IR, many projections" principle) makes the
 * dashboard's structure deterministic and directly testable against the model.
 *
 * This module covers descriptor generation only (Req 7.1, 7.2). The search /
 * filter query logic that consumes `searchableAttributes` /
 * `filterableAttributes` lives separately.
 */
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
/**
 * Default dashboard page size. Must be <= 100 (Req 7.2) and is kept
 * consistent with the generated CRUD API's default list page size of 25
 * (Req 5.8) so the dashboard and API paginate identically by default.
 */
export const DEFAULT_DASHBOARD_PAGE_SIZE = 25;
/** Hard upper bound on dashboard page size (Req 7.2 / 7.6). */
export const MAX_DASHBOARD_PAGE_SIZE = 100;
/**
 * Data types treated as textual for search purposes. Search matching is a
 * substring "contains" check (Req 7.6), which is only meaningful for text
 * columns, so only these types are declared searchable.
 */
const TEXTUAL_DATA_TYPES = new Set([
    'TEXT',
    'VARCHAR',
]);
// ---------------------------------------------------------------------------
// Descriptor generation
// ---------------------------------------------------------------------------
/**
 * Generate the dashboard descriptor for a Data_Model.
 *
 * Pure function: same model in, same descriptor out, with no side effects.
 *
 * Design decisions:
 * - **Entity set equals the model's entity set (Req 7.1).** Every entity in
 *   the model — including synthesized many-to-many join entities — produces
 *   exactly one `EntityView`, in model order. Join entities hold real,
 *   manageable rows (the M:N association records), so including them keeps the
 *   dashboard's navigable set identical to the model's entity set.
 * - **Page size (Req 7.2).** Each view uses {@link DEFAULT_DASHBOARD_PAGE_SIZE}
 *   (25), which is <= the 100-record bound and matches the CRUD API default.
 * - **Searchable attributes.** Only textual attributes (TEXT / VARCHAR), since
 *   search is a substring "contains" match (Req 7.6) that only makes sense for
 *   text columns.
 * - **Filterable attributes.** All attributes. Every supported `DataType` is a
 *   scalar value that can back an equality/range filter, so the dashboard
 *   exposes a filter on each column (Req 7.7).
 */
export function generateDescriptor(model) {
    return {
        entities: model.entities.map((entity) => toEntityView(entity)),
    };
}
/**
 * Project a single entity into its dashboard view.
 */
function toEntityView(entity) {
    const primaryKey = new Set(entity.primaryKey);
    const columns = entity.attributes.map((attribute) => toColumnView(attribute, primaryKey));
    const searchableAttributes = entity.attributes
        .filter((attribute) => TEXTUAL_DATA_TYPES.has(attribute.dataType))
        .map((attribute) => attribute.name);
    // All attributes are filterable: every supported DataType is a scalar that
    // can back a filter condition (Req 7.7).
    const filterableAttributes = entity.attributes.map((attribute) => attribute.name);
    return {
        entityName: entity.name,
        columns,
        pageSize: DEFAULT_DASHBOARD_PAGE_SIZE,
        searchableAttributes,
        filterableAttributes,
    };
}
/**
 * Project a single attribute into its column view, surfacing constraint flags.
 */
function toColumnView(attribute, primaryKey) {
    return {
        name: attribute.name,
        dataType: attribute.dataType,
        // An attribute is part of the PK if it appears in the entity's primaryKey
        // list or carries an explicit PRIMARY_KEY constraint.
        isPrimaryKey: primaryKey.has(attribute.name) ||
            hasConstraint(attribute.constraints, 'PRIMARY_KEY'),
        isUnique: hasConstraint(attribute.constraints, 'UNIQUE'),
        isNotNull: hasConstraint(attribute.constraints, 'NOT_NULL'),
        isForeignKey: hasConstraint(attribute.constraints, 'FOREIGN_KEY'),
    };
}
/**
 * Whether an attribute carries a constraint of the given kind.
 */
function hasConstraint(constraints, kind) {
    return constraints.some((constraint) => constraint.kind === kind);
}
//# sourceMappingURL=descriptor.js.map