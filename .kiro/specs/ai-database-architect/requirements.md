# Requirements Document

## Introduction

The AI Database Architect is a full-stack application that converts business requirements or source documents into a production-ready relational backend on AWS. Unlike general-purpose AI code generators, the differentiator is intelligent data modeling: inferring entities, relationships, normalization, and constraints, then generating an Amazon Aurora PostgreSQL schema together with CRUD APIs, role-based authentication, and an admin dashboard. The frontend is a Next.js application deployed on Vercel; the backend engine generates and provisions the database and APIs on AWS.

This document captures the complete product vision while making scope and priority explicit so a strong vertical slice can be delivered within a hackathon (weekend-scale) timeline.

### Scope and Priority

Each requirement is tagged with a priority to guide the build:

- **[MUST]** Primary demo path. Required for the hackathon demo. The "wow moment": a user types a domain prompt (for example, "Build a hotel booking system") and within approximately 30 seconds receives a live Aurora PostgreSQL database, working CRUD APIs, an admin dashboard, role-based authentication, and search.
- **[SECONDARY]** Valuable but not required for the core demo. Built if time allows.
- **[STRETCH]** Aspirational. Demonstrates the full vision but may be stubbed or omitted.

The primary database target is Amazon Aurora PostgreSQL. Aurora DSQL and DynamoDB are noted as optional alternative targets.

## Glossary

- **AI_Database_Architect**: The overall full-stack system that transforms inputs into a deployed relational backend.
- **Modeling_Engine**: The component that infers entities, attributes, relationships, normalization, and constraints from an input.
- **Data_Model**: The structured intermediate representation of inferred entities, attributes, relationships, and constraints, independent of any specific database dialect.
- **Schema_Generator**: The component that converts a Data_Model into Aurora PostgreSQL DDL, indexes, constraints, and migration scripts.
- **API_Generator**: The component that generates CRUD REST endpoints from a Data_Model.
- **Auth_Service**: The component that provides signup, login, JWT issuance, roles, and permission enforcement.
- **Admin_Dashboard**: The generated web interface for create, read, update, delete, search, pagination, and filtering operations.
- **Refinement_Engine**: The component that generates clarifying questions and incorporates user selections into the Data_Model.
- **Document_Parser**: The component that extracts structured data from uploaded files (Excel, CSV, PDF).
- **Import_Analyzer**: The component that analyzes an existing external database and produces a Data_Model with improvement suggestions.
- **Deployment_Target**: The provisioned Amazon Aurora PostgreSQL database instance where the generated schema is applied.
- **Generation_Job**: A single end-to-end run that transforms one input into a deployed backend.
- **JWT**: JSON Web Token used to authenticate API requests.
- **DDL**: Data Definition Language statements that define database structure.

## Requirements

### Requirement 1: Prompt to Backend [MUST]

**User Story:** As a builder, I want to describe a domain in natural language, so that the system infers a relational data model for that domain.

#### Acceptance Criteria

1. WHEN a user submits a natural-language domain description of 1 to 10,000 characters, THE Modeling_Engine SHALL produce, within 30 seconds, a Data_Model containing at least one entity, each entity's attributes, and the relationships between entities.
2. WHEN the Modeling_Engine produces a Data_Model, THE Modeling_Engine SHALL assign exactly one primary key to each entity in the Data_Model.
3. WHEN the Modeling_Engine infers a relationship between two entities, THE Modeling_Engine SHALL record the relationship cardinality as exactly one of: one-to-one, one-to-many, or many-to-many.
4. WHEN the Modeling_Engine infers an attribute, THE Modeling_Engine SHALL assign to the attribute exactly one data type from the set of data types supported by the Data_Model.
5. WHEN the Modeling_Engine infers a many-to-many relationship, THE Modeling_Engine SHALL create a join entity that references the primary key of each of the two related entities.
6. IF the submitted domain description is empty or contains only whitespace characters, THEN THE AI_Database_Architect SHALL reject the description and return a validation error identifying that a non-empty input description is required, without producing a Data_Model.
7. IF the submitted domain description exceeds 10,000 characters, THEN THE AI_Database_Architect SHALL reject the description and return a validation error identifying the maximum allowed length of 10,000 characters, without producing a Data_Model.
8. IF the Modeling_Engine cannot infer at least one entity from the submitted domain description, THEN THE AI_Database_Architect SHALL return an error indicating that no Data_Model could be derived from the description, without producing a partial Data_Model.

