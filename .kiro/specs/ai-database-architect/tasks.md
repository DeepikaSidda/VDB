# Implementation Plan: AI Database Architect

## Overview

This plan builds the AI Database Architect in dependency order, centered on the dialect-independent **Data_Model** intermediate representation. The core IR (types + invariants) is built first, followed by the deterministic projections around it (Schema_Generator, Round-Trip Verifier, API_Generator, Auth_Service, Admin_Dashboard) with the LLM-backed Modeling_Engine/Refinement_Engine stubbed for testing.

Tasks are sequenced so the **[MUST] vertical slice** (Prompt → Data_Model → refinement → Aurora PostgreSQL schema → live deploy → CRUD APIs + role-based auth + admin dashboard) is demoable as early as possible. **[SECONDARY]** (Document-to-Backend) and **[STRETCH]** (Existing-DB import, Aurora DSQL/DynamoDB targets) come last and are clearly marked.

Implementation language is **TypeScript**. Property-based tests use **fast-check** (minimum 100 iterations each), tagged `Feature: ai-database-architect, Property {number}: {property_text}`. The LLM is stubbed in property/unit tests; live-AWS behavior is covered by integration and smoke tests.

## Tasks

- [x] 1. Set up project structure and the Data_Model IR
  - [x] 1.1 Scaffold the TypeScript backend project and test tooling
    - Initialize TypeScript project (tsconfig, package.json) for the backend engine
    - Add and configure the test runner and `fast-check` for property-based testing
    - Create the directory structure: `src/model`, `src/modeling`, `src/schema`, `src/provisioner`, `src/api`, `src/auth`, `src/dashboard`, `src/orchestrator`, and matching `test` folders
    - Define a shared `Result<T, E>` type used across all component boundaries (fail-closed discipline)
    - _Requirements: foundational (Design: Technology Stack, Error Handling)_

  - [x] 1.2 Define the Data_Model IR types
    - Implement `DataModel`, `Entity`, `Attribute`, `DataType`, `AttributeConstraint`, and `Relationship` types in `src/model/types.ts` exactly as specified in the design's Data Models section
    - Include `GenerationStage`, `GenerationJob`, `MigrationScript`, `DdlStatement`, `DeploymentTarget`, and `DeployResult` types
    - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 1.3 Implement Data_Model invariant validators
    - Implement validators for invariants I1–I6 (single non-empty PK per entity, typed attributes, valid cardinality, M:N join entities present, FK targets exist, relationship referential closure) in `src/model/invariants.ts`
    - Return typed errors identifying the violating element
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 2.5, 2.6_

  - [x]* 1.4 Write unit tests for invariant validators
    - Test each invariant (I1–I6) with passing and violating Data_Models
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 2.5, 2.6_

