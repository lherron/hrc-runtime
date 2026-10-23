"""Reconstruct native transaction/readback observations without using claim flags."""
from common import Gap, exact


def need(value, reason):
    if not value:
        raise AssertionError(reason)


def stages(rows, expected):
    need([r['stage'] for r in rows] == expected, 'exact ordered boundary stages required')
    return {r['stage']: r for r in rows}


def appended(before, after, n=1):
    need(bool(before['page']['rows']), 'nonempty initial lifecycle page')
    need(after['page']['head'] == before['page']['head'] + n, 'allocated lifecycle highwater delta')
    need(after['streamHead'] == before['streamHead'] + n, 'shared stream allocator delta')
    need(len(after['page']['rows']) == len(before['page']['rows']) + n, 'persisted lifecycle row delta')
    need(exact(after['page']['rows'][:-n], before['page']['rows']), 'existing lifecycle rows changed')
    need(after['page']['ledgerIncarnationId'] == before['page']['ledgerIncarnationId'], 'incarnation changed inside transaction')


def atomic(c):
    f = 'atomic_e2e'
    def prove():
        raw = c.receipt(f, 'native-atomic.json')['observations']
        b = stages(raw['boundaries'], ['before', 'withinOuter', 'afterOuterRollback', 'withinSavepoint', 'afterSavepointRollback', 'afterSpillCommit', 'afterObserverFailureCommit'])
        before = b['before']['state']
        for within, after in [('withinOuter', 'afterOuterRollback'), ('withinSavepoint', 'afterSavepointRollback')]:
            appended(before, b[within]['state'])
            need(exact(before, b[after]['state']), 'rollback leaked full lifecycle/stream/blob state: ' + after)
            need(b[within]['hints'] == b[after]['hints'] == [], 'hint emitted before successful outer commit')
        spill = b['afterSpillCommit']
        appended(before, spill['state'])
        need(len(spill['state']['blobs']) == len(before['blobs']) + 1, 'spill commit missing stored blob')
        need(len(spill['hints']) == 1 and spill['hints'][0]['kind'] == 'lifecycle', 'exact committed hint kind/cardinality')
        need(exact(spill['committedChanges'], spill['hints']), 'committed changes differ from ordered observer receipts')
        need(exact(raw['pageAfterSpill'], spill['state']['page']), 'spill page readback differs from boundary')
        hydrated = raw['hydrated']
        need(exact(hydrated['payload'], raw['spillInput']['payload']), 'exact spill payload failed hydration')
        need(hydrated['payload']['result']['content'] == [{'type': 'text', 'text': '🫠' * 20000}], 'spill no longer exercises large UTF8 payload')
        stub = spill['state']['page']['rows'][-1]
        need(stub['hrcSeq'] == hydrated['hrcSeq'] and stub['payload']['result']['details']['spill'], 'actual stub/hydrated identity')
        success = b['afterObserverFailureCommit']
        appended(spill['state'], success['state'])
        need(len(success['hints']) == 2 and exact(success['hints'][0], spill['hints'][0]), 'observer failure interrupted commit/ordered hints')
        need(exact(success['committedChanges'], success['hints'][1:]), 'observer failure committed changes differ')
        need(success['hints'][-1]['event']['hrcSeq'] == success['state']['page']['rows'][-1]['hrcSeq'], 'observer event identity differs from committed row')
        first = raw['firstPart']
        need(first == {'blobId': 'p1-part', 'runtimeId': 'p1-blob-runtime', 'kind': 'broker_raw', 'bytes': 7, 'part': 0, 'parts': 2, 'chunk': '{"a":'}, 'part input identity')
        need(exact(raw['initialPartOutcome'], {'completed': False, 'duplicate': False}), 'initial part incorrectly completed')
        need(raw['invalidPartError']['code'] == 'malformed_request' and any(text in raw['invalidPartError']['message'] for text in ('invalid assembled blob p1-part', 'invalid assembled tool-result blob p1-part')), 'invalid bytes refusal absent')
        need(exact(raw['completePartOutcome'], {'completed': True, 'duplicate': False}), 'part assembly outcome')
        need(raw['assembledBlob']['blobId'] == 'p1-part' and raw['assembledBlob']['resultJson'] == '{"a":1}' and raw['assembledBlob']['bytes'] == 7 and raw['assembledBlob']['complete'] is True, 'assembled stored blob identity/value')
        need(raw['readOnlyError']['code'] == 'malformed_request' and 'read-only store' in raw['readOnlyError']['message'], 'read-only write refusal')
    c.check(f, 'transaction-spill-observers', prove)
    def parts():
        o = c.receipt(f, 'native-atomic.json')['observations']
        raw = stages(o['partBoundaries'], ['beforePart', 'afterFirstPart', 'withinCaughtInvalidPart', 'afterInvalidPart', 'afterCompletePart'])
        b = {key: value['state'] for key, value in raw.items()}
        need(b['beforePart'] == {'parts': [], 'blob': None}, 'part control initially nonempty')
        need(b['afterFirstPart'] == {'parts': [o['firstPart']], 'blob': None}, 'first part persisted input/state')
        need(exact(b['afterFirstPart'], b['withinCaughtInvalidPart']) and exact(b['afterFirstPart'], b['afterInvalidPart']), 'caught invalid part leaked saved part/blob state')
        need(o['invalidPartInput'] == {**o['firstPart'], 'part': 1, 'bytes': 8, 'chunk': '1}'}, 'invalid assembly input identity/bytes')
        need(b['afterCompletePart']['parts'] == [] and exact(b['afterCompletePart']['blob'], o['assembledBlob']), 'complete assembly did not consume parts/persist exact blob')
        need(bool(o['readOnlyBefore']['page']['rows']) and exact(o['readOnlyBefore'], o['readOnlyAfter']), 'read-only refusal changed core persisted state')
        bun = c.receipt(f, 'bun-parts.json')
        need(exact(bun['first'], o['firstPart']) and exact(bun['invalid'], o['invalidPartInput']), 'Bun/native part inputs differ')
        need(exact(bun['initial'], o['initialPartOutcome']) and exact(bun['complete'], o['completePartOutcome']), 'Bun/native actual assembly outcomes differ')
        need(bun['error']['message'] == o['invalidPartError']['cause'], 'exact Bun/native invalid assembly cause differs')
        def normalized(rows):
            import datetime
            result = []
            for row in rows:
                state = {'parts': row['state']['parts'], 'blob': row['state']['blob']}
                if state['blob'] is not None:
                    blob = dict(state['blob'])
                    need(type(blob['rowid']) is int and blob['rowid'] > 0, 'invalid generated blob rowid')
                    parsed = datetime.datetime.fromisoformat(blob['createdAt'].replace('Z', '+00:00'))
                    need(parsed.utcoffset() == datetime.timedelta(0), 'invalid observed blob UTC clock')
                    del blob['rowid'], blob['createdAt']  # These exact generated blob fields only.
                    state['blob'] = blob
                result.append({'stage': row['stage'], 'state': state})
            return result
        need(exact(normalized(bun['boundaries']), normalized(o['partBoundaries'])), 'all Bun/native part boundary states differ')
    c.check(f, 'invalid-part-effects', parts)