### Requirement 2: Intelligent Constraint and Validation Inference [MUST]

**User Story:** As a builder, I want the system to infer validation rules and constraints, so that the generated database enforces data integrity.

#### Acceptance Criteria

1. WHEN the Modeling_Engine infers that an attribute uniquely identifies instances of an entity, THE Modeling_Engine SHALL mark the attribute as unique such that no two records of that entity can hold the same non-null value for the attribute.
2. WHEN the Modeling_Engine infers that an attribute is required, THE Modeling_Engine SHALL mark the attribute as not-null such that a record cannot be persisted with a missing or empty value for that attribute.
3. WHEN the Modeling_Engine infers that an attribute represents an email address, THE Modeling_Engine SHALL attach a format constraint that accepts values containing exactly one "@" separating a non-empty local part from a domain part that contains at least one "." and rejects all other values.
4. WHEN the Modeling_Engine infers a numeric attribute with a natural lower bound, THE Modeling_Engine SHALL attach a range constraint that rejects any value below that lower bound, defaulting to a minimum of 0 for count, quantity, age, and price attributes.
5. WHEN the Modeling_Engine creates a relationship between two entities, THE Modeling_Engine SHALL define a foreign-key constraint on the dependent entity that references the related entity's primary-key attribute.
6. IF the Modeling_Engine creates a relationship to an entity that has no primary-key attribute defined, THEN THE Modeling_Engine SHALL designate a primary-key attribute for the related entity before defining the foreign-key constraint.
7. IF the Modeling_Engine cannot determine with confidence whether an attribute is unique, required, or format-constrained, THEN THE Modeling_Engine SHALL leave the attribute without that constraint and flag the attribute as requiring builder review.

### Requirement 3: Aurora PostgreSQL Schema Generation [MUST]

**User Story:** As a builder, I want the inferred model translated into an Aurora PostgreSQL schema, so that I have a real relational database.

#### Acceptance Criteria

1. WHEN a Data_Model is finalized, THE Schema_Generator SHALL produce Aurora PostgreSQL DDL statements that create exactly one table per entity defined in the Data_Model.
2. WHEN the Schema_Generator generates a table, THE Schema_Generator SHALL include every column defined for the corresponding entity in the Data_Model, each column's data type, and the primary key, where a primary key composed of multiple columns is emitted as a single composite primary key constraint.
3. WHEN the Data_Model contains a relationship between two defined entities, THE Schema_Generator SHALL generate the corresponding foreign-key constraint in the DDL.
4. WHEN the Data_Model contains a unique or not-null constraint on a column, THE Schema_Generator SHALL generate the corresponding column constraint in the DDL.
5. WHEN the Schema_Generator generates a foreign-key column, THE Schema_Generator SHALL generate exactly one index on that column.
6. WHEN the Schema_Generator emits the generated DDL, THE Schema_Generator SHALL emit it as a single ordered migration script in which every referenced table is created before any table that references it.
7. IF the Data_Model contains a relationship that references an entity not defined in the Data_Model, THEN THE Schema_Generator SHALL return an error identifying the undefined entity and SHALL NOT emit DDL for that relationship.
8. IF a column's data type in the Data_Model cannot be mapped to an Aurora PostgreSQL data type, THEN THE Schema_Generator SHALL return an error identifying the column and its unmappable data type and SHALL NOT emit DDL for that table.
9. IF the relationships in the Data_Model form a cyclic dependency that prevents an ordering in which every referenced table is created before its referencing table, THEN THE Schema_Generator SHALL return an error identifying the entities involved in the cycle and SHALL NOT emit the migration script.
10. IF any error condition is detected during schema generation, THEN THE Schema_Generator SHALL NOT emit a partial migration script and SHALL leave no generated DDL output.

### Requirement 4: Database Provisioning and Deployment [MUST]

**User Story:** As a builder, I want the generated schema applied to a live AWS database, so that the backend is immediately usable.

#### Acceptance Criteria

