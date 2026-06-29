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
import { MAX_DASHBOARD_PAGE_SIZE, DEFAULT_DASHBOARD_PAGE_SIZE } from './descriptor.js';
// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
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
export function searchRecords(records, term, searchableAttributes, page) {
    const normalizedTerm = term.trim().toLowerCase();
    const matches = normalizedTerm === ''
        ? // Empty/whitespace term: no search filter, every record matches.
            records.slice()
        : records.filter((record) => searchableAttributes.some((attribute) => valueContains(record[attribute], normalizedTerm)));
    return paginate(matches, page);
}
// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------
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
export function filterRecords(records, filters, page) {
    const matches = records.filter((record) => filters.every((filter) => satisfiesFilter(record[filter.attribute], filter)));
    return paginate(matches, page);
}
// ---------------------------------------------------------------------------
// Matching primitives
// ---------------------------------------------------------------------------
/**
 * Whether a record value contains `normalizedTerm` (already lower-cased) as a
 * substring. `null` / `undefined` values never match. All other values are
 * coerced to their string form and lower-cased for a case-insensitive compare.
 */
function valueContains(value, normalizedTerm) {
    if (value === null || value === undefined) {
        return false;
    }
    return String(value).toLowerCase().includes(normalizedTerm);
}
/**
 * Whether a single record value satisfies a filter condition.
 *
 * - `eq` / `neq` use strict equality on the raw values (`Object.is`), so type
 *   mismatches (e.g. number 1 vs string "1") are treated as not equal.
 * - `contains` reuses the case-insensitive substring match.
 * - `gt` / `gte` / `lt` / `lte` compare via {@link compareValues}; if the two
 *   values are not order-comparable (different/uncomparable types), the
 *   condition is not satisfied.
 */
function satisfiesFilter(value, filter) {
    switch (filter.operator) {
        case 'eq':
            return Object.is(value, filter.value);
        case 'neq':
            return !Object.is(value, filter.value);
        case 'contains': {
            if (filter.value === null || filter.value === undefined) {
                return false;
            }
            return valueContains(value, String(filter.value).toLowerCase());
        }
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
            const cmp = compareValues(value, filter.value);
            if (cmp === undefined) {
                return false;
            }
            switch (filter.operator) {
                case 'gt':
                    return cmp > 0;
                case 'gte':
                    return cmp >= 0;
                case 'lt':
                    return cmp < 0;
                case 'lte':
                    return cmp <= 0;
            }
        }
    }
}
/**
 * Compare two values for ordered operators. Returns a negative number when
 * `a < b`, zero when equal, a positive number when `a > b`, or `undefined`
 * when the values are not order-comparable.
 *
 * Comparable pairs: number/number, string/string, boolean/boolean, and Date
 * (or date-like values) compared by time. Anything else is uncomparable.
 */
function compareValues(a, b) {
    if (typeof a === 'number' && typeof b === 'number') {
        return a - b;
    }
    if (typeof a === 'string' && typeof b === 'string') {
        return a < b ? -1 : a > b ? 1 : 0;
    }
    if (typeof a === 'boolean' && typeof b === 'boolean') {
        return Number(a) - Number(b);
    }
    if (a instanceof Date && b instanceof Date) {
        return a.getTime() - b.getTime();
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Pagination / bounding
// ---------------------------------------------------------------------------
/**
 * Slice the matching records into the requested page and wrap them in a
 * {@link QueryResult}.
 *
 * Bounding (Req 7.6): the page size is clamped to the inclusive range
 * [1, {@link MAX_DASHBOARD_PAGE_SIZE}] (100), so a returned page never exceeds
 * 100 records regardless of the caller's request. The page index is clamped to
 * be at least 1. When the requested page is past the end of the data, the
 * returned `records` is empty but `isEmpty` reflects whether there were *any*
 * matches at all (Req 7.8) rather than whether this particular page is empty.
 */
function paginate(matches, page) {
    const pageSize = clampPageSize(page?.size);
    const pageIndex = clampPageIndex(page?.page);
    const start = (pageIndex - 1) * pageSize;
    const records = matches.slice(start, start + pageSize);
    return {
        records,
        total: matches.length,
        // Empty-result indication is about the match set as a whole (Req 7.8),
        // not about an out-of-range page being empty.
        isEmpty: matches.length === 0,
        page: pageIndex,
        pageSize,
    };
}
/**
 * Clamp a requested page size into [1, {@link MAX_DASHBOARD_PAGE_SIZE}],
 * defaulting to {@link DEFAULT_DASHBOARD_PAGE_SIZE} when unspecified or
 * invalid (non-finite). Guarantees no page exceeds 100 records (Req 7.6).
 */
function clampPageSize(size) {
    if (size === undefined || !Number.isFinite(size)) {
        return DEFAULT_DASHBOARD_PAGE_SIZE;
    }
    const floored = Math.floor(size);
    if (floored < 1) {
        return 1;
    }
    if (floored > MAX_DASHBOARD_PAGE_SIZE) {
        return MAX_DASHBOARD_PAGE_SIZE;
    }
    return floored;
}
/**
 * Clamp a requested 1-based page index to be at least 1, defaulting to 1 when
 * unspecified or invalid (non-finite).
 */
function clampPageIndex(page) {
    if (page === undefined || !Number.isFinite(page)) {
        return 1;
    }
    const floored = Math.floor(page);
    return floored < 1 ? 1 : floored;
}
//# sourceMappingURL=query.js.map