def reconciliation(c):
    f = 'reconciliation_e2e'
    def prove():
        r = c.receipt(f, 'native.json')
        b = stages(r['boundaries'], ['before', 'withinRollback', 'afterRollback', 'withinCommit', 'afterCommit'])
        before = b['before']['state']
        need(before['atomicRun']['runId'] == 'atomic-run' and before['atomicRun']['status'] == 'running', 'atomic initial run identity/status')
        need(before['atomicRuntime']['runtimeId'] == 'atomic-runtime' and before['atomicRuntime']['activeRunId'] == 'atomic-run', 'atomic initial runtime ownership')
        for key in ('withinRollback', 'withinCommit', 'afterCommit'):
            state = b[key]['state']
            appended(before, state)
            need(state['atomicRun']['status'] == 'completed' and state['atomicRun']['completedAt'] == '2026-10-23T01:00:00.000Z', 'atomic terminal CAS did not persist exact completion')
            need(state['atomicRuntime']['status'] == 'ready' and 'activeRunId' not in state['atomicRuntime'], 'atomic release did not clear ownership')
            event = state['page']['rows'][-1]
            need(event['runId'] == 'atomic-run' and event['runtimeId'] == 'atomic-runtime' and event['eventKind'] == 'turn.completed', 'atomic lifecycle identity')
            need(event['payload'] == {'source': 'reconciliation', 'success': True}, 'atomic lifecycle payload')
        need(exact(b['afterRollback']['state'], before), 'atomic rollback leaked full run/runtime/ledger/stream/blob state')
        need(exact(b['withinCommit']['state'], b['afterCommit']['state']), 'outer commit lost coupled state')
        for key in ('before', 'withinRollback', 'afterRollback', 'withinCommit'):
            need(b[key]['hints'] == [], 'post-commit hint before commit or after rollback')
        committed = b['afterCommit']
        need([hint['kind'] for hint in committed['hints']] == ['runtime', 'lifecycle'], 'exact ordered committed runtime/lifecycle hints')
        need(committed['hints'][0]['runtime_id'] == 'atomic-runtime', 'runtime hint identity')
        need(exact(committed['hints'][1]['event'], committed['state']['page']['rows'][-1]), 'lifecycle hint differs from committed row')
        need(exact(committed['hints'], committed['committedChanges']), 'ordered observer and committed changes differ')
    c.check(f, 'atomic-boundaries', prove)


