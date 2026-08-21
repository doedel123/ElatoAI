/// <reference path="./types.d.ts" />

/**
 * Vertex AI Memory Bank client (REST, v1beta1).
 *
 * Ported from the Reachy-Mini webapp's memory.py. Uses a GCP service-account
 * key (env GCP_SA_KEY_JSON, or GCP_SA_KEY_FILE for local dev) to mint OAuth2
 * access tokens via the JWT-bearer flow — no gcloud/ADC needed on Deno Deploy.
 *
 *   POST {parent}/memories:retrieve  — synchronous similarity search
 *   POST {parent}/memories:generate  — transcript/fact ingestion (LRO, fire & forget)
 *
 * Memory Bank only ranks by similarity, so we over-fetch and re-rank
 * client-side with a recency bonus: score = (1-distance) + α·exp(-age/τ).
 *
 * If VERTEX_MEMORY_ENGINE or credentials are missing the module degrades to a
 * disabled backend: retrieval returns empty, saves are no-ops (logged once).
 */

import * as jose from 'https://deno.land/x/jose@v5.9.6/index.ts';

const RECENCY_ALPHA = Number(Deno.env.get('MEMORY_RECENCY_ALPHA') ?? '0.15');
const RECENCY_TAU_DAYS = 30.0;
const MAX_DISTANCE = 1.5;
const DEFAULT_FETCH_K = 50;
const DEFAULT_TOP_K = Number(Deno.env.get('MEMORY_TOP_K') ?? '20');

const MEMORY_SEARCH_QUERY =
    'What do I know about this user, their preferences, and our recent conversations?';

// Full resource name: projects/{p}/locations/{loc}/reasoningEngines/{id}
const ENGINE = (Deno.env.get('VERTEX_MEMORY_ENGINE') ?? '').trim();

export interface TranscriptTurn {
    role: 'user' | 'assistant';
    content: string;
}

// ── Service-account auth (JWT bearer → access token) ─────────────────────────

interface SaKey {
    client_email: string;
    private_key: string;
    token_uri?: string;
}

let cachedSaKey: SaKey | null | undefined; // undefined = not loaded yet
let cachedToken: { token: string; expiresAt: number } | null = null;
let warnedDisabled = false;

function loadSaKey(): SaKey | null {
    if (cachedSaKey !== undefined) return cachedSaKey;
    try {
        const inline = Deno.env.get('GCP_SA_KEY_JSON');
        if (inline) {
            cachedSaKey = JSON.parse(inline);
            return cachedSaKey!;
        }
        const file = Deno.env.get('GCP_SA_KEY_FILE');
        if (file) {
            cachedSaKey = JSON.parse(Deno.readTextFileSync(file));
            return cachedSaKey!;
        }
    } catch (e) {
        console.error('Memory: failed to load GCP service-account key:', (e as Error).message);
    }
    cachedSaKey = null;
    return null;
}

function memoryEnabled(): boolean {
    const ok = ENGINE.length > 0 && loadSaKey() !== null;
    if (!ok && !warnedDisabled) {
        warnedDisabled = true;
        console.warn(
            'Memory: disabled (set VERTEX_MEMORY_ENGINE and GCP_SA_KEY_JSON or GCP_SA_KEY_FILE to enable)',
        );
    }
    return ok;
}

