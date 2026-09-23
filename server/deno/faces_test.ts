import { deepStrictEqual, strictEqual } from 'node:assert';
import {
    type FaceSearch,
    FaceSession,
    type FaceStatus,
    type KnownPerson,
    recognitionFirstMessage,
} from './faces.ts';

for (const stage of ['camera', 'recognition'] as const) {
    Deno.test(`${stage} failure logs a safe diagnostic and never creates an enrollment`, async () => {
        const failure = Object.assign(new Error('PRIVATE_UPSTREAM_DATA'), {
            name: stage === 'camera' ? 'TimeoutError' : 'AccessDeniedException',
        });
        const session = new FaceSession('account', () => {
            if (stage === 'camera') throw failure;
            return Promise.resolve(new Uint8Array([1, 2, 3]));
        }, {
            search: () => {
                throw failure;
            },
            enroll: () => {
                throw new Error('Enrollment must not happen');
            },
            forget: () => Promise.resolve(),
        }, {
            load: () => Promise.resolve(''),
            remember: () => Promise.resolve(false),
            recall: () => Promise.resolve([]),
        });
        const logs: string[] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => {
            logs.push(args.join(' '));
        };
        try {
            const result = await session.call('recognize_person');
            strictEqual(result.status, 'unavailable');
            strictEqual(result.observation_id, undefined);
            strictEqual(session.memoryScope, 'account');
            const diagnostic = JSON.parse(logs[0].slice(logs[0].indexOf('{')));
            strictEqual(diagnostic.stage, stage);
            strictEqual(diagnostic.code, stage === 'camera' ? 'TIMEOUT' : 'AccessDeniedException');
            strictEqual(JSON.stringify([result, logs]).includes('PRIVATE_UPSTREAM_DATA'), false);
        } finally {
            console.warn = originalWarn;
            session.close();
        }
    });
}

Deno.test('session start recognizes first and falls back to the account owner', () => {
    const message = recognitionFirstMessage('Say hello to the user\n\nGreet with Guten Abend.', 'Amelie');
    strictEqual(message.startsWith('Before greeting, call recognize_person once.'), true);
    strictEqual(message.includes('status=known, greet that person by name'), true);
    strictEqual(message.includes('greet the account owner, "Amelie", by name'), true);
    strictEqual(message.endsWith('Say hello to the user\n\nGreet with Guten Abend.'), true);
});

const account = '00000000-0000-0000-0000-000000000001';
const person: KnownPerson = {
    person_id: '00000000-0000-0000-0000-000000000002',
    account_id: account,
    display_name: 'Leo',
    relationship: 'Bruder von Amelie',
    face_id: 'face-1',
};

function fixture() {
    const calls: { kind: string; args: unknown[] }[] = [];
    let result: FaceSearch = { status: 'unknown' };
    let clock = 0;
    let fail = false;
    let memoryWorks = true;
    let memoryReadFails = false;
    const photo = new Uint8Array([1, 2, 3]);
    const session = new FaceSession(account, () => Promise.resolve(photo), {
        search: () => {
            if (fail) throw new Error('AWS unavailable');
            return Promise.resolve(result);
        },
        enroll: (image, name, relationship) => {
            calls.push({ kind: 'enroll', args: [image, name, relationship] });
            return Promise.resolve({ ...person, display_name: name, relationship });
        },
        forget: (p) => {
            calls.push({ kind: 'forget', args: [p] });
            return Promise.resolve();
        },
    }, {
        load: (scope) => {
            calls.push({ kind: 'load', args: [scope] });
            if (memoryReadFails) return Promise.reject(new Error('Memory unavailable'));
            return Promise.resolve('Likes dinosaurs');
        },
        remember: (scope, fact) => {
            calls.push({ kind: 'remember', args: [scope, fact] });
            return Promise.resolve(memoryWorks);
        },
        recall: (scope, query) => {
            calls.push({ kind: 'recall', args: [scope, query] });
            return Promise.resolve(['Likes dinosaurs']);
        },
    }, () => clock);
    return {
        session,
        calls,
        photo,
        setResult: (r: FaceSearch) => {
            result = r;
        },
        expire: () => {
            clock += 120_001;
        },
        fail: () => {
            fail = true;
        },
        disableMemory: () => {
            memoryWorks = false;
        },
        failMemoryRead: () => {
            memoryReadFails = true;
        },
    };
}