1. WHEN the migration script is generated, THE AI_Database_Architect SHALL apply the migration script to the Deployment_Target within 300 seconds.
2. WHEN the migration script is applied successfully, where success means every statement in the migration script is committed to the Deployment_Target with zero failed statements, THE AI_Database_Architect SHALL record the Generation_Job status as deployed.
3. IF applying the migration script fails, THEN THE AI_Database_Architect SHALL record the Generation_Job status as failed and SHALL return an error response indicating the failure reason.
4. IF applying the migration script fails, THEN THE AI_Database_Architect SHALL roll back all partially applied schema changes on the Deployment_Target so that the Deployment_Target is restored to its state prior to the migration attempt.
5. IF the AI_Database_Architect cannot establish a connection to the Deployment_Target within 30 seconds, THEN THE AI_Database_Architect SHALL record the Generation_Job status as failed and SHALL return an error response indicating a connectivity failure.
6. WHERE the configured target is Amazon Aurora PostgreSQL, THE AI_Database_Architect SHALL apply the schema to an Amazon Aurora PostgreSQL Deployment_Target.

### Requirement 5: CRUD API Generation [MUST]

**User Story:** As a builder, I want CRUD APIs generated for each entity, so that I can read and write data without writing code.

#### Acceptance Criteria

1. WHEN a Data_Model is deployed to the Deployment_Target, THE API_Generator SHALL generate create, read, update, delete, and list REST endpoints for each entity defined in the Data_Model.
2. WHEN a client sends a create request with an entity record that satisfies all constraints defined in the Data_Model, THE generated API SHALL persist the record to the Deployment_Target and return the created record including its assigned primary key.
3. WHEN a client sends a read request for an existing record by primary key, THE generated API SHALL return that record.
4. WHEN a client sends an update request with an entity record that satisfies all constraints defined in the Data_Model for an existing primary key, THE generated API SHALL persist the updated record to the Deployment_Target and return the updated record.
5. WHEN a client sends a delete request for an existing record by primary key, THE generated API SHALL remove the record from the Deployment_Target and return a confirmation that the record was deleted.
6. IF a client sends a request whose payload violates a constraint defined in the Data_Model, THEN THE generated API SHALL reject the request without persisting any change to the Deployment_Target and return a validation error identifying each violated constraint.
7. IF a client sends a read, update, or delete request for a primary key that does not exist in the Deployment_Target, THEN THE generated API SHALL make no change to stored data and return a not-found error indicating the primary key was not found.
8. WHEN a client sends a list request for an entity without specifying a page size, THE generated API SHALL return records in pages of 25 records ordered by primary key in ascending order.
9. IF a client sends a list request specifying a page size greater than 100 or less than 1, THEN THE generated API SHALL reject the request and return a validation error indicating that page size must be between 1 and 100 inclusive.

### Requirement 6: Authentication and Role-Based Authorization [MUST]

**User Story:** As a builder, I want authentication and role-based access generated, so that the backend is secure by default.

#### Acceptance Criteria

1. WHEN a user submits a signup request containing a unique account identifier and a password, THE Auth_Service SHALL create a user account and store the password using a one-way hash and SHALL NOT store the password in plaintext.
2. WHEN a user submits a login request with credentials that match a stored account, THE Auth_Service SHALL issue a JWT that expires no later than 24 hours after issuance.
3. IF a user submits a login request with credentials that do not match a stored account, THEN THE Auth_Service SHALL reject the request, return an authentication error indicating the credentials are invalid, and SHALL NOT issue a JWT.
4. WHEN a client sends a request to a protected endpoint with a JWT that is missing, malformed, or expired, THE Auth_Service SHALL reject the request, return an authorization error indicating a valid token is required, and SHALL NOT execute the requested operation.
5. WHEN a client sends a request to an endpoint that requires a role the authenticated user does not hold, THE Auth_Service SHALL reject the request, return an authorization error indicating insufficient permissions, and SHALL NOT execute the requested operation.
6. THE Auth_Service SHALL support at least two distinct roles, where each role is associated with a permission set and at least one permission differs between the two roles.
7. IF a signup request omits the account identifier or the password, THEN THE Auth_Service SHALL reject the request, return a validation error identifying the missing required credential, and SHALL NOT create a user account.
8. IF a signup request supplies an account identifier that already belongs to an existing account, THEN THE Auth_Service SHALL reject the request, return an error indicating the identifier is already in use, and SHALL NOT create a duplicate account.

### Requirement 7: Admin Dashboard [MUST]

**User Story:** As a builder, I want a generated admin dashboard, so that I can manage data visually after deployment.

#### Acceptance Criteria