- [x] 2. Implement the Modeling_Engine (LLM stubbable)
  - [x] 2.1 Implement input validation and the LLM client interface
    - Implement prompt validation for empty/whitespace and the 10,000-character limit in `src/modeling/modelingEngine.ts` (reject before calling the LLM)
    - Define an `LlmClient` interface in `src/modeling/llmClient.ts` and a stub implementation that returns arbitrary raw candidate models for testing
    - _Requirements: 1.6, 1.7_

  - [x] 2.2 Implement deterministic post-processing of raw candidate models
    - Implement `inferFromPrompt`: call the LLM, then normalize to guarantee structural invariants — assign exactly one PK per entity (synthesize surrogate `id` when none inferred), normalize relationship cardinality, assign exactly one supported data type per attribute, and materialize a join entity for each many-to-many relationship referencing both PKs
    - Fail closed with a "no Data_Model could be derived" error when no entity can be inferred
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.8, 2.6_

  - [x] 2.3 Implement constraint inference
    - In `src/modeling/constraints.ts`, attach unique and not-null constraints, an email-format validator/constraint, numeric range constraints (min 0 for count/quantity/age/price), and foreign-key constraints for relationships referencing the target entity's PK
    - Flag low-confidence attributes with `needsReview` rather than guessing a constraint
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7_

  - [x]* 2.4 Write property test for well-formed modeling structure
    - **Property 1: Modeling produces well-formed structure**
    - **Validates: Requirements 1.1**

  - [x]* 2.5 Write property test for primary key assignment
    - **Property 2: Exactly one primary key per entity**
    - **Validates: Requirements 1.2, 2.6**

  - [x]* 2.6 Write property test for relationship cardinality
    - **Property 3: Relationship cardinality is always valid**
    - **Validates: Requirements 1.3**

  - [x]* 2.7 Write property test for attribute data types
    - **Property 4: Every attribute has exactly one supported data type**
    - **Validates: Requirements 1.4**

  - [x]* 2.8 Write property test for many-to-many join entities
    - **Property 5: Many-to-many relationships materialize a join entity**
    - **Validates: Requirements 1.5**

  - [x]* 2.9 Write property test for empty/whitespace rejection
    - **Property 6: Empty or whitespace input is rejected**
    - **Validates: Requirements 1.6**

  - [x]* 2.10 Write property test for email format constraint
    - **Property 7: Email format constraint accepts exactly the well-formed emails**
    - **Validates: Requirements 2.3**

  - [x]* 2.11 Write property test for numeric range constraint
    - **Property 8: Numeric range constraint inference and enforcement**
    - **Validates: Requirements 2.4**

  - [x]* 2.12 Write unit tests for modeling edge cases
    - Test length-boundary rejection just above 10,000 characters (1.7), the no-entity-inferred fail-closed path (1.8), and low-confidence `needsReview` flagging (2.7)
    - _Requirements: 1.7, 1.8, 2.7_

- [x] 3. Implement the Schema_Generator (Aurora PostgreSQL)
  - [x] 3.1 Implement DDL generation for the PostgreSQL target
    - In `src/schema/schemaGenerator.ts`, implement `generate(model, target)` producing one `CREATE TABLE` per entity with mapped column types, primary key (composite PK as a single constraint), foreign-key constraints, unique/not-null column constraints, and exactly one index per foreign-key column
    - Apply the fixed DataType → PostgreSQL mapping table from the design
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 3.2 Implement topological ordering and error handling
    - Topologically order statements so referenced tables precede referencing tables
    - Return errors emitting no DDL on: relationship to an undefined entity, unmappable data type, and cyclic dependency with no valid ordering; never emit a partial script
    - _Requirements: 3.6, 3.7, 3.8, 3.9, 3.10_

  - [x]* 3.3 Write property test for relationship foreign keys in DDL
    - **Property 9: Relationships produce foreign-key constraints to the target primary key**
    - **Validates: Requirements 2.5, 3.3**

  - [x]* 3.4 Write property test for foreign-key indexes
    - **Property 10: Exactly one index per foreign-key column**
    - **Validates: Requirements 3.5**

  - [x]* 3.5 Write property test for topological ordering
    - **Property 11: Migration script is topologically ordered**
    - **Validates: Requirements 3.6**

  - [x]* 3.6 Write property test for dangling relationship targets
    - **Property 12: Dangling relationship targets are rejected**
    - **Validates: Requirements 3.7**

  - [x]* 3.7 Write property test for cyclic dependency rejection
    - **Property 13: Unorderable cyclic dependencies are rejected**
    - **Validates: Requirements 3.9**

  - [x]* 3.8 Write property test for fail-closed error output
    - **Property 14: Errors leave no partial output (fail closed)**
    - **Validates: Requirements 3.10**

  - [x]* 3.9 Write unit test for the unmappable data type path
    - Test that an unmappable column type returns an error identifying the column and type and emits no DDL for that table
    - _Requirements: 3.8_