function test(name: string, fn: (f: ReturnType<typeof fixture>) => Promise<void>) {
    Deno.test(name, async () => {
        const f = fixture();
        try {
            await fn(f);
        } finally {
            f.session.close();
        }
    });
}

test('the account owner is the default speaker with the account memory scope', async ({ session }) => {
    session.ownerName = 'Amelie';
    strictEqual(session.person, null);
    strictEqual(session.memoryScope, account);
    deepStrictEqual(await session.context(), {
        status: 'account_owner',
        person: { name: 'Amelie', relationship: 'account owner' },
        instruction: 'Address the account owner by name.',
    });
});

test('unknown face keeps the account owner as speaker but stays enrollable', async ({ session, calls }) => {
    const result = await session.call('recognize_person');
    strictEqual(result.status, 'unknown');
    strictEqual(typeof result.observation_id, 'string');
    strictEqual(session.person, null);
    strictEqual(session.memoryScope, account);
    strictEqual((await session.call('remember', { fact: 'I like cars' })).success, true);
    strictEqual((await session.call('recall', { query: 'favorites' })).success, true);
    deepStrictEqual(calls.map((call) => call.args[0]), [account, account]);
});

test('enrollment needs explicit boolean consent and saves the exact observation', async ({ session, calls, photo }) => {
    const observation = await session.call('recognize_person');
    const args = {
        observation_id: observation.observation_id,
        name: 'Leo',
        relationship: 'Bruder von Amelie',
    };
    for (const consent of [false, undefined, 'true']) {
        strictEqual((await session.call('enroll_person', { ...args, consent })).success, false);
    }
    strictEqual(calls.length, 0);
    strictEqual((await session.call('enroll_person', { ...args, consent: true })).saved, true);
    deepStrictEqual(calls[0], { kind: 'enroll', args: [photo, 'Leo', 'Bruder von Amelie'] });
    strictEqual(session.person?.account_id, account);
    strictEqual((await session.call('enroll_person', { ...args, consent: true })).success, false);
});

test('expired or replaced observations cannot enroll', async ({ session, expire, calls }) => {
    const first = await session.call('recognize_person');
    await session.call('recognize_person');
    strictEqual(
        (await session.call('enroll_person', {
            observation_id: first.observation_id,
            name: 'Leo',
            consent: true,
        })).success,
        false,
    );
    const latest = await session.call('recognize_person');
    expire();
    strictEqual(
        (await session.call('enroll_person', {
            observation_id: latest.observation_id,
            name: 'Leo',
            consent: true,
        })).success,
        false,
    );
    strictEqual(calls.length, 0);
});

test('known person loads, writes and recalls only their own scoped memories', async ({ session, setResult, calls }) => {
    setResult({ status: 'known', person });
    const recognized = await session.call('recognize_person');
    deepStrictEqual(recognized.person, { name: 'Leo', relationship: 'Bruder von Amelie' });
    await session.call('remember', { fact: 'Leo likes cars.' });
    await session.call('recall', { query: 'interests' });
    strictEqual(calls.length, 3);
    for (const call of calls) strictEqual(call.args[0], `${account}:person:${person.person_id}`);
});

for (const status of ['no_face', 'multiple_faces', 'uncertain', 'unknown'] as const) {
    test(`${status} falls back to the account owner and never uses the previous person's memories`, async ({ session, setResult, calls }) => {
        setResult({ status: 'known', person });
        await session.call('recognize_person');
        setResult({ status });
        const result = await session.call('recognize_person');
        strictEqual(result.status, status);
        strictEqual(session.person, null);
        strictEqual((await session.call('recall', { query: 'secrets' })).success, true);
        strictEqual(calls.length, 2);
        deepStrictEqual(calls[1], { kind: 'recall', args: [account, 'secrets'] });
    });
}

test('API outage clears identity without creating an enrollable unknown face', async ({ session, setResult, fail }) => {
    setResult({ status: 'known', person });
    await session.call('recognize_person');
    fail();
    const result = await session.call('recognize_person');
    strictEqual(result.success, false);
    strictEqual(result.status, 'unavailable');
    strictEqual(result.observation_id, undefined);
    strictEqual(session.memoryScope, account);
});

