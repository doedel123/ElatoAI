import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';
import type { RekognitionClient } from 'npm:@aws-sdk/client-rekognition@3.1136.0';
import type { SupabaseClient } from '@supabase/supabase-js';
import { faceCollectionId, RekognitionFaceBackend } from './face_backend.ts';
import type { KnownPerson } from './faces.ts';
import { faceErrorSummary } from './face_errors.ts';

const account = '00000000-0000-0000-0000-000000000001';
const person: KnownPerson = {
    person_id: '00000000-0000-0000-0000-000000000002',
    account_id: account,
    display_name: 'Leo',
    relationship: 'Bruder von Amelie',
    face_id: 'face-1',
};
const image = new Uint8Array([1, 2, 3]);
const oneFace = { FaceDetails: [{ Confidence: 99.9, Quality: { Brightness: 80, Sharpness: 80 } }] };
const notFound = () =>
    Object.assign(new Error('missing collection'), { name: 'ResourceNotFoundException' });

function fixture(
    responses: unknown[],
    options: { insertError?: unknown; lookupError?: unknown; person?: KnownPerson | null } = {},
) {
    const awsCalls: { name: string; input: Record<string, unknown> }[] = [];
    const dbCalls: { name: string; args: unknown[] }[] = [];
    const client = {
        send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
            awsCalls.push({ name: command.constructor.name, input: command.input });
            if (!responses.length) throw new Error('Unexpected AWS call');
            const response = responses.shift();
            return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
        },
    } as unknown as RekognitionClient;
    const query = {
        select: (...args: unknown[]) => {
            dbCalls.push({ name: 'select', args });
            return query;
        },
        eq: (...args: unknown[]) => {
            dbCalls.push({ name: 'eq', args });
            return query;
        },
        maybeSingle: () =>
            Promise.resolve({
                data: options.person === undefined ? person : options.person,
                error: options.lookupError,
            }),
        limit: () => Promise.resolve({ data: [], error: options.lookupError }),
        insert: (...args: unknown[]) => {
            dbCalls.push({ name: 'insert', args });
            return Promise.resolve({ error: options.insertError });
        },
    };
    const db = {
        from: (table: string) => {
            strictEqual(table, 'known_people');
            return query;
        },
    } as unknown as SupabaseClient;
    return { backend: new RekognitionFaceBackend(account, db, client), awsCalls, dbCalls };
}

Deno.test('collection ID is derived from a validated account ID', () => {
    strictEqual(faceCollectionId(account), `elato_${account}`);
    throws(() => faceCollectionId('../other-account'));
});

Deno.test('missing AWS_REGION is diagnosed before any AWS request', async () => {
    const originalRegion = Deno.env.get('AWS_REGION');
    Deno.env.delete('AWS_REGION');
    try {
        const backend = new RekognitionFaceBackend(account, {} as SupabaseClient);
        await rejects(() => backend.search(image), (error: unknown) => {
            const summary = faceErrorSummary(error, 'recognition');
            strictEqual(summary.code, 'MISSING_AWS_CONFIGURATION');
            strictEqual(summary.message, 'AWS_REGION is missing.');
            return true;
        });
    } finally {
        if (originalRegion === undefined) Deno.env.delete('AWS_REGION');
        else Deno.env.set('AWS_REGION', originalRegion);
    }
});

Deno.test('no face, multiple faces and poor quality never search a collection', async () => {
    for (
        const [detected, status] of [
            [{ FaceDetails: [] }, 'no_face'],
            [{ FaceDetails: [...oneFace.FaceDetails, ...oneFace.FaceDetails] }, 'multiple_faces'],
            [
                { FaceDetails: [{ Confidence: 99.9, Quality: { Brightness: 5, Sharpness: 80 } }] },
                'uncertain',
            ],
        ] as const
    ) {
        const f = fixture([detected]);
        strictEqual((await f.backend.search(image)).status, status);
        strictEqual(f.awsCalls.length, 1);
    }
});

Deno.test('known match uses account-scoped AWS collection and DB lookup', async () => {
    const f = fixture([oneFace, {
        FaceMatches: [{ Similarity: 99.8, Face: { FaceId: 'face-1' } }],
    }]);
    deepStrictEqual(await f.backend.search(image), { status: 'known', person });
    strictEqual(f.awsCalls[1].input.CollectionId, `elato_${account}`);
    deepStrictEqual(f.dbCalls.filter((c) => c.name === 'eq'), [
        { name: 'eq', args: ['account_id', account] },
        { name: 'eq', args: ['face_id', 'face-1'] },
    ]);
});

Deno.test('weak or ambiguous matches are uncertain, never new faces', async () => {
    for (const scores of [[98.9], [99.9, 98]]) {
        const f = fixture([oneFace, {
            FaceMatches: scores.map((Similarity, i) => ({
                Similarity,
                Face: { FaceId: `face-${i}` },
            })),
        }]);
        strictEqual((await f.backend.search(image)).status, 'uncertain');
        strictEqual(f.dbCalls.length, 0);
    }
});