- [x] 4. Implement the Round-Trip Verifier (deploy gate)
  - [x] 4.1 Implement DDL parsing back into a Data_Model
    - In `src/schema/roundTripVerifier.ts`, implement `parseDDL` using a PostgreSQL grammar parser to reconstruct entities, relationships, and constraints from the generated migration script
    - _Requirements: 12.2, 12.3, 12.4_

  - [x] 4.2 Implement structural comparison and fail-closed gate
    - Implement `verify(ddl, source)` comparing entity sets (name + attribute names + types), relationship sets (source, target, cardinality), and constraint sets (PK, FK, unique, nullability), plus table count equals entity count
    - On any added/lost/altered element, reject the DDL, report the specific diff, and leave the source Data_Model unchanged
    - _Requirements: 12.1, 12.5_

  - [x]* 4.3 Write property test for round-trip entity preservation
    - **Property 15: Round-trip preserves entities**
    - **Validates: Requirements 12.2, 12.1**

  - [x]* 4.4 Write property test for round-trip relationship preservation
    - **Property 16: Round-trip preserves relationships**
    - **Validates: Requirements 12.3**

  - [x]* 4.5 Write property test for round-trip constraint preservation
    - **Property 17: Round-trip preserves constraints**
    - **Validates: Requirements 12.1, 12.4, 3.1, 3.2, 3.4, 2.1, 2.2**

  - [x]* 4.6 Write property test for round-trip mismatch fail-closed
    - **Property 18: Round-trip mismatch fails closed**
    - **Validates: Requirements 12.5**

- [x] 5. Checkpoint - model and schema generation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the Provisioner / Migration Runner
  - [x] 6.1 Implement atomic migration application with rollback
    - In `src/provisioner/provisioner.ts`, implement `apply(script, target)` that connects within 30s (connectivity error otherwise), applies the whole script in a single transaction, commits only on full success (status `deployed`) within the 300s ceiling, and rolls back to the pre-migration state on any statement failure (status `failed` with reason)
    - Route Aurora PostgreSQL jobs to an Aurora PostgreSQL target
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x]* 6.2 Write property test for migration rollback completeness
    - **Property 19: Failed migration rolls back completely**
    - Run against a transactional fake/in-memory store
    - **Validates: Requirements 4.4**

  - [x]* 6.3 Write integration tests for live migration behavior
    - Migration applies to a live Aurora PostgreSQL target within 300s and records `deployed` on full success; failure records `failed` with a reason and rolls back; connectivity timeout against an unreachable endpoint
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 7. Implement the API_Generator and CRUD runtime
  - [x] 7.1 Implement CRUD endpoint generation per entity
    - In `src/api/apiGenerator.ts`, implement `generate(model)` producing create/read/update/delete/list operations for every entity
    - _Requirements: 5.1_

  - [x] 7.2 Implement the generated CRUD runtime with validation
    - In `src/api/crudRuntime.ts`, implement per-entity create/read/update/delete/list against the store: persist and return created/updated records with assigned PK, return records on read, confirm deletes, validate payloads against Data_Model constraints (reject with per-constraint errors and zero persistence), return not-found for absent PKs, default list page size 25 ordered by PK ascending, and reject page sizes outside [1,100]
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

  - [x]* 7.3 Write property test for CRUD surface completeness
    - **Property 20: CRUD surface is complete for every entity**
    - **Validates: Requirements 5.1**

  - [x]* 7.4 Write property test for create/read/update round-trip
    - **Property 21: Create/read/update round-trip preserves records**
    - **Validates: Requirements 5.2, 5.3, 5.4**

  - [x]* 7.5 Write property test for delete
    - **Property 22: Delete removes the record**
    - **Validates: Requirements 5.5**

  - [x]* 7.6 Write property test for constraint-violating payloads
    - **Property 23: Constraint-violating payloads are rejected without persistence**
    - **Validates: Requirements 5.6**

  - [x]* 7.7 Write property test for absent primary key operations
    - **Property 24: Operations on absent primary keys are not-found and inert**
    - **Validates: Requirements 5.7**

  - [x]* 7.8 Write property test for default list pagination
    - **Property 25: Default list pagination**
    - **Validates: Requirements 5.8**

  - [x]* 7.9 Write property test for page size bounds
    - **Property 26: List/display page size bounds**
    - **Validates: Requirements 5.9, 7.2**