test("a backend cannot attach another account's person", async ({ session, setResult }) => {
    setResult({ status: 'known', person: { ...person, account_id: 'other-account' } });
    strictEqual((await session.call('recognize_person')).success, false);
    strictEqual(session.memoryScope, account);
});

test('memory failure never reports a successful save', async ({ session, setResult, disableMemory }) => {
    setResult({ status: 'known', person });
    await session.call('recognize_person');
    disableMemory();
    strictEqual((await session.call('remember', { fact: 'I like cars' })).success, false);
});

test('forget requires confirmation and clears identity', async ({ session, setResult, calls }) => {
    setResult({ status: 'known', person });
    await session.call('recognize_person');
    strictEqual((await session.call('forget_person', { confirmed: false })).success, false);
    strictEqual((await session.call('forget_person', { confirmed: true })).success, true);
    strictEqual(calls.at(-1)?.kind, 'forget');
    strictEqual(session.memoryScope, account);
});

test('close discards pending enrollment', async ({ session, calls }) => {
    const result = await session.call('recognize_person');
    session.close();
    strictEqual(
        (await session.call('enroll_person', {
            observation_id: result.observation_id,
            name: 'Leo',
            consent: true,
        })).success,
        false,
    );
    strictEqual(calls.length, 0);
});

test('overlapping identity requests are rejected', async ({ session }) => {
    const first = session.call('recognize_person');
    const second = await session.call('recognize_person');
    strictEqual(second.success, false);
    strictEqual((await first).status, 'unknown');
});

test('memory read failure does not undo successful enrollment', async ({ session, failMemoryRead }) => {
    const observation = await session.call('recognize_person');
    failMemoryRead();
    const result = await session.call('enroll_person', {
        observation_id: observation.observation_id,
        name: 'Leo',
        relationship: '',
        consent: true,
    });
    strictEqual(result.success, true);
    strictEqual(result.saved, true);
    strictEqual(result.memories, '');
    strictEqual(session.person?.display_name, 'Leo');
});

test('display updates follow recognition without exposing IDs or memories', async ({ session, setResult }) => {
    const events: FaceStatus[] = [];
    session.subscribeStatus((state) => events.push(state));
    setResult({ status: 'known', person });
    await session.call('recognize_person');
    deepStrictEqual(events, [
        { status: 'unidentified', person: null },
        { status: 'recognizing', person: null },
        { status: 'known', person: { name: 'Leo', relationship: 'Bruder von Amelie' } },
    ]);
    setResult({ status: 'multiple_faces' });
    await session.call('recognize_person');
    deepStrictEqual(events.slice(-2), [
        { status: 'recognizing', person: null },
        { status: 'multiple_faces', person: null },
    ]);
    session.close();
    deepStrictEqual(events.at(-1), { status: 'closed', person: null });
});

test('enrollment and deletion update the displayed person', async ({ session }) => {
    const events: FaceStatus[] = [];
    session.subscribeStatus((state) => events.push(state));
    const observation = await session.call('recognize_person');
    await session.call('enroll_person', {
        observation_id: observation.observation_id,
        name: 'Leo',
        relationship: 'Bruder von Amelie',
        consent: true,
    });
    deepStrictEqual(events.slice(-3).map((event) => event.status), [
        'unknown',
        'enrolling',
        'known',
    ]);
    await session.call('forget_person', { confirmed: true });
    deepStrictEqual(events.at(-1), { status: 'forgotten', person: null });
});

test('recognition failure clears the displayed identity and subscribers can detach', async ({ session, setResult, fail }) => {
    const events: FaceStatus[] = [];
    const unsubscribe = session.subscribeStatus((state) => events.push(state));
    setResult({ status: 'known', person });
    await session.call('recognize_person');
    fail();
    await session.call('recognize_person');
    deepStrictEqual(events.at(-1), { status: 'unavailable', person: null });
    unsubscribe();
    const count = events.length;
    session.close();
    strictEqual(events.length, count);
});

test('broken status listener cannot interrupt face enrollment', async ({ session }) => {
    session.subscribeStatus(() => {
        throw new Error('Socket closed');
    });
    const observation = await session.call('recognize_person');
    const result = await session.call('enroll_person', {
        observation_id: observation.observation_id,
        name: 'Leo',
        relationship: '',
        consent: true,
    });
    strictEqual(result.saved, true);
});
