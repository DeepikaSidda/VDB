import { describe, it, expect } from 'vitest';
import { generate } from './schemaGenerator.js';
import { parseDDL, relationshipEdges, constraintProjection, } from './roundTripVerifier.js';
import { unwrap } from '../model/result.js';
const model = {
    entities: [
        {
            name: 'User',
            isJoinEntity: false,
            primaryKey: ['id'],
            attributes: [
                { name: 'id', dataType: 'UUID', constraints: [{ kind: 'NOT_NULL' }] },
                {
                    name: 'email',
                    dataType: 'VARCHAR',
                    constraints: [{ kind: 'NOT_NULL' }, { kind: 'UNIQUE' }, { kind: 'FORMAT', format: 'EMAIL' }],
                },
                { name: 'age', dataType: 'INTEGER', constraints: [] },
            ],
        },
        {
            name: 'Post',
            isJoinEntity: false,
            primaryKey: ['id'],
            attributes: [
                { name: 'id', dataType: 'UUID', constraints: [{ kind: 'NOT_NULL' }] },
                { name: 'title', dataType: 'TEXT', constraints: [{ kind: 'NOT_NULL' }] },
                {
                    name: 'User_id',
                    dataType: 'UUID',
                    constraints: [{ kind: 'FOREIGN_KEY', references: { entity: 'User', attribute: 'id' } }],
                },
            ],
        },
    ],
    relationships: [{ source: 'Post', target: 'User', cardinality: 'ONE_TO_MANY' }],
};
describe('parseDDL round-trip sanity', () => {
    const ddl = unwrap(generate(model, 'POSTGRES'));
    const parsed = parseDDL(ddl);
    it('reconstructs entities with attribute names and types', () => {
        expect(parsed.entities.map((e) => e.name).sort()).toEqual(['Post', 'User']);
        const user = parsed.entities.find((e) => e.name === 'User');
        expect(user.attributes.map((a) => `${a.name}:${a.dataType}`).sort()).toEqual(['age:INTEGER', 'email:VARCHAR', 'id:UUID']);
        expect(user.primaryKey).toEqual(['id']);
    });
    it('reconstructs NOT_NULL / UNIQUE / FK / PK constraints (projection matches source)', () => {
        const src = constraintProjection(model);
        const got = constraintProjection(parsed);
        expect([...got.notNull].sort()).toEqual([...src.notNull].sort());
        expect([...got.unique].sort()).toEqual([...src.unique].sort());
        expect([...got.foreignKeys].sort()).toEqual([...src.foreignKeys].sort());
        expect([...got.primaryKeys.entries()].sort()).toEqual([...src.primaryKeys.entries()].sort());
    });
    it('FK-derived relationship edges match between source and parsed', () => {
        expect(relationshipEdges(parsed)).toEqual(relationshipEdges(model));
    });
});
//# sourceMappingURL=roundTripVerifier.sanity.test.js.map