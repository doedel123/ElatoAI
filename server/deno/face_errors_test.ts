import { strictEqual } from 'node:assert';
import { faceErrorSummary } from './face_errors.ts';

Deno.test('AWS diagnostics retain error codes but never raw messages or request data', () => {
    const error = Object.assign(new Error('credential=PRIVATE_KEY image=PRIVATE_JPEG'), {
        name: 'AccessDeniedException',
        request: { key: 'PRIVATE_KEY', photo: 'PRIVATE_JPEG' },
    });
    const summary = faceErrorSummary(error, 'recognition');
    strictEqual(summary.source, 'aws');
    strictEqual(summary.code, 'AccessDeniedException');
    strictEqual(summary.hint?.includes('AWS_REGION'), true);
    strictEqual(JSON.stringify(summary).includes('PRIVATE_'), false);
});

Deno.test('DB diagnostics preserve only SQLSTATE/PostgREST codes and static context', () => {
    const summary = faceErrorSummary(
        new Error('Face profile storage unavailable.', {
            cause: { code: '42501', message: 'PRIVATE_NAME', details: 'PRIVATE_PHOTO' },
        }),
        'recognition',
    );
    strictEqual(summary.source, 'supabase');
    strictEqual(summary.code, '42501');
    strictEqual(summary.message, 'Face profile storage unavailable.');
    strictEqual(summary.hint?.includes('SUPABASE_SERVICE_ROLE_KEY'), true);
    strictEqual(JSON.stringify(summary).includes('PRIVATE_'), false);
});

Deno.test('configuration errors identify missing variables without their values', () => {
    for (const name of ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
        const summary = faceErrorSummary(new Error(`${name} is missing.`), 'recognition');
        strictEqual(summary.code, 'MISSING_AWS_CONFIGURATION');
        strictEqual(summary.message, `${name} is missing.`);
    }
    const summary = faceErrorSummary(
        new Error('Face profiles require SUPABASE_SERVICE_ROLE_KEY.'),
        'recognition',
    );
    strictEqual(summary.code, 'MISSING_SERVICE_ROLE_KEY');
});

Deno.test('unrecognized errors and malformed codes cannot leak upstream details', () => {
    for (
        const error of [
            'PRIVATE_DATA',
            null,
            { name: 'PRIVATE_KEY', message: 'PRIVATE_DATA', cause: { code: 'PRIVATE_KEY' } },
            new Error('PRIVATE_DATA'),
        ]
    ) {
        const summary = faceErrorSummary(error, 'camera');
        strictEqual(summary.stage, 'camera');
        strictEqual(summary.code, 'OPERATION_FAILED');
        strictEqual(JSON.stringify(summary).includes('PRIVATE_'), false);
    }
});
