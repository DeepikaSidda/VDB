/**
 * The Data_Model Intermediate Representation (IR) and the Generation_Job /
 * deployment types that surround it.
 *
 * The Data_Model is the dialect-independent contract between the intelligence
 * layer (Modeling_Engine, Refinement_Engine) and the deterministic
 * transformation layer (Schema_Generator, Round-Trip Verifier, API_Generator,
 * Auth_Service, Admin_Dashboard). Every generator consumes it and the
 * round-trip verifier reconstructs it, so the field names and union member
 * shapes here are a stable, shared contract — they must not drift.
 *
 * Defined exactly as specified in the design's "Data Models" section.
 */
export {};
//# sourceMappingURL=types.js.map