Deno.test('new collection is unknown only if profile storage is available', async () => {
    const f = fixture([oneFace, notFound()]);
    strictEqual((await f.backend.search(image)).status, 'unknown');
    const broken = fixture([oneFace, notFound()], { lookupError: true });
    await rejects(() => broken.backend.search(image), /storage unavailable/);
});

Deno.test('AWS errors and DB errors are not unknown faces', async () => {
    const denied = fixture([oneFace, new Error('Access denied')]);
    await rejects(() => denied.backend.search(image), /Access denied/);
    const broken = fixture([oneFace, {
        FaceMatches: [{ Similarity: 99.8, Face: { FaceId: 'face-1' } }],
    }], { lookupError: true });
    await rejects(() => broken.backend.search(image), /lookup failed/);
});

Deno.test('orphan AWS face cannot be assigned to a new profile', async () => {
    const f = fixture([oneFace, {
        FaceMatches: [{ Similarity: 99.8, Face: { FaceId: 'face-1' } }],
    }], { person: null });
    strictEqual((await f.backend.search(image)).status, 'uncertain');
});

Deno.test('enrollment stores relationship and opaque external ID in the same account', async () => {
    const f = fixture([oneFace, notFound(), {}, {
        FaceRecords: [{ Face: { FaceId: 'new-face' } }],
    }]);
    const saved = await f.backend.enroll(image, 'Leo', 'Bruder von Amelie');
    strictEqual(saved.account_id, account);
    strictEqual(saved.relationship, 'Bruder von Amelie');
    strictEqual(saved.face_id, 'new-face');
    strictEqual(f.awsCalls.at(-1)?.input.ExternalImageId, saved.person_id);
    strictEqual(f.awsCalls.at(-1)?.input.MaxFaces, 1);
    deepStrictEqual(f.dbCalls.at(-1), { name: 'insert', args: [saved] });
});

Deno.test('existing face enrollment is idempotent and does not overwrite its name', async () => {
    const f = fixture([oneFace, {
        FaceMatches: [{ Similarity: 99.8, Face: { FaceId: 'face-1' } }],
    }]);
    deepStrictEqual(await f.backend.enroll(image, 'Wrong name', ''), person);
    strictEqual(f.awsCalls.length, 2);
    strictEqual(f.dbCalls.some((c) => c.name === 'insert'), false);
});

Deno.test('DB insertion failure deletes the just-indexed face', async () => {
    const f = fixture([
        oneFace,
        notFound(),
        {},
        { FaceRecords: [{ Face: { FaceId: 'new-face' } }] },
        {},
    ], { insertError: true });
    await rejects(() => f.backend.enroll(image, 'Leo', ''), /could not be saved/);
    strictEqual(f.awsCalls.at(-1)?.name, 'DeleteFacesCommand');
    deepStrictEqual(f.awsCalls.at(-1)?.input.FaceIds, ['new-face']);
});

Deno.test('IndexFaces quality rejection does not insert a profile', async () => {
    const f = fixture([oneFace, notFound(), {}, { FaceRecords: [] }]);
    await rejects(() => f.backend.enroll(image, 'Leo', ''), /quality/);
    strictEqual(f.dbCalls.some((c) => c.name === 'insert'), false);
});

for (const code of ['42501', 'PGRST205']) {
    Deno.test(`new account preserves Supabase ${code} instead of offering enrollment`, async () => {
        const f = fixture([oneFace, notFound()], {
            lookupError: { code, message: 'PRIVATE_DB_DETAIL' },
        });
        await rejects(() => f.backend.search(image), (error: unknown) => {
            const summary = faceErrorSummary(error, 'recognition');
            strictEqual(summary.source, 'supabase');
            strictEqual(summary.code, code);
            strictEqual(JSON.stringify(summary).includes('PRIVATE_DB_DETAIL'), false);
            return true;
        });
        strictEqual(f.awsCalls.some((c) => c.name === 'IndexFacesCommand'), false);
    });
}

Deno.test('enrollment rollback retains the original database failure code', async () => {
    const f = fixture([
        oneFace,
        notFound(),
        {},
        { FaceRecords: [{ Face: { FaceId: 'new-face' } }] },
        {},
    ], { insertError: { code: '42501', message: 'PRIVATE_DB_DETAIL' } });
    await rejects(() => f.backend.enroll(image, 'Leo', ''), (error: unknown) => {
        strictEqual(faceErrorSummary(error, 'enrollment').code, '42501');
        return true;
    });
    strictEqual(f.awsCalls.at(-1)?.name, 'DeleteFacesCommand');
});
