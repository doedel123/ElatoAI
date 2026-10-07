import {
    CreateCollectionCommand,
    DeleteFacesCommand,
    DetectFacesCommand,
    type FaceDetail,
    IndexFacesCommand,
    RekognitionClient,
    SearchFacesByImageCommand,
} from 'npm:@aws-sdk/client-rekognition@3.1136.0';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type FaceBackend, type FaceSearch, FaceSession, type KnownPerson } from './faces.ts';
import { loadMemoryContext, rememberFact, searchMemories } from './memory.ts';

const MATCH_THRESHOLD = 99;
const MATCH_MARGIN = 3;
const EXPRESSION_MIN_CONFIDENCE = 80;
// CALM is the resting face and UNKNOWN carries no signal; neither is worth a reaction.
const EXPRESSIONS: Record<string, string> = {
    HAPPY: 'happy',
    SAD: 'sad',
    ANGRY: 'angry',
    CONFUSED: 'confused',
    DISGUSTED: 'disgusted',
    SURPRISED: 'surprised',
    FEAR: 'fearful',
};

/** Clearly visible facial expression of a detected face, if any. Not an inner feeling. */
export function visibleExpression(face: FaceDetail): string | undefined {
    let top: { type?: string; confidence: number } = { confidence: 0 };
    for (const emotion of face.Emotions ?? []) {
        const confidence = emotion.Confidence ?? 0;
        if (confidence > top.confidence) top = { type: emotion.Type, confidence };
    }
    if (!top.type || top.confidence < EXPRESSION_MIN_CONFIDENCE) return undefined;
    return EXPRESSIONS[top.type];
}

/** A collection is derived exclusively from the authenticated account, never model arguments. */
export function faceCollectionId(accountId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
        throw new Error('Invalid account ID');
    }
    return `elato_${accountId.toLowerCase()}`;
}

export class RekognitionFaceBackend implements FaceBackend {
    private client?: RekognitionClient;
    private collectionId: string;

    constructor(
        private accountId: string,
        private supabase: SupabaseClient | null,
        client?: RekognitionClient,
    ) {
        this.collectionId = faceCollectionId(accountId);
        this.client = client;
    }

    private db(): SupabaseClient {
        if (!this.supabase) throw new Error('Face profiles require SUPABASE_SERVICE_ROLE_KEY.');
        return this.supabase;
    }

    private aws(): RekognitionClient {
        this.db();
        if (!this.client) {
            const region = Deno.env.get('AWS_REGION')?.trim();
            const accessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')?.trim();
            const secretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')?.trim();
            if (!region) throw new Error('AWS_REGION is missing.');
            if (!accessKeyId) throw new Error('AWS_ACCESS_KEY_ID is missing.');
            if (!secretAccessKey) throw new Error('AWS_SECRET_ACCESS_KEY is missing.');
            this.client = new RekognitionClient({
                region,
                credentials: {
                    accessKeyId,
                    secretAccessKey,
                    sessionToken: Deno.env.get('AWS_SESSION_TOKEN'),
                },
                maxAttempts: 2,
            });
        }
        return this.client;
    }

    async search(image: Uint8Array): Promise<FaceSearch> {
        if (!image.length || image.length > 5 * 1024 * 1024) {
            throw new Error('Invalid face image size.');
        }
        const aws = this.aws();
        const detected = await aws.send(
            new DetectFacesCommand({
                Image: { Bytes: image },
                // Emotions only; no age or gender estimation.
                Attributes: ['DEFAULT', 'EMOTIONS'],
            }),
            { abortSignal: AbortSignal.timeout(10_000) },
        );
        const faces = detected.FaceDetails ?? [];
        if (!faces.length) return { status: 'no_face' };
        if (faces.length !== 1) return { status: 'multiple_faces' };
        const face = faces[0];
        if (
            (face.Confidence ?? 0) < 99 || (face.Quality?.Brightness ?? 0) < 20 ||
            (face.Quality?.Sharpness ?? 0) < 20
        ) return { status: 'uncertain' };

        const result = await this.match(aws, image);
        const expression = visibleExpression(face);
        return expression ? { ...result, expression } : result;
    }

