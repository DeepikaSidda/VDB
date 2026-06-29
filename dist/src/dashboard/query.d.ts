/**
 * Admin_Dashboard search and filter query logic.
 *
 * This module is the runtime counterpart to the dashboard descriptor
 * (`descriptor.ts`): the descriptor declares which attributes are
 * `searchableAttributes` / `filterableAttributes`, and the pure functions here
 * consume those declarations to narrow a set of records.
 *
 * It implements three behaviors required of the Admin_Dashboard:
 * - **Search (Req 7.6):** return only records whose attribute values *contain*
 *   the search term (a substring match over the entity's searchable
 *   attributes), bounded to a page of at most 100 records.
 * - **Filter (Req 7.7):** return only records satisfying the filter condition
 *   on an entity attribute.
 * - **Empty result (Req 7.8):** when a search term or filter matches no
 *   records, return an explicit empty-result indication and no records.
 *
 * All functions are pure and deterministic (same inputs → same output, no side
 * effects), which is what lets Property 34 quantify over arbitrary datasets:
 * for any dataset and any search term or attribute filter, the result contains
 * every record that matches and no record that does not, bounded to a page of
 * at most 100 records, with an empty result when nothing matches.
 */
/**
 * A single dashboard row. Records are dialect-independent maps of attribute
 * name to value; values are `unknown` because the dashboard renders whatever
 * the generated CRUD API returns. Matching coerces values to strings only
 * where a textual comparison is needed (see {@link valueContains}).
 */
export type DashboardRecord = Record<string, unknown>;
/**
 * The result of a search or filter query.
 *
 * Carries the bounded page of matching records together with an explicit
 * `isEmpty` indication so Req 7.8 (empty-result indication) is representable
 * without overloading "zero records" with any other meaning. `total` is the
 * count of *all* matching records across pages, so callers can render
 * pagination controls; `records` is only the requested page.
 */
export type QueryResult<T extends DashboardRecord = DashboardRecord> = {
    /** The matching records for the requested page (length <= page size <= 100). */
    records: T[];
    /** Total number of matching records across all pages (Req 7.6 bounding is per page, not total). */
    total: number;
    /** True when no record matched the search term or filter (Req 7.8). */
    isEmpty: boolean;
    /** 1-based page index that was returned. */
    page: number;
    /** Effective page size used (clamped to [1, 100]). */
    pageSize: number;
};
/**
 * A page request. `page` is 1-based. `size` is clamped to the inclusive range
 * [1, {@link MAX_DASHBOARD_PAGE_SIZE}] so no page ever exceeds 100 records
 * (Req 7.6). Both fields are optional; omitted values fall back to page 1 and
 * the default dashboard page size (25, consistent with the CRUD API default).
 */
export type PageRequest = {
    page?: number;
    size?: number;
};
/**
 * The supported filter operators.
 *
 * Equality (`eq`) is the minimum required by Req 7.7; the remaining operators
 * round out a small, predictable set so the dashboard can express the common
 * conditions a builder expects:
 * - `eq` / `neq` — equality / inequality (works for any scalar type).
 * - `contains` — case-insensitive substring match (textual columns).
 * - `gt` / `gte` / `lt` / `lte` — ordered comparison (numbers, dates, strings).
 */
export type FilterOperator = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';
/**
 * A single filter condition on one entity attribute.
 */
export type Filter = {
    /** The attribute (column) name the condition applies to. */
    attribute: string;
    operator: FilterOperator;
    /** The value to compare each record's attribute value against. */
    value: unknown;
};
/**
 * Search records by substring "contains" match over the searchable attributes.
 *
 * Semantics (Req 7.6):
 * - A record matches when **any** of its `searchableAttributes` holds a value
 *   that contains `term` as a substring.
 * - Matching is **case-insensitive**. This is a deliberate, documented choice:
 *   dashboard search is a human-facing convenience, and case-sensitive search
 *   would surprise users typing "acme" expecting to find "ACME Corp". Values
 *   and the term are lower-cased before comparison.
 * - The term is matched against each value's string form (`String(value)`), so
 *   non-text columns are searched by their displayed text. Attributes not
 *   listed in `searchableAttributes` are never consulted.
 * - **Empty / whitespace-only term:** treated as "no search" and matches every
 *   record (still bounded to a page). This mirrors typical dashboard behavior
 *   where clearing the search box restores the full, paged list.
 *
 * The result is always bounded to a page of at most 100 records, and reports
 * `isEmpty: true` with no records when nothing matches (Req 7.8).
 */
export declare function searchRecords<T extends DashboardRecord>(records: readonly T[], term: string, searchableAttributes: readonly string[], page?: PageRequest): QueryResult<T>;
/**
 * Filter records by one or more attribute conditions.
 *
 * Semantics (Req 7.7):
 * - A record is included **iff it satisfies every** provided filter (AND
 *   semantics). AND is chosen because applying multiple filters in a dashboard
 *   conventionally narrows the result set; OR semantics would widen it and
 *   surprise users. Callers wanting OR can run separate queries and union the
 *   results.
 * - An **empty filter list** matches every record (nothing to exclude), still
 *   bounded to a page.
 * - Each condition is evaluated by {@link satisfiesFilter}; a record failing
 *   any single condition is excluded.
 *
 * The result is bounded to a page of at most 100 records and reports
 * `isEmpty: true` with no records when nothing matches (Req 7.8).
 */
export declare function filterRecords<T extends DashboardRecord>(records: readonly T[], filters: readonly Filter[], page?: PageRequest): QueryResult<T>;