def transcript(c):
    f = 'transcript_e2e'
    def prove():
        r = c.receipt(f, 'native.json')
        b = stages(r['boundaries'], ['before', 'afterInitialInsert', 'withinDeleteRollback', 'afterDeleteRollback', 'afterTextUpdate', 'afterMultipleTurns', 'afterDeleteB', 'afterCursorMark'])
        s = {k: row['state'] for k, row in b.items()}
        need(s['before']['turnsA'] == s['before']['turnsB'] == s['before']['cafe'] == [], 'FTS initial state')
        first = s['afterInitialInsert']
        need(len(first['turnsA']) == len(first['cafe']) == 1, 'nonempty initial unicode tokenizer match')
        need(first['turnsA'][0]['invocationId'] == first['cafe'][0]['invocationId'] == 'p1-fts-a' and first['turnsA'][0]['userText'] == 'café', 'unicode FTS match identity/text')
        need(s['withinDeleteRollback']['turnsA'] == s['withinDeleteRollback']['cafe'] == [], 'FTS rollback control did no deletion')
        need(exact(first, s['afterDeleteRollback']), 'FTS rollback did not restore full turns/hits/stats/cursor/mark')
        update = s['afterTextUpdate']
        need(update['cafe'] == [] and len(update['newword']) == len(update['turnsA']) == 1 and update['turnsA'][0]['userText'] == 'newword', 'FTS update retained old token/lost new token')
        many = s['afterMultipleTurns']
        need([(t['invocationId'], t['seqFrom'], t['seqTo']) for t in many['turnsA'] + many['turnsB']] == [('p1-fts-a', 1, 2), ('p1-fts-a', 3, 4), ('p1-fts-b', 1, 2)], 'typed multi-turn identities/order')
        need([(t['invocationId'], t['seqFrom']) for t in many['cafe']] == [('p1-fts-a', 1), ('p1-fts-b', 1), ('p1-fts-a', 3)], 'ranked FTS full result order')
        need([(t['invocationId'], t['seqFrom']) for t in many['cappedCafe']] == [('p1-fts-a', 1), ('p1-fts-b', 1)], 'per-runtime cap identity/order')
        deleted = s['afterDeleteB']
        need(deleted['turnsB'] == [] and len(deleted['cafe']) == 2 and all(hit['invocationId'] == 'p1-fts-a' for hit in deleted['cafe']), 'FTS deletion kept ghost rows or lost unrelated hits')
        need(r['invalidWeightsError']['code'] == 'malformed_request' and 'weight' in r['invalidWeightsError']['message'].lower(), 'negative BM25 refusal absent')
        end = s['afterCursorMark']
        need(end['cursor'] == end['stats']['lastEventId'] == 7 and end['stats']['turnsIndexed'] == 2, 'transcript cursor/stats')
        need(end['markA'] == {'invocationId': 'p1-fts-a', 'runtimeId': 'p1-runtime-a', 'lastTerminalSeq': 4, 'updatedAt': 'now'}, 'exact transcript mark')
        need(exact(end['turnsA'], deleted['turnsA']) and exact(end['cafe'], deleted['cafe']), 'cursor/mark changed indexed content')
        bun = c.receipt(f, 'bun-read.json')
        need(bun['stats'] == end['stats'] and len(bun['hits']) == 2, 'unchanged Bun FTS final readback')
    c.check(f, 'fts-transaction-readbacks', prove)


