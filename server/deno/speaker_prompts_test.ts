/// <reference path="./types.d.ts" />
import { ok, strictEqual } from 'node:assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createConciergePrompt } from './concierge.ts';

// No live backend is used by these prompt/persistence-contract tests.
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:54321');
Deno.env.set('SUPABASE_KEY', 'test-key');
Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');
const { createSystemPrompt, addConversation } = await import('./supabase.ts');

function payload(story = false): IPayload {
    return {
        user: {
            user_id: 'account-id',
            supervisee_name: 'Amelie',
            supervisee_age: 7,
            supervisee_persona: 'ACCOUNT_PRIVATE_INTEREST',
            user_info: { user_type: 'user' },
            language: { name: 'German' },
            personality: {
                key: 'test',
                title: 'Story Friend',
                character_prompt: 'Speak playfully.',
                voice_prompt: 'Soft voice.',
                is_story: story,
            },
        } as IUser,
        supabase: {} as SupabaseClient,
        timestamp: new Date().toISOString(),
        speakerRecognition: true,
    };
}

Deno.test('concierge addresses Amelie as account owner and default speaker', () => {
    const prompt = createConciergePrompt(payload());
    ok(prompt.includes("The user's name is Amelie"));
    ok(prompt.includes('default speaker'));
    const legacy = payload();
    legacy.speakerRecognition = false;
    const legacyPrompt = createConciergePrompt(legacy);
    ok(legacyPrompt.includes("The user's name is Amelie"));
    strictEqual(legacyPrompt.includes('account owner'), false);
});

Deno.test('personality and story prompts keep the account owner as default speaker', () => {
    for (const story of [false, true]) {
        const p = payload(story);
        const history = [
            { role: 'user', content: 'ACCOUNT_HISTORY', created_at: new Date().toISOString() },
        ] as IConversation[];
        const prompt = createSystemPrompt(history, p);
        ok(prompt.includes('Speak playfully.'));
        ok(prompt.includes('Soft voice.'));
        ok(prompt.includes('Amelie'));
        ok(prompt.includes('ACCOUNT_PRIVATE_INTEREST'));
        ok(prompt.includes('ACCOUNT_HISTORY'));
        ok(prompt.includes('default speaker'));
        if (!story) ok(prompt.includes('German'));
    }
});

Deno.test('conversation persistence keeps account ownership and optional speaker ID separate', async () => {
    const rows: Record<string, unknown>[] = [];
    const db = {
        from: () => ({
            insert: (row: Record<string, unknown>) => {
                rows.push(row);
                return Promise.resolve({ error: null });
            },
        }),
    } as unknown as SupabaseClient;
    await addConversation(db, 'user', 'Hello', payload().user);
    await addConversation(db, 'user', 'Hello', payload().user, 'leo-id');
    strictEqual('person_id' in rows[0], false); // Disabled feature needs no migration.
    strictEqual(rows[1].person_id, 'leo-id');
    strictEqual(rows[1].user_id, 'account-id');
});