1. WHEN an authenticated administrator opens the Admin_Dashboard for a deployed backend, THE Admin_Dashboard SHALL display a navigable list of the generated entities.
2. WHEN an authenticated administrator selects an entity, THE Admin_Dashboard SHALL display that entity's records using a bounded page size not exceeding 100 records per page.
3. WHEN an authenticated administrator submits a create, edit, or delete action through the Admin_Dashboard, THE Admin_Dashboard SHALL invoke the corresponding generated API for that action.
4. WHEN a create, edit, or delete action invoked through the Admin_Dashboard succeeds, THE Admin_Dashboard SHALL display the updated record state reflecting the action.
5. IF a create, edit, or delete action invoked through the Admin_Dashboard fails, THEN THE Admin_Dashboard SHALL leave the displayed records unchanged and display an error indication identifying the failure.
6. WHEN an authenticated administrator enters a search term for an entity, THE Admin_Dashboard SHALL display only records whose attribute values contain the search term, using a bounded page size not exceeding 100 records per page.
7. WHEN an authenticated administrator applies a filter on an entity attribute, THE Admin_Dashboard SHALL display only records satisfying the filter condition.
8. IF a search term or filter matches no records, THEN THE Admin_Dashboard SHALL display an empty result indication and SHALL NOT display any records.

### Requirement 8: Interactive Refinement [MUST]

**User Story:** As a builder, I want the system to ask clarifying questions, so that the generated backend matches my intent more completely.

#### Acceptance Criteria

1. WHEN the Modeling_Engine produces an initial Data_Model, THE Refinement_Engine SHALL present between 1 and 10 clarifying questions, where each presented question maps to at least one entity, attribute, or relationship in the initial Data_Model.
2. IF the initial Data_Model contains no entities, attributes, or relationships from which a clarifying question can be derived, THEN THE Refinement_Engine SHALL present zero clarifying questions and proceed using the initial Data_Model.
3. WHEN a user selects one or more valid answers to clarifying questions, THE Refinement_Engine SHALL update the Data_Model to reflect each selected answer and retain all prior Data_Model elements not contradicted by the selected answers.
4. WHEN a user adds an optional feature through a clarifying question, THE Refinement_Engine SHALL add the corresponding entities, attributes, or relationships to the Data_Model.
5. IF a selected answer conflicts with an existing entity, attribute, or relationship in the Data_Model, THEN THE Refinement_Engine SHALL reject the selected answer, leave the Data_Model unchanged, and present an indication identifying the conflicting element.
6. WHERE a user skips the clarifying questions, THE AI_Database_Architect SHALL proceed using the initial Data_Model without modification.

### Requirement 9: End-to-End Generation Performance [MUST]

**User Story:** As a demo presenter, I want generation to complete quickly, so that the live demo delivers an immediate result.

#### Acceptance Criteria

1. WHEN a user submits a domain description and accepts the initial Data_Model containing 10 or fewer entities, THE AI_Database_Architect SHALL advance the Generation_Job from submitted status to deployed status within 30 seconds.
2. WHILE a Generation_Job is running, THE AI_Database_Architect SHALL display the name of the Generation_Job's current generation stage and SHALL update the displayed stage within 2 seconds of each stage transition.
3. IF a Generation_Job's elapsed run time exceeds 60 seconds before reaching deployed status, THEN THE AI_Database_Architect SHALL halt the Generation_Job, set the Generation_Job to a failed status, and report to the user a timeout indication that identifies the generation stage active when the 60-second limit was reached.
4. IF a Generation_Job is halted due to a timeout, THEN THE AI_Database_Architect SHALL discard any partially deployed artifacts so that no Data_Model is left in deployed status.
5. WHERE the accepted Data_Model contains more than 10 entities, THE AI_Database_Architect SHALL notify the user before starting the Generation_Job that completion within the 30-second target is not guaranteed.

### Requirement 10: Document to Backend [SECONDARY]

**User Story:** As a builder, I want to upload a document, so that the system models a relational backend from the document's data.

#### Acceptance Criteria