- [x] 8. Implement the Auth_Service
  - [x] 8.1 Implement signup, login, and token issuance
    - In `src/auth/authService.ts`, implement `signup` (store one-way password hash, never plaintext; reject missing credentials; reject duplicate identifiers) and `login` (issue JWT expiring ≤ 24h on matching credentials; reject invalid credentials without issuing a token)
    - _Requirements: 6.1, 6.2, 6.3, 6.7, 6.8_

  - [x] 8.2 Implement authorization middleware and roles
    - Implement `authorize` that executes only with a present/well-formed/unexpired token and sufficient role; reject missing/malformed/expired tokens (token error) and insufficient role (permission error) without executing the operation
    - Define at least two roles (e.g., `admin`, `viewer`) differing by at least one permission
    - _Requirements: 6.4, 6.5, 6.6_

  - [x]* 8.3 Write property test for password hashing
    - **Property 27: Passwords are stored hashed, never plaintext**
    - **Validates: Requirements 6.1**

  - [x]* 8.4 Write property test for valid login token lifetime
    - **Property 28: Valid login issues a bounded-lifetime token**
    - **Validates: Requirements 6.2**

  - [x]* 8.5 Write property test for invalid login
    - **Property 29: Invalid login issues no token**
    - **Validates: Requirements 6.3**

  - [x]* 8.6 Write property test for authorization
    - **Property 30: Authorization executes only with a valid token and sufficient role**
    - **Validates: Requirements 6.4, 6.5**

  - [x]* 8.7 Write property test for signup missing credentials
    - **Property 31: Signup missing a credential is rejected**
    - **Validates: Requirements 6.7**

  - [x]* 8.8 Write property test for duplicate identifiers
    - **Property 32: Duplicate identifiers are rejected**
    - **Validates: Requirements 6.8**

  - [x]* 8.9 Write smoke test for role configuration
    - Verify at least two roles exist with differing permission sets
    - _Requirements: 6.6_

- [x] 9. Implement the Refinement_Engine
  - [x] 9.1 Implement question derivation and answer application
    - In `src/refinement/refinementEngine.ts`, implement `deriveQuestions` (1–10 questions each grounded in an entity/attribute/relationship; zero questions and proceed when nothing can ground a question) and `applyAnswers` (update model reflecting each answer, retain all uncontradicted elements, add elements for opt-in features, and reject conflicting answers leaving the model unchanged while identifying the conflict)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [x]* 9.2 Write property test for clarifying questions
    - **Property 35: Clarifying questions are bounded and grounded**
    - **Validates: Requirements 8.1**

  - [x]* 9.3 Write property test for applying valid answers
    - **Property 36: Applying valid answers retains uncontradicted elements and reflects answers**
    - **Validates: Requirements 8.3, 8.4**

  - [x]* 9.4 Write property test for conflicting answers
    - **Property 37: Conflicting answers leave the model unchanged**
    - **Validates: Requirements 8.5**

  - [x]* 9.5 Write unit tests for refinement edge cases
    - Test the skip path returns the initial model unchanged (8.6) and an empty model yields zero questions (8.2)
    - _Requirements: 8.2, 8.6_

- [x] 10. Implement the Admin_Dashboard descriptor and query logic
  - [x] 10.1 Implement the dashboard descriptor generation
    - In `src/dashboard/descriptor.ts`, generate a `DashboardDescriptor` whose navigable entity list equals the model's entities, with each `EntityView` using a page size ≤ 100 and declared searchable/filterable attributes
    - _Requirements: 7.1, 7.2_

  - [x] 10.2 Implement search and filter query logic
    - Implement search returning only records whose attribute values contain the term and filters returning only records satisfying the condition, bounded to ≤ 100 records per page, with an empty-result indication when nothing matches
    - _Requirements: 7.6, 7.7, 7.8_

  - [x]* 10.3 Write property test for dashboard entity listing
    - **Property 33: Dashboard lists exactly the model's entities**
    - **Validates: Requirements 7.1**

  - [x]* 10.4 Write property test for search and filter
    - **Property 34: Search and filter return exactly the matching records**
    - **Validates: Requirements 7.6, 7.7, 7.8**