def session(c):
    f = 'session_e2e'
    def prove():
        o = c.receipt(f, 'native.json')['observations']
        need(o['initial']['hostSessionId'] == 'p1-host' and o['initial']['generation'] == 1, 'initial session identity')
        need(o['continuity']['activeHostSessionId'] == 'p1-host-next' and o['continuity']['priorHostSessionIds'] == ['p1-host'], 'session lineage order')
        disabled = o['disabledWithin']
        restored = o['continuationAfter']
        need(disabled['disabled'] is True and 'continuation' not in disabled['session'], 'disabled continuation still reused')
        need(restored['disabled'] is False and restored['session']['continuation'] == {'nativeId': 'p1-session'}, 'continuation reuse reset')
        need(o['metadataPrecedence']['metadata']['title'] == 'native title' and o['metadataPrecedence']['metadata']['appearance']['color'] == '#112233', 'metadata precedence values')
        need(len(o['metadataPrecedence']['metadataSources']['title']['shadowed']) == 1, 'metadata precedence provenance/shadowing')
        need(o['successorTitle']['hostSessionId'] == 'p1-host-next' and o['successorTitle']['title'] == 'native title', 'title continuity facade')
        need(o['afterTitleDelete']['title']['title'] == 'fallback', 'title delete fallback')
        invalid = o['invalidMetadata']
        need(invalid['input'] == {'title': '', 'valid': True}, 'metadata invalid input control')
        need(invalid['error']['code'] == 'malformed_request' and 'title' in invalid['error']['message'], 'metadata refusal details')
        need(bool(invalid['before']['core']['page']['rows']) and exact(invalid['before'], invalid['after']), 'invalid metadata leaked core/metadata effects')
        need(o['cursor'] == {'first': 9, 'lowerAdvance': 9, 'stored': 9}, 'nonregressing session cursor')
        need([r['hostSessionId'] for r in o['sessionsAfter']] == ['p1-host', 'p1-host-next'], 'session final identities/order')
        bun = c.receipt(f, 'bun-readback.json')
        need(len(bun['sessions']) == 2, 'unchanged Bun session readback cardinality')
    c.check(f, 'lineage-metadata-cursor', prove)