    /** Identity lookup for a single, clearly detected face. */
    private async match(aws: RekognitionClient, image: Uint8Array): Promise<FaceSearch> {
        try {
            // Request weaker matches too: a near match is uncertain, not a new person.
            const result = await aws.send(
                new SearchFacesByImageCommand({
                    CollectionId: this.collectionId,
                    Image: { Bytes: image },
                    FaceMatchThreshold: 90,
                    MaxFaces: 2,
                    QualityFilter: 'AUTO',
                }),
                { abortSignal: AbortSignal.timeout(10_000) },
            );
            const matches = result.FaceMatches ?? [];
            if (!matches.length) return { status: 'unknown' };
            const best = matches[0];
            if (
                (best.Similarity ?? 0) < MATCH_THRESHOLD ||
                (matches[1] && (best.Similarity ?? 0) - (matches[1].Similarity ?? 0) < MATCH_MARGIN)
            ) {
                return { status: 'uncertain' };
            }
            if (!best.Face?.FaceId) return { status: 'uncertain' };
            const { data, error } = await this.db().from('known_people').select('*')
                .eq('account_id', this.accountId).eq('face_id', best.Face.FaceId).maybeSingle();
            if (error) throw new Error('Face profile lookup failed.', { cause: error });
            // An orphan AWS template must never be guessed or reassigned.
            if (!data) return { status: 'uncertain' };
            return { status: 'known', person: data as KnownPerson };
        } catch (error) {
            if ((error as Error).name === 'ResourceNotFoundException') {
                // Verify the migration exists before offering enrollment.
                const { error: dbError } = await this.db().from('known_people').select('person_id')
                    .eq('account_id', this.accountId).limit(1);
                if (dbError) {
                    throw new Error('Face profile storage unavailable.', { cause: dbError });
                }
                return { status: 'unknown' };
            }
            throw error;
        }
    }

    async enroll(image: Uint8Array, name: string, relationship: string): Promise<KnownPerson> {
        // Another session may have enrolled this person while the user answered.
        const existing = await this.search(image);
        if (existing.status === 'known') return existing.person;
        if (existing.status !== 'unknown') {
            throw new Error('Face is not clear and unambiguous. Please recognize again.');
        }
        const aws = this.aws();
        try {
            await aws.send(new CreateCollectionCommand({ CollectionId: this.collectionId }), {
                abortSignal: AbortSignal.timeout(10_000),
            });
        } catch (error) {
            if ((error as Error).name !== 'ResourceAlreadyExistsException') throw error;
        }
        const personId = crypto.randomUUID();
        const indexed = await aws.send(
            new IndexFacesCommand({
                CollectionId: this.collectionId,
                Image: { Bytes: image },
                ExternalImageId: personId,
                MaxFaces: 1,
                QualityFilter: 'AUTO',
                DetectionAttributes: ['DEFAULT'],
            }),
            { abortSignal: AbortSignal.timeout(10_000) },
        );
        const faceIds = (indexed.FaceRecords ?? []).flatMap((r) =>
            r.Face?.FaceId ? [r.Face.FaceId] : []
        );
        if (faceIds.length !== 1) {
            if (faceIds.length) await this.deleteFaces(faceIds);
            throw new Error('Face quality is insufficient to save. Please try a clearer photo.');
        }
        const person: KnownPerson = {
            person_id: personId,
            account_id: this.accountId,
            display_name: name,
            relationship,
            face_id: faceIds[0],
        };
        const { error } = await this.db().from('known_people').insert(person);
        if (error) {
            // Compensate for a failed DB write instead of keeping an unowned template.
            try {
                await this.deleteFaces(faceIds);
            } catch {
                console.error(
                    'Face enrollment rollback failed; inspect the account collection for orphan templates.',
                );
            }
            throw new Error('Profile could not be saved. Please try recognition again.', {
                cause: error,
            });
        }
        return person;
    }

    private async deleteFaces(ids: string[]): Promise<void> {
        const result = await this.aws().send(
            new DeleteFacesCommand({
                CollectionId: this.collectionId,
                FaceIds: ids,
            }),
            { abortSignal: AbortSignal.timeout(10_000) },
        );
        if (result.UnsuccessfulFaceDeletions?.length) {
            throw new Error('AWS could not delete the face.');
        }
    }

    async relationships(): Promise<Array<{ display_name: string; relationship: string }>> {
        const { data, error } = await this.db().from('known_people')
            .select('display_name, relationship').eq('account_id', this.accountId).limit(100);
        if (error) throw new Error('Known people could not be loaded.', { cause: error });
        return data ?? [];
    }

    async forget(person: KnownPerson): Promise<void> {
        if (person.account_id !== this.accountId) throw new Error('Account mismatch');
        await this.deleteFaces([person.face_id]);
        const { error } = await this.db().from('known_people').delete()
            .eq('account_id', this.accountId).eq('person_id', person.person_id);
        if (error) {
            throw new Error('Face removed, but profile deletion failed. Please retry.', {
                cause: error,
            });
        }
    }
}

export function createFaceSession(
    accountId: string,
    capture: () => Promise<Uint8Array>,
    supabase: SupabaseClient | null,
    ownerName = '',
): FaceSession {
    const session = new FaceSession(accountId, capture, new RekognitionFaceBackend(accountId, supabase), {
        load: loadMemoryContext,
        remember: rememberFact,
        recall: searchMemories,
    });
    session.ownerName = ownerName;
    return session;
}