- [x] 11. Implement the Generation_Job Orchestrator state machine
  - [x] 11.1 Implement the state machine and stage publishing
    - In `src/orchestrator/orchestrator.ts`, implement the SUBMITTED → MODELING → REFINING → SCHEMA_GEN → VERIFYING → DEPLOYING → API_GEN → DEPLOYED transitions, wiring each stage to its component, and expose `currentStage` reflecting the most recent transition
    - Surface a "30s not guaranteed" notice before starting when the accepted model has > 10 entities
    - _Requirements: 9.2, 9.5_

  - [x] 11.2 Implement timeout enforcement and compensation
    - Enforce the 30s soft target and 60s hard ceiling; on breach transition to FAILED with the active stage name in the timeout report and run compensation to discard partial artifacts so no Data_Model remains in `deployed` status
    - _Requirements: 9.3, 9.4_

  - [x]* 11.3 Write property test for stage reporting
    - **Property 38: Reported stage reflects the latest transition**
    - **Validates: Requirements 9.2**

  - [x]* 11.4 Write property test for timeout safety
    - **Property 39: Timeout safety**
    - Drive the orchestrator with a controllable clock
    - **Validates: Requirements 9.3, 9.4**

  - [x]* 11.5 Write property test for the large-model warning boundary
    - **Property 40: Large-model warning boundary**
    - **Validates: Requirements 9.5**

- [x] 12. Wire the [MUST] vertical slice end to end
  - [x] 12.1 Wire the backend pipeline through the orchestrator
    - Connect Modeling_Engine → Refinement_Engine → Schema_Generator → Round-Trip Verifier (deploy gate) → Provisioner → API_Generator/Auth/Dashboard into a single `run(input)` path producing a live backend + dashboard descriptor, with the round-trip gate blocking deploy on mismatch
    - _Requirements: 1.1, 3.1, 4.2, 5.1, 6.6, 7.1, 12.5_

  - [x] 12.2 Scaffold the Next.js frontend (Vercel)
    - Build the prompt input, refinement question UI, and job-status view that polls/streams the orchestrator's `currentStage` and renders the failing stage/reason on failure; render the generated Admin_Dashboard views from the descriptor and wire create/edit/delete actions to the generated CRUD APIs (reflect updated state on success, leave records unchanged with an error on failure)
    - _Requirements: 7.3, 7.4, 7.5, 9.2_

  - [x]* 12.3 Write unit/interaction tests for dashboard action wiring
    - Test that create/edit/delete invoke the correct API, success updates the view, and failure leaves it unchanged with an error indication
    - _Requirements: 7.3, 7.4, 7.5_

  - [x]* 12.4 Write integration test for end-to-end generation timing
    - Verify a small-model job advances from submitted to deployed within 30s and stage updates appear within 2s of transitions
    - _Requirements: 9.1, 9.2_

- [x] 13. Checkpoint - [MUST] vertical slice demoable
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Implement Document-to-Backend ingestion [SECONDARY]
  - [x] 14.1 Implement the Document_Parser
    - In `src/document/documentParser.ts`, implement `parse(file)` accepting CSV/Excel/PDF up to 50 MB and extracting named-field records; reject unsupported formats, unparseable files, empty extractions, and oversize files, retaining no records on error
    - _Requirements: 10.1, 10.4, 10.5, 10.6, 10.7_

  - [x] 14.2 Implement record-to-model inference in the Modeling_Engine
    - Implement `inferFromRecords`: detect repeating field groups (two or more fields whose values repeat across two or more records) to split into separate entities rather than one flat table, producing a Data_Model satisfying the same invariants as a prompt-derived model
    - _Requirements: 10.2, 10.3_

  - [x]* 14.3 Write property test for repeating field groups
    - **Property 41: Repeating field groups become separate entities**
    - **Validates: Requirements 10.2**

  - [x]* 14.4 Write property test for document-derived model invariants
    - **Property 42: Document-derived models satisfy the modeling invariants**
    - **Validates: Requirements 10.3**

  - [x]* 14.5 Write property test for unsupported upload formats
    - **Property 43: Unsupported upload formats are rejected**
    - **Validates: Requirements 10.4**

  - [x]* 14.6 Write tests for document parser edge cases and extraction
    - Unit tests for corrupt-file, empty-file, and oversize-file paths; integration test for Excel/PDF extraction timing and fidelity
    - _Requirements: 10.1, 10.5, 10.6, 10.7_

