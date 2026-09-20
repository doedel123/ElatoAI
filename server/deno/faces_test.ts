import { deepStrictEqual, strictEqual } from 'node:assert';
import { type FaceSearch, FaceSession, type FaceStatus, type KnownPerson } from './faces.ts';

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

test('unknown face is not the account owner and has no memory scope', async ({ session, calls }) => {
    const result = await session.call('recognize_person');
    strictEqual(result.status, 'unknown');
    strictEqual(typeof result.observation_id, 'string');
    strictEqual(session.memoryScope, null);
    strictEqual((await session.call('remember', { fact: 'I like cars' })).success, false);
    strictEqual((await session.call('recall', { query: 'favorites' })).success, false);
    strictEqual(calls.length, 0);
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
    test(`${status} clears a previous identity and cannot use its memories`, async ({ session, setResult, calls }) => {
        setResult({ status: 'known', person });
        await session.call('recognize_person');
        setResult({ status });
        const result = await session.call('recognize_person');
        strictEqual(result.status, status);
        strictEqual(session.person, null);
        strictEqual((await session.call('recall', { query: 'secrets' })).success, false);
        strictEqual(calls.length, 1);
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
    strictEqual(session.memoryScope, null);
});

test("a backend cannot attach another account's person", async ({ session, setResult }) => {
    setResult({ status: 'known', person: { ...person, account_id: 'other-account' } });
    strictEqual((await session.call('recognize_person')).success, false);
    strictEqual(session.memoryScope, null);
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
    strictEqual(session.memoryScope, null);
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