1. WHEN a user uploads a file of up to 50 MB in CSV, Excel, or PDF format, THE Document_Parser SHALL extract structured records, each consisting of named fields with their values, from the file within 30 seconds.
2. WHEN the Document_Parser extracts records from a flat tabular source, THE Modeling_Engine SHALL create a separate entity for each group of two or more fields whose values repeat across two or more records, rather than modeling the source as a single table.
3. WHEN the Modeling_Engine derives entities from a document, THE Modeling_Engine SHALL produce a Data_Model that follows the same structure defined in Requirement 1.
4. IF an uploaded file is in a format other than CSV, Excel, or PDF, THEN THE Document_Parser SHALL reject the file, retain no extracted records, and return an error identifying that the supported formats are CSV, Excel, and PDF.
5. IF an uploaded file in a supported format cannot be parsed, THEN THE Document_Parser SHALL retain no extracted records and return an error identifying the parsing failure.
6. IF an uploaded file contains no extractable records, THEN THE Document_Parser SHALL return an error indicating that no records were found and SHALL NOT produce a Data_Model.
7. IF an uploaded file exceeds 50 MB, THEN THE Document_Parser SHALL reject the file and return an error identifying the maximum allowed file size of 50 MB.

### Requirement 11: Existing Database Import [STRETCH]

**User Story:** As a builder, I want to import an existing database, so that the system can analyze and improve it on Aurora PostgreSQL.

#### Acceptance Criteria

1. WHEN a user provides connection credentials and a host endpoint for an existing MySQL or PostgreSQL database, THE Import_Analyzer SHALL establish a connection within 30 seconds and extract the existing schema, including tables, columns, data types, primary keys, foreign keys, and indexes, into a Data_Model.
2. IF the Import_Analyzer encounters a schema element it does not support during extraction, THEN THE Import_Analyzer SHALL record the unsupported element in the Data_Model with an indicator that it was not extracted and SHALL continue extracting the remaining elements.
3. WHEN the Import_Analyzer completes extraction of an imported schema, THE Import_Analyzer SHALL produce a set of suggestions for the Data_Model, where each suggestion identifies the affected schema element, the detected issue (including unnormalized structures up to third normal form, missing primary keys, and missing foreign key relationships), and the proposed change.
4. WHEN a user accepts one or more suggestions, THE Schema_Generator SHALL generate an Aurora PostgreSQL schema that reflects every accepted suggestion and excludes every rejected suggestion.
5. IF the existing database cannot be reached within the 30-second connection window, or if the provided credentials are rejected, THEN THE Import_Analyzer SHALL halt the import, leave any existing Data_Model unchanged, and return an error indicating whether the failure was a connection timeout or an authentication failure.

### Requirement 12: DDL Round-Trip Integrity [MUST]

**User Story:** As a builder, I want confidence that the generated schema faithfully represents the inferred model, so that no entities or constraints are silently lost.

#### Acceptance Criteria

1. THE Schema_Generator SHALL generate exactly one table in the DDL for each entity present in the Data_Model, such that the count of generated tables equals the count of source entities.
2. WHEN the generated DDL is parsed back into entities, THE resulting set of entities SHALL equal the set of entities in the source Data_Model, where equality requires matching entity name, identical attribute names, and identical attribute data types for every entity.
3. WHEN the generated DDL is parsed back into relationships, THE resulting set of relationships SHALL equal the set of relationships in the source Data_Model, where equality requires matching source entity, target entity, and cardinality for every relationship.
4. WHEN the generated DDL is parsed back into constraints, THE resulting set of constraints SHALL equal the set of constraints in the source Data_Model, where equality requires matching primary key, foreign key, unique, and nullability constraints for every entity and attribute.
5. IF the set of entities, relationships, or constraints parsed back from the generated DDL differs from the corresponding set in the source Data_Model, THEN THE Schema_Generator SHALL reject the DDL and produce an error indicating the specific entities, relationships, or constraints that were added, lost, or altered, while leaving the source Data_Model unchanged.

### Requirement 13: Alternative Database Targets [STRETCH]

**User Story:** As a builder, I want to optionally target other AWS databases, so that the system fits more deployment scenarios.

#### Acceptance Criteria

1. WHERE the configured target is Aurora DSQL, WHEN a Data_Model is finalized, THE Schema_Generator SHALL generate DDL that creates one table per entity defined in the Data_Model, including each entity's primary key, columns, and column data types.
2. WHERE the configured target is DynamoDB, WHEN a Data_Model is finalized, THE Schema_Generator SHALL generate a table design that includes one table definition per entity defined in the Data_Model, with a primary key designated for each table.
3. WHERE the configured target is DynamoDB, IF the Data_Model contains a constraint or relationship that the generated DynamoDB table design does not represent, THEN THE Schema_Generator SHALL return a report identifying each constraint or relationship that was not represented.
4. IF the configured target is not one of the supported targets, THEN THE AI_Database_Architect SHALL return a validation error identifying the set of supported targets and SHALL NOT generate output.