- [x] 15. Implement Existing-DB import and alternative targets [STRETCH]
  - [x] 15.1 Implement the Import_Analyzer
    - In `src/import/importAnalyzer.ts`, implement `importSchema` (connect within 30s; extract tables/columns/types/PKs/FKs/indexes into a Data_Model; record unsupported elements with a not-extracted indicator and continue; distinguish connection-timeout vs authentication failure leaving any existing model unchanged) and `suggest` (normalization up to 3NF, missing-PK, and missing-FK suggestions)
    - _Requirements: 11.1, 11.2, 11.3, 11.5_

  - [x] 15.2 Implement alternative target projections
    - Add Aurora DSQL and DynamoDB `TargetProjection` plug-ins in `src/schema/targets/`: one table per entity with a designated primary key (DSQL also emits columns and types); DynamoDB returns a report of constraints/relationships not represented; unsupported targets return a validation error listing supported targets
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [x]* 15.3 Write property test for import suggestions
    - **Property 44: Import suggestions identify each detectable issue**
    - **Validates: Requirements 11.3**

  - [x]* 15.4 Write property test for alternative target table generation
    - **Property 45: Alternative targets generate one table per entity with a primary key**
    - **Validates: Requirements 13.1, 13.2**

  - [x]* 15.5 Write property test for DynamoDB unrepresented-element report
    - **Property 46: DynamoDB reports unrepresented constraints and relationships**
    - **Validates: Requirements 13.3**

  - [x]* 15.6 Write tests for import connectivity and unsupported targets
    - Integration test for import connect/extract and timeout-vs-auth distinction (11.1, 11.5); unit test for the unsupported-target validation path (13.4)
    - _Requirements: 11.1, 11.5, 13.4_

- [x] 16. Final checkpoint - ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP, but they encode the design's correctness guarantees and are recommended.
- Each property test must run a minimum of 100 generated cases and be tagged `Feature: ai-database-architect, Property {number}: {property_text}`.
- The LLM is stubbed in all property and unit tests; only Modeling_Engine and Refinement_Engine call it at runtime.
- The [MUST] vertical slice (Tasks 1–13) is the primary demo path and should be completed first. [SECONDARY] (Task 14) and [STRETCH] (Task 15) follow only if time allows.
- The round-trip verifier is the deploy gate: VERIFYING must pass before DEPLOYING so a lossy schema can never reach the live target.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "2.1"] },
    { "id": 3, "tasks": ["1.4", "2.2"] },
    { "id": 4, "tasks": ["2.3"] },
    { "id": 5, "tasks": ["3.1", "8.1", "9.1", "10.1", "11.1"] },
    { "id": 6, "tasks": ["3.2", "6.1", "7.1", "8.2", "10.2", "11.2", "14.1", "15.1"] },
    { "id": 7, "tasks": ["4.1", "7.2", "14.2", "15.2"] },
    { "id": 8, "tasks": ["4.2"] },
    { "id": 9, "tasks": ["2.4", "2.5", "2.6", "2.7", "2.8", "2.9", "2.10", "2.11", "2.12", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "4.3", "4.4", "4.5", "4.6", "6.2", "6.3", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8", "7.9", "8.3", "8.4", "8.5", "8.6", "8.7", "8.8", "8.9", "9.2", "9.3", "9.4", "9.5", "10.3", "10.4", "11.3", "11.4", "11.5", "14.3", "14.4", "14.5", "14.6", "15.3", "15.4", "15.5", "15.6"] },
    { "id": 10, "tasks": ["12.1"] },
    { "id": 11, "tasks": ["12.2"] },
    { "id": 12, "tasks": ["12.3", "12.4"] }
  ]
}
```
