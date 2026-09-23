/** Only allowlisted messages/codes reach logs; SDK errors can contain credentials or request data. */
const internalMessages = new Set([
    'Face profiles require SUPABASE_SERVICE_ROLE_KEY.',
    'AWS_REGION is missing.',
    'AWS_ACCESS_KEY_ID is missing.',
    'AWS_SECRET_ACCESS_KEY is missing.',
    'Invalid face image size.',
    'Face profile lookup failed.',
    'Face profile storage unavailable.',
    'Profile could not be saved. Please try recognition again.',
    'Known people could not be loaded.',
    'Face removed, but profile deletion failed. Please retry.',
    'AWS could not delete the face.',
    'Face is not clear and unambiguous. Please recognize again.',
    'Face quality is insufficient to save. Please try a clearer photo.',
    'Account mismatch',
    'timed out waiting for the camera photo',
]);

const awsErrorNames = new Set([
    'AccessDeniedException',
    'UnrecognizedClientException',
    'InvalidSignatureException',
    'SignatureDoesNotMatch',
    'InvalidClientTokenId',
    'ExpiredTokenException',
    'InvalidParameterException',
    'InvalidImageFormatException',
    'ImageTooLargeException',
    'ResourceNotFoundException',
    'ResourceAlreadyExistsException',
    'ThrottlingException',
    'ProvisionedThroughputExceededException',
    'LimitExceededException',
    'InternalServerError',
    'CredentialsProviderError',
]);

export type FaceErrorStage =
    | 'validation'
    | 'camera'
    | 'recognition'
    | 'enrollment'
    | 'deletion'
    | 'memory';

export function faceErrorSummary(error: unknown, stage: FaceErrorStage) {
    const detail = error && typeof error === 'object'
        ? error as { name?: unknown; message?: unknown; cause?: unknown }
        : {};
    const message = typeof detail.message === 'string' && internalMessages.has(detail.message)
        ? detail.message
        : 'Operation failed; upstream message omitted.';
    const cause = detail.cause && typeof detail.cause === 'object'
        ? detail.cause as { code?: unknown }
        : {};
    // SQLSTATE/PostgREST codes only, never DB messages, details, rows or hints.
    const dbCode = typeof cause.code === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(cause.code)
        ? cause.code
        : undefined;
    const awsCode = typeof detail.name === 'string' && awsErrorNames.has(detail.name)
        ? detail.name
        : undefined;
    const code = dbCode ?? awsCode ??
        (message.includes('SUPABASE_SERVICE_ROLE_KEY')
            ? 'MISSING_SERVICE_ROLE_KEY'
            : message.endsWith(' is missing.')
            ? 'MISSING_AWS_CONFIGURATION'
            : message === 'timed out waiting for the camera photo'
            ? 'CAMERA_TIMEOUT'
            : detail.name === 'AbortError' || detail.name === 'TimeoutError'
            ? 'TIMEOUT'
            : 'OPERATION_FAILED');
    const source = dbCode ? 'supabase' : awsCode ? 'aws' : stage;
    const hint = code === '42501'
        ? 'Use a Supabase service-role/secret key for SUPABASE_SERVICE_ROLE_KEY; check known_people grants.'
        : code === '42P01' || code === 'PGRST205'
        ? 'Apply 20260920120000_add_known_people.sql to the configured Supabase project.'
        : code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303'
        ? 'Check that SUPABASE_SERVICE_ROLE_KEY belongs to SUPABASE_URL and is valid.'
        : code === 'AccessDeniedException'
        ? 'Check Rekognition IAM actions and the collection ARN region against AWS_REGION.'
        : [
                'UnrecognizedClientException',
                'InvalidSignatureException',
                'SignatureDoesNotMatch',
                'InvalidClientTokenId',
                'ExpiredTokenException',
                'CredentialsProviderError',
            ].includes(code)
        ? 'Check AWS credentials and AWS_SESSION_TOKEN when using temporary credentials.'
        : undefined;
    return { stage, source, code, message, ...(hint ? { hint } : {}) };
}
