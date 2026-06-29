/**
 * A deterministic, offline "stub" model generator for the Modeling_Engine.
 *
 * This is NOT real inference — real inference is the {@link import('./httpLlmClient.js').HttpLlmClient}.
 * It is a small, dependency-free heuristic so the system runs end to end with
 * no LLM key: given a domain prompt it returns a plausible {@link RawCandidateModel}
 * (which the deterministic normalization + constraint-inference pipeline then
 * turns into a well-formed Data_Model). It recognizes a handful of common demo
 * domains by keyword and otherwise derives entities from capitalized nouns in
 * the prompt, falling back to a single generic entity.
 *
 * Wire it into a {@link StubLlmClient} via `new StubLlmClient(heuristicCandidate)`.
 */
const id = { name: 'id', dataType: 'UUID', required: true };
const name = { name: 'name', dataType: 'TEXT', required: true };
const email = { name: 'email', dataType: 'TEXT', unique: true, required: true };
/** A few recognizable demo domains, each a small relational model. */
const DOMAINS = [
    {
        match: ['hotel', 'booking', 'room', 'reservation'],
        model: {
            entities: [
                { name: 'Hotel', attributes: [id, name, { name: 'city', dataType: 'TEXT' }] },
                { name: 'Room', attributes: [id, { name: 'number', dataType: 'TEXT', required: true }, { name: 'price', dataType: 'NUMERIC', required: true }] },
                { name: 'Guest', attributes: [id, name, email] },
                { name: 'Booking', attributes: [id, { name: 'checkIn', dataType: 'DATE', required: true }, { name: 'nights', dataType: 'INTEGER', required: true }] },
            ],
            relationships: [
                { source: 'Room', target: 'Hotel', cardinality: 'ONE_TO_MANY' },
                { source: 'Booking', target: 'Room', cardinality: 'ONE_TO_MANY' },
                { source: 'Booking', target: 'Guest', cardinality: 'ONE_TO_MANY' },
            ],
        },
    },
    {
        match: ['library', 'book', 'borrow', 'loan'],
        model: {
            entities: [
                { name: 'Book', attributes: [id, { name: 'title', dataType: 'TEXT', required: true }, { name: 'isbn', dataType: 'TEXT', unique: true }] },
                { name: 'Member', attributes: [id, name, email] },
                { name: 'Loan', attributes: [id, { name: 'borrowedAt', dataType: 'TIMESTAMP', required: true }, { name: 'dueDate', dataType: 'DATE' }] },
            ],
            relationships: [
                { source: 'Loan', target: 'Book', cardinality: 'ONE_TO_MANY' },
                { source: 'Loan', target: 'Member', cardinality: 'ONE_TO_MANY' },
            ],
        },
    },
    {
        match: ['clinic', 'veterinary', 'patient', 'doctor', 'appointment', 'hospital'],
        model: {
            entities: [
                { name: 'Doctor', attributes: [id, name, { name: 'specialty', dataType: 'TEXT' }] },
                { name: 'Patient', attributes: [id, name, { name: 'age', dataType: 'INTEGER' }] },
                { name: 'Appointment', attributes: [id, { name: 'scheduledAt', dataType: 'TIMESTAMP', required: true }] },
                { name: 'Bill', attributes: [id, { name: 'amount', dataType: 'NUMERIC', required: true }] },
            ],
            relationships: [
                { source: 'Appointment', target: 'Doctor', cardinality: 'ONE_TO_MANY' },
                { source: 'Appointment', target: 'Patient', cardinality: 'ONE_TO_MANY' },
                { source: 'Bill', target: 'Patient', cardinality: 'ONE_TO_MANY' },
            ],
        },
    },
    {
        match: ['shop', 'store', 'ecommerce', 'e-commerce', 'order', 'product', 'cart'],
        model: {
            entities: [
                { name: 'Customer', attributes: [id, name, email] },
                { name: 'Product', attributes: [id, name, { name: 'price', dataType: 'NUMERIC', required: true }, { name: 'stock', dataType: 'INTEGER' }] },
                { name: 'Order', attributes: [id, { name: 'placedAt', dataType: 'TIMESTAMP', required: true }, { name: 'status', dataType: 'TEXT' }] },
                { name: 'OrderItem', attributes: [id, { name: 'quantity', dataType: 'INTEGER', required: true }] },
            ],
            relationships: [
                { source: 'Order', target: 'Customer', cardinality: 'ONE_TO_MANY' },
                { source: 'OrderItem', target: 'Order', cardinality: 'ONE_TO_MANY' },
                { source: 'OrderItem', target: 'Product', cardinality: 'ONE_TO_MANY' },
            ],
        },
    },
];
/** Title-case a token for use as an entity name. */
function titleCase(token) {
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}
/**
 * Derive a {@link RawCandidateModel} from a domain prompt using simple,
 * deterministic heuristics. Always returns at least one entity for a non-empty
 * prompt so the offline pipeline produces a usable backend.
 */
export function heuristicCandidate(prompt) {
    const lower = prompt.toLowerCase();
    // 1) Known demo domains by keyword.
    for (const domain of DOMAINS) {
        if (domain.match.some((kw) => lower.includes(kw))) {
            return domain.model;
        }
    }
    // 2) Otherwise, derive entities from capitalized nouns in the prompt.
    const capitalized = Array.from(new Set((prompt.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [])
        .map((w) => titleCase(w))
        // Drop common leading verbs/filler that aren't entities.
        .filter((w) => !['Build', 'Create', 'Make', 'Generate', 'System', 'App', 'The'].includes(w)))).slice(0, 5);
    if (capitalized.length > 0) {
        return {
            entities: capitalized.map((entityName) => ({
                name: entityName,
                attributes: [id, name, { name: 'createdAt', dataType: 'TIMESTAMP' }],
            })),
            relationships: [],
        };
    }
    // 3) Last resort: a single generic entity so generation still succeeds.
    return {
        entities: [
            {
                name: 'Item',
                attributes: [id, name, { name: 'description', dataType: 'TEXT' }, { name: 'createdAt', dataType: 'TIMESTAMP' }],
            },
        ],
        relationships: [],
    };
}
//# sourceMappingURL=heuristicStub.js.map