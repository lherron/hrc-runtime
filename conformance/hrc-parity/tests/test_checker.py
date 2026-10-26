"""Black-box checker controls. Captured Bun status supplies the wire example.
Mutations deliberately break evidence; they are never daemon-parity fixtures.
"""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
RUNNER = ROOT / 'conformance/hrc-parity/run.py'
OBSERVED = Path(__file__).parent / 'observed-bun-status.json'


class CheckerBehavior(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def command(self, *args):
        result = subprocess.run([sys.executable, str(RUNNER), *map(str, args)],
                                text=True, capture_output=True)
        try:
            report = json.loads(result.stdout)
        except (ValueError, TypeError):
            self.fail('Runner did not emit its result schema: ' + result.stdout + result.stderr)
        self.assertEqual(report.get('schema'), 1)
        self.assertIsInstance(report.get('classification'), str)
        self.assertTrue(report.get('reason'))
        self.assertIsInstance(report.get('checks'), list)
        self.assertTrue(report['checks'])
        output = Path(str(args[list(args).index('--out') + 1])) / 'summary.json'
        self.assertTrue(output.is_file(), 'Runner result artifact is absent')
        self.assertEqual(json.loads(output.read_text()), report)
        self.assertEqual(report['exitCode'], result.returncode)
        expected = {0: 'PASS', 1: 'FAIL', 2: 'GAP', 3: 'INFRA_ERROR'}
        self.assertEqual(report['classification'], expected[result.returncode])
        return result

    def evidence(self, name, mutate=None):
        p = self.root / name
        p.mkdir()
        status = json.loads(OBSERVED.read_text())
        data = {'schema': 1, 'claim': 'checker-control', 'complete': True,
                'coverageReportHash': 'same-source', 'status': status,
                'cases': [{'id': 'cold-second-turn', 'status': 'PASS',
                           'assertions': [{'id': 'terminal', 'pass': True, 'validator': 'turn-evidence'}],
                           'evidence': ['events.json']}],
                'events': [
                    {'identity': 'turn-a', 'invocationId': 'inv-a', 'runtimeId': 'rt-a',
                     'scopeRef': 'scope-a', 'laneRef': 'main', 'generation': 0,
                     'eventKind': 'turn.message', 'final': True, 'text': 'OK'},
                    {'identity': 'turn-a', 'invocationId': 'inv-a', 'runtimeId': 'rt-a',
                     'scopeRef': 'scope-a', 'laneRef': 'main', 'generation': 0,
                     'eventKind': 'turn.completed'}],
                'effects': [{'key': 'terminal:turn-a', 'count': 1}],
                'coverage': {'required': ['cold-second-turn'], 'gaps': []}}
        second = copy.deepcopy(data['events'])
        for e in second:
            e['identity'] = 'turn-b'
            e['invocationId'] = 'inv-b'
        data['events'].extend(second)
        data['effects'].append({'key': 'terminal:turn-b', 'count': 1})
        if mutate:
            mutate(data)
        (p / 'summary.json').write_text(json.dumps(data))
        (p / 'events.json').write_text(json.dumps(data['events']))
        return p

    def compare(self, mutate=None):
        a = self.evidence('baseline')
        b = self.evidence('candidate', mutate)
        return self.command('compare', '--baseline', a, '--candidate', b,
                            '--out', self.root / 'result')

    def test_observed_status_and_identical_evidence_pass(self):
        self.assertEqual(self.compare().returncode, 0)

    def test_missing_required_status_field_fails(self):
        p = self.compare(lambda d: d['status']['api'].pop('dbPath'))
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)

    def test_wrong_field_type_fails(self):
        p = self.compare(lambda d: d['status']['release'].__setitem__('runningEqualsInstalled', 'true'))
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)

    def test_duplicate_effect_fails(self):
        p = self.compare(lambda d: d['effects'][0].__setitem__('count', 2))
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)

    def test_missing_terminal_fails(self):
        p = self.compare(lambda d: d['events'].pop())
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)

    def test_broker_turn_does_not_require_run_row(self):
        self.assertEqual(self.compare().returncode, 0)

    def test_empty_suite_is_coverage_gap(self):
        p = self.compare(lambda d: d.__setitem__('cases', []))
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)

    def test_skipped_case_is_coverage_gap(self):
        p = self.compare(lambda d: d['cases'][0].__setitem__('status', 'SKIP'))
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)

    def test_no_assertions_is_not_pass(self):
        p = self.compare(lambda d: d['cases'][0].__setitem__('assertions', []))
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)

    def test_interrupted_artifact_is_not_pass(self):
        p = self.compare(lambda d: d.__setitem__('complete', False))
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)

    def test_missing_case_evidence_is_not_pass(self):
        p = self.compare(lambda d: d['cases'][0].__setitem__('evidence', ['absent.json']))
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)

    def test_drifted_inventory_is_not_pass(self):
        p = self.compare(lambda d: d.__setitem__('coverageReportHash', 'different-source'))
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)

    def test_empty_events_and_effects_fail(self):
        a = self.evidence('baseline', lambda d: (d.__setitem__('events', []), d.__setitem__('effects', [])))
        b = self.evidence('candidate', lambda d: (d.__setitem__('events', []), d.__setitem__('effects', [])))
        p = self.command('compare', '--baseline', a, '--candidate', b, '--out', self.root / 'result')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('nonempty', p.stdout)

    def test_one_turn_cannot_be_labeled_as_two(self):
        p = self.compare(lambda d: d.__setitem__('events', d['events'][:2]))
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('two distinct', p.stdout)

    def test_missing_both_correlation_fences_fail(self):
        def remove(d):
            for e in d['events']:
                for k in ('identity', 'invocationId', 'runtimeId', 'scopeRef', 'laneRef', 'generation'):
                    e.pop(k, None)
        p = self.compare(remove)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('correlation', p.stdout)

    def test_reduced_required_coverage_fails(self):
        p = self.compare(lambda d: d['coverage'].__setitem__('required', []))
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('mandatory', p.stdout)

    def test_semantic_predicate_cannot_be_a_status_presence_check(self):
        def replace(d):
            d['cases'][0]['assertions'] = [{'id': 'two-real-identities', 'pass': True,
                'predicate': {'op': 'exists', 'path': 'status'}}]
        p = self.compare(replace)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('semantic', p.stdout)

    def test_pty_error_output_does_not_prove_attachment(self):
        spec = importlib.util.spec_from_file_location('checker', RUNNER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        checks = []
        module.validate_case_observations('attach-restart-resume-terminate',
            [{'transport': 'pty', 'stdout': "can't find session: __p0_missing_validation_target__",
              'exit': 1, 'detached': True}], checks)
        check = next(c for c in checks if c['id'].endswith(':PTY-attach-detach'))
        self.assertFalse(check['pass'], 'tmux error output falsely proves attachment')

    def semantic_check(self, case, observations, suffix, status=None):
        spec = importlib.util.spec_from_file_location('checker', RUNNER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        checks = []
        module.validate_case_observations(case, observations, checks, status)
        return next(c for c in checks if c['id'].endswith(':' + suffix))

    def test_two_cursor_owners_cannot_be_a_node_label(self):
        c = self.semantic_check('wrkq', [{'kind': 'publication', 'nodeId': 'p0-test',
            'facts': [{'type': 'server.started'}]}], 'two-cursor-owners')
        self.assertFalse(c['pass'])

    def test_startup_does_not_prove_stop(self):
        c = self.semantic_check('jobs-files-listeners', [{'kind': 'server-log',
            'events': ['server.start.ready', 'broker.warmup.complete']}], 'startup-stop-effects')
        self.assertFalse(c['pass'])

    def test_monitor_show_does_not_prove_wait(self):
        c = self.semantic_check('direct-cli-sdk', [{'argv': ['hrc','monitor','show'], 'exit':0}],
            'monitor-show-watch-wait')
        self.assertFalse(c['pass'])

    def test_arbitrary_stream_output_does_not_prove_replay_live(self):
        c = self.semantic_check('streams-errors', [{'frames': [{'raw':'error output'}], 'closed':True}], 'live-frames')
        self.assertFalse(c['pass'])

    def test_two_identical_pages_do_not_prove_full_short_scan(self):
        page = {'method':'GET','path':'/v1/events/page?limit=1','status':200,'body':{'rows':[{'hrcSeq':1}]}}
        c = self.semantic_check('finite-store', [page,page], 'full-and-short-pages')
        self.assertFalse(c['pass'])

    def test_mutation_selector_outside_scratch_scope_is_refused(self):
        spec = importlib.util.spec_from_file_location('checker', RUNNER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        profile = {'scopePrefix':'agent:tabularasa:project:hrc-runtime:task:p0-test'}
        with self.assertRaises(ValueError):
            module.admit_mutation(profile, 'POST', '/v1/submissions/invoke',
                {'target':'agent:cody:project:hrc-runtime:primary','body':'do something'}, set(), set())

    def test_cli_refusal_does_not_prove_hrc_unavailability(self):
        c = self.semantic_check('wrkq', [{'kind':'authority-unavailable','exit':1,
            'stderr':'connect: connection refused'}], 'HRC-unavailable-authority')
        self.assertFalse(c['pass'])

    def test_monitor_zero_exit_without_matched_result_fails(self):
        rows = [{'argv':['hrc','monitor',v], 'exit':0} for v in ('show','watch','wait')]
        c = self.semantic_check('direct-cli-sdk', rows, 'monitor-show-watch-wait')
        self.assertFalse(c['pass'])

    def test_explicit_identity_mapping_preserves_effect_identity(self):
        def structured(d):
            d['effects'] = [{'key':'inv-'+v+':turn-'+v, 'identity':'turn-'+v,
                'invocationId':'inv-'+v,'source':'lifecycle','count':1} for v in ('a','b')]
        a=self.evidence('baseline', structured)
        def renamed(d):
            structured(d)
            mapping={v:'candidate-'+v for v in ('turn-a','turn-b','inv-a','inv-b','rt-a','scope-a')}
            for e in d['events']+d['effects']:
                for k in ('identity','invocationId','runtimeId','scopeRef'):
                    if k in e: e[k]=mapping.get(e[k],e[k])
                if 'key' in e: e['key']=e['invocationId']+':'+e['identity']
            d['normalization']={'fields':['identity','invocationId','runtimeId','scopeRef'],
                'identities':{v:k for k,v in mapping.items()}}
        b=self.evidence('candidate',renamed)
        p=self.command('compare','--baseline',a,'--candidate',b,'--out',self.root/'result')
        self.assertEqual(p.returncode,0,p.stdout+p.stderr)

    def test_second_db_owner_is_not_bun_alone(self):
        c=self.semantic_check('identity-isolation',[{'kind':'owner-observation','ownerPid':123,
            'scratchPids':[123],'rustOwners':[],'dbPids':[123,456]}],'Bun-alone')
        self.assertFalse(c['pass'])

    def test_prepared_generation_cannot_escape_scratch_agent_root(self):
        c=self.semantic_check('attach-restart-resume-terminate',[{'kind':'preparation',
            'runtimeId':'rt-test','admittedRoots':{'scratchRoot':'/tmp/hrcp0-test','agentRoot':'/tmp/hrcp0-test/agents/tabularasa','projectRoot':'/tmp/hrcp0-test/project'},
            'rows':[{'runtime_id':'rt-test','generation':2,'preparation_json':json.dumps({
                'intent':{'placement':{'agentRoot':'/Users/lherron/praesidium/var/agents/tabularasa'}}})}]}],
            'effective-preparation-roots')
        self.assertFalse(c['pass'])

    def test_full_parity_cannot_erase_inventory_obligations(self):
        p=self.compare(lambda d:d.__setitem__('claim','full-parity'))
        report=json.loads(p.stdout)
        c=next(c for c in report['checks'] if c['id']=='coverage:full-source-obligations')
        self.assertFalse(c['pass'])

    def test_ndjson_keepalive_blank_line_preserves_valid_replay_live(self):
        frames=[{'type':'ready','ledgerIncarnationId':'real-shape','replayHeadHrcSeq':1},
            {'type':'event','ledgerIncarnationId':'real-shape','event':{'hrcSeq':1,'eventKind':'turn.message'}},
            {'type':'event','ledgerIncarnationId':'real-shape','event':{'hrcSeq':2,'eventKind':'turn.completed'}}]
        stream={'frames':[{'raw':json.dumps(f)+'\n'} for f in frames]+[{'raw':'\n'}],
            'closed':True,'errors':[],'closeDurationMs':10}
        c=self.semantic_check('streams-errors',[stream],'live-frames')
        self.assertTrue(c['pass'])

    def test_actual_server_lifecycle_source_commit_shape(self):
        commit='68b13e11031542c83a941881848b1fde30c57cd2'
        observation={'kind':'hrc-authority-unavailable','events':[{'eventKind':'server.started',
            'payload_json':json.dumps({'release':'release-20261023083200324-77043','sourceCommit':commit})}]}
        c=self.semantic_check('wrkq',[observation],'HRC-unavailable-source-tuple',
            {'release':{'releaseId':'release-20261023083200324-77043','hrcBuild':{'sourceCommit':commit}}})
        self.assertTrue(c['pass'])
        observation['events'][0]['payload_json']=json.dumps({'release':'release-20261023083200324-77043','sourceCommit':'wrong'})
        c=self.semantic_check('wrkq',[observation],'HRC-unavailable-source-tuple',
            {'release':{'releaseId':'release-20261023083200324-77043','hrcBuild':{'sourceCommit':commit}}})
        self.assertFalse(c['pass'])
        observation['events'][0]['payload_json']=json.dumps({'release':'wrong-release','sourceCommit':commit})
        c=self.semantic_check('wrkq',[observation],'HRC-unavailable-source-tuple',
            {'release':{'releaseId':'release-20261023083200324-77043','hrcBuild':{'sourceCommit':commit}}})
        self.assertFalse(c['pass'])

    def test_missing_explicit_profile_refused(self):
        p = self.command('run', '--out', self.root / 'result')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('profile', p.stderr.lower() + p.stdout.lower())

    def test_production_profile_refused_before_mutation(self):
        profile = self.root / 'profile.json'
        profile.write_text(json.dumps({'schema': 1, 'claim': 'bun-compatibility',
            'publicSocket': '/Users/lherron/praesidium/var/run/hrc/hrc.sock',
            'dbPath': '/Users/lherron/praesidium/var/state/hrc/state.sqlite'}))
        p = self.command('run', '--profile', profile, '--suite', 'p0-bun', '--out', self.root / 'result')
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
        self.assertIn('isolation', p.stdout.lower() + p.stderr.lower())


    def coverage(self, overrides, reasons, rules=()):
        spec = importlib.util.spec_from_file_location('checker', RUNNER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        observed = {'sourceCommit': 'x', 'items': [{'id': 'store-op:a', 'kind': 'store-op', 'path': 'a.ts'}]}
        definitions = {'cases': {}, 'coverageOverrides': overrides, 'coverageReasons': reasons,
                       'coverageRules': list(rules)}
        return module, module.coverage_report(observed, definitions)

    def test_unsupported_requires_an_allowlisted_reason(self):
        module, report = self.coverage({'store-op:a': 'UNSUPPORTED'}, {})
        self.assertIsNone(report['items'][0]['target'])
        self.assertEqual(report['counts']['UNSUPPORTED'], 0)
        _, report = self.coverage({'store-op:a': 'UNSUPPORTED'}, {'store-op:a': 'not needed'})
        self.assertIsNone(report['items'][0]['target'])
        reason = sorted(module.UNSUPPORTED_REASONS)[0]
        _, report = self.coverage({'store-op:a': 'UNSUPPORTED'}, {'store-op:a': reason})
        self.assertEqual(report['items'][0]['target'], 'UNSUPPORTED')
        self.assertEqual(report['counts']['UNSUPPORTED'], 1)
        _, report = self.coverage({}, {}, [{'idPrefix': 'store-op:', 'target': 'UNSUPPORTED', 'reason': reason}])
        self.assertEqual(report['items'][0]['target'], 'UNSUPPORTED')
        _, report = self.coverage({}, {}, [{'idPrefix': 'store-op:', 'target': 'UNSUPPORTED', 'reason': reason + ' '}])
        self.assertIsNone(report['items'][0]['target'])


if __name__ == '__main__':
    unittest.main()