async function getAccessToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token;

    const key = loadSaKey();
    if (!key) throw new Error('no GCP service-account key configured');

    const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
    const privateKey = await jose.importPKCS8(key.private_key, 'RS256');
    const assertion = await new jose.SignJWT({
        scope: 'https://www.googleapis.com/auth/cloud-platform',
    })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(key.client_email)
        .setAudience(tokenUri)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

    const resp = await fetch(tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        }),
    });
    if (!resp.ok) {
        throw new Error(`token exchange failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    cachedToken = {
        token: data.access_token,
        expiresAt: now + (data.expires_in ?? 3600) * 1000,
    };
    return cachedToken.token;
}

// ── REST helpers ─────────────────────────────────────────────────────────────

function apiBase(): string {
    // Location is embedded in the engine resource name.
    const m = ENGINE.match(/locations\/([^/]+)/);
    const location = m?.[1] ?? 'us-central1';
    return `https://${location}-aiplatform.googleapis.com/v1beta1`;
}

async function api(path: string, body: unknown): Promise<any> {
    const token = await getAccessToken();
    const resp = await fetch(`${apiBase()}/${ENGINE}/${path}`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        throw new Error(`${path} failed: ${resp.status} ${await resp.text()}`);
    }
    return resp.json();
}

// ── Retrieval with recency re-ranking ────────────────────────────────────────

function ageDays(mem: any, now: number): number {
    const ts = mem?.createTime ?? mem?.updateTime;
    if (!ts) return 365;
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return 365;
    return Math.max(0, (now - t) / 86_400_000);
}

function rerankWithRecency(memories: any[]): any[] {
    const now = Date.now();
    const score = (m: any) => {
        const sim = 1.0 - Number(m.distance ?? 0);
        const bonus = RECENCY_ALPHA * Math.exp(-ageDays(m.memory, now) / RECENCY_TAU_DAYS);
        return sim + bonus;
    };
    return [...memories].sort((a, b) => score(b) - score(a));
}

async function retrieve(
    userId: string,
    query: string,
    fetchK = DEFAULT_FETCH_K,
    topK = DEFAULT_TOP_K,
): Promise<string[]> {
    if (!memoryEnabled()) return [];
    try {
        const resp = await api('memories:retrieve', {
            scope: { user_id: userId },
            similarity_search_params: { search_query: query, top_k: fetchK },
        });
        const all: any[] = resp.retrievedMemories ?? [];
        const kept = all.filter((m) => m.distance == null || m.distance <= MAX_DISTANCE);
        return rerankWithRecency(kept)
            .slice(0, topK)
            .map((m) => m.memory?.fact)
            .filter((f): f is string => typeof f === 'string' && f.length > 0);
    } catch (e) {
        console.warn('Memory: retrieve failed:', (e as Error).message);
        return [];
    }
}

/** Session-start context block for the system prompt ('' when nothing stored). */
export async function loadMemoryContext(userId: string): Promise<string> {
    const facts = await retrieve(userId, MEMORY_SEARCH_QUERY);
    if (facts.length === 0) return '';
    console.log(`Memory: injecting ${facts.length} facts for user=${userId}`);
    const numbered = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
    return `<memory_bank>\nRelevant memories from prior sessions:\n${numbered}\n</memory_bank>`;
}

/** Mid-conversation recall for the `recall` tool. */
export async function searchMemories(userId: string, query: string, topK = 10): Promise<string[]> {
    return await retrieve(userId, query, Math.max(topK * 2, 20), topK);
}

// ── Ingestion ────────────────────────────────────────────────────────────────

function isMeaningfulTurn(t: TranscriptTurn): boolean {
    const c = t.content.trim();
    if (!c) return false;
    if (c.startsWith('{') && c.endsWith('}')) return false; // tool-result JSON
    if (t.role === 'user' && c.length < 20) return false; // "okay", "ja"
    return true;
}

/**
 * Ingest a session transcript (fire & forget LRO). Vertex extracts and
 * consolidates facts server-side, so re-sending overlapping snapshots is safe.
 */
export async function saveSessionTranscript(
    userId: string,
    transcript: TranscriptTurn[],
): Promise<void> {
    if (!memoryEnabled() || transcript.length === 0) return;
    const meaningful = transcript.filter(isMeaningfulTurn);
    const userLen = meaningful
        .filter((t) => t.role === 'user')
        .reduce((n, t) => n + t.content.length, 0);
    const totalLen = meaningful.reduce((n, t) => n + t.content.length, 0);
    if (userLen < 20 || totalLen < 100) {
        console.log(`Memory: skipped save — too short (user=${userLen}, total=${totalLen})`);
        return;
    }
    const events = meaningful.map((t) => ({
        content: { role: t.role, parts: [{ text: t.content.slice(0, 4000) }] },
    }));
    try {
        await api('memories:generate', {
            scope: { user_id: userId },
            direct_contents_source: { events },
            revision_labels: { source: 'session' },
        });
        console.log(`Memory: sent ${events.length} turns to extraction (user=${userId})`);
    } catch (e) {
        console.warn('Memory: save failed:', (e as Error).message);
    }
}

/** Store one explicit fact (the `remember` tool). */
export async function rememberFact(userId: string, fact: string): Promise<void> {
    if (!memoryEnabled()) return;
    try {
        await api('memories:generate', {
            scope: { user_id: userId },
            direct_contents_source: {
                events: [{
                    content: {
                        role: 'user',
                        parts: [{ text: `Remember this fact about me: ${fact}` }],
                    },
                }],
            },
            revision_labels: { source: 'explicit' },
        });
        console.log(`Memory: stored explicit fact for user=${userId}`);
    } catch (e) {
        console.warn('Memory: remember failed:', (e as Error).message);
    }
}