def repository(c):
    f = 'repository_e2e'
    def prove():
        o = c.receipt(f, 'native.json')['observations']
        before, after = o['before'], o['after']
        need(before['roster'] == [] and len(after['roster']) == 1 and after['roster'][0]['idempotencyKey'] == 'p1-claim', 'roster persisted identity/cardinality')
        for name, code in [('acceptance', 'federation_acceptance_conflict'), ('artifacts', 'runtime_artifact_conflict')]:
            r = o[name]
            need(r['error']['code'] == code, 'exact repository conflict refusal: ' + name)
            need(exact(r['beforeConflict'], r['afterConflict']) and not exact(r['beforeConflict'], before), 'conflict leaked repository rows or control did no prior writes: ' + name)
        ack = o['acceptance']
        need(ack['first']['outcome'] == 'recorded' and ack['repeat']['outcome'] == 'duplicate', 'acceptance first/repeat result')
        need(exact(ack['first']['record'], ack['repeat']['record']) and exact(after['acceptance'], ack['first']['record']), 'idempotent acceptance changed record')
        need(after['acceptance'] == {'requestMessageId': 'p1-message', 'acceptedByNodeId': 'p1-node', 'acceptedEpoch': 1, 'acceptedAt': '2026-10-23T00:00:00.000Z'}, 'exact acceptance identity')
        artifact = o['artifacts']
        need(exact(artifact['first'], artifact['repeat']) and after['artifacts'] == [artifact['first']], 'artifact idempotent persisted record')
        need(artifact['first']['artifactId'] == 'p1-artifact' and artifact['first']['contentHash'] == 'fixture-hash' and artifact['first']['artifactJson'] == '{}', 'artifact stored content')
        permission = o['permissionIdentity']
        need(permission['key'] == '["p1-invocation",1,null,"p1-permission"]' and permission['input']['permissionIdentityKey'] == permission['key'], 'permission composite null/identity encoding')
        need(after['permissions'] == [permission['input']], 'persisted full permission record')
        need(len(after['retained']) == 2 and [r['outcome'] for r in after['retained']] == ['first', 'second'], 'retained append order/content')
        need(len({r['outcomeId'] for r in after['retained']}) == 2 and after['retainedLatest'] == [after['retained'][-1]], 'retained immutable distinct identities/latest selection')
        need(o['emissions'] == {'first': True, 'repeat': False, 'count': 1} and before['emissionCount'] == 0 and after['emissionCount'] == 1, 'emission dedup persisted count')
        need([(r['chunkSeq'], r['text']) for r in after['buffers']] == [(0, '0'), (1, '1'), (2, '2')], 'buffer full order/content')
        need(after['bufferTail'] == after['buffers'][1:], 'bounded buffer tail order/content')
        need(len(o['displacedSurfaces']) == 1 and o['displacedSurfaces'][0]['surfaceId'] == 'p1-surface' and o['displacedSurfaces'][0]['reason'] == 'replaced', 'surface displacement identity/reason')
        need(len(after['activeSurfaces']) == 1 and after['activeSurfaces'][0]['surfaceId'] == 'p1-successor', 'surface replacement active identity/cardinality')
        need(after['bridge']['bridgeId'] == 'p1-bridge' and after['bridge']['status'] == 'closed' and after['activeBridges'] == [], 'bridge close persisted state/active selection')
    c.check(f, 'family-operations', prove)
    def roster():
        o = c.receipt(f, 'native.json')['observations']['rosterRollback']
        need(exact(o['before'], o['after']), 'aborted roster transaction leaked coupled state')
        need(len(o['before']['roster']) == 1 and len(o['within']['roster']) == 2, 'roster rollback control did no real insertion')
        need(o['within']['roster'][0] == o['before']['roster'][0], 'roster insert changed existing claim')
        need(o['within']['roster'][1]['idempotencyKey'] != o['before']['roster'][0]['idempotencyKey'], 'roster rollback insertion identity reused')
        need(exact({k: v for k, v in o['before'].items() if k != 'roster'}, {k: v for k, v in o['within'].items() if k != 'roster'}), 'roster control changed unrelated family state')
        bun = c.receipt(f, 'bun-roster.json')
        need(exact(bun, {key: o[key]['roster'] for key in ('before', 'within', 'after')}), 'actual Bun/native roster rollback rows differ')
    c.check(f, 'roster-atomicity', roster)


def run(c):
    atomic(c)
    reconciliation(c)
    transcript(c)
    session(c)
    repository(c)
