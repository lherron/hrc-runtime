"""Black-box controls for the N5 cases: a qualifying driver tree passes, and
each way a driver tree can launder a result fails through the real runner."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
RUNNER = ROOT / 'conformance/hrc-parity/run.py'
RULED = 'Bun truncates server status --json above 64 KiB; Rust emits complete JSON'
DRIVERS = ('server_owner', 'server_start')


class N5Cases(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'suites'
        self.addCleanup(self.temp.cleanup)

    def driver(self, name, cases, summary=None, fail=None, owned=()):
        d = self.root / name
        d.mkdir(parents=True)
        result = {'cases': cases, 'pass': sum(c.get('pass') is True for c in cases) if summary is None else summary}
        if fail is not None:
            result['fail'] = fail
        (d / 'results.json').write_text(json.dumps(result))
        (d / 'production-metrics-isolation.json').write_text(
            json.dumps({'spawnedPids': [1], 'growth': [], 'ownedRecords': list(owned), 'pass': not owned}))

    def owner_tree(self, **overrides):
        for name in DRIVERS:
            self.driver(name, **overrides.get(name, {'cases': [{'case': 'a', 'pass': True}], 'fail': 0}))

    def run_case(self, suite):
        out = Path(self.temp.name) / 'out'
        result = subprocess.run([sys.executable, str(RUNNER), 'compare', '--suite', suite,
                                 '--candidate', str(self.root), '--out', str(out)],
                                text=True, capture_output=True)
        report = json.loads((out / 'summary.json').read_text())
        self.assertEqual(report['exitCode'], result.returncode)
        return report

    def assertFails(self, report, check_id):
        self.assertNotEqual(report['exitCode'], 0)
        self.assertIn(check_id, [c['id'] for c in report['checks'] if not c['pass']])

    def test_qualifying_tree_passes(self):
        self.owner_tree()
        self.assertEqual(self.run_case('n5-server-owner')['exitCode'], 0)

    def test_missing_driver_is_a_gap(self):
        self.driver('server_owner', [{'case': 'a', 'pass': True}], fail=0)
        report = self.run_case('n5-server-owner')
        self.assertEqual(report['exitCode'], 2)
        self.assertFails(report, 'server_start:results')

    def test_failing_case_fails(self):
        self.owner_tree(server_start={'cases': [{'case': 'a', 'pass': True}, {'case': 'b', 'pass': False}], 'summary': 1, 'fail': 0})
        self.assertFails(self.run_case('n5-server-owner'), 'server_start:cases')

    def test_empty_cases_do_not_pass(self):
        self.owner_tree(server_start={'cases': [], 'summary': 0, 'fail': 0})
        self.assertFails(self.run_case('n5-server-owner'), 'server_start:nonvacuous')

    def test_summary_that_disagrees_with_cases_fails(self):
        self.owner_tree(server_start={'cases': [{'case': 'a', 'pass': True}], 'summary': 2, 'fail': 0})
        self.assertFails(self.run_case('n5-server-owner'), 'server_start:summary')

    def test_unruled_unsupported_fails_and_ruled_passes(self):
        self.owner_tree(server_start={'cases': [{'case': 'a', 'pass': True},
                                                {'case': 'b', 'status': 'UNSUPPORTED', 'reason': 'Rust differs.'}], 'fail': 0})
        self.assertFails(self.run_case('n5-server-owner'), 'server_start:cases')
        (self.root / 'server_start/results.json').write_text(json.dumps({'cases': [
            {'case': 'a', 'pass': True}, {'case': 'b', 'status': 'UNSUPPORTED', 'reason': RULED}], 'pass': 1, 'fail': 0}))
        self.assertEqual(self.run_case('n5-server-owner')['exitCode'], 0)

    def test_owned_production_metrics_fail(self):
        self.owner_tree(server_start={'cases': [{'case': 'a', 'pass': True}], 'fail': 0, 'owned': [{'pid': 1}]})
        self.assertFails(self.run_case('n5-server-owner'), 'server_start:isolation')

    def test_cli_line_without_a_driver_run_is_a_gap(self):
        self.driver('differential', [{'case': 'help', 'pass': True}], fail=0)
        result = json.loads((self.root / 'differential/results.json').read_text())
        result['qualification'] = [{'line': 'cli:hrc status', 'suite': 'status.py'}]
        (self.root / 'differential/results.json').write_text(json.dumps(result))
        self.assertFails(self.run_case('n5-cli'), 'line:cli:hrc status')
        self.driver('status', [{'case': 'a', 'pass': True}], fail=0)
        self.assertEqual(self.run_case('n5-cli')['exitCode'], 0)

    def test_cli_with_no_qualification_lines_fails(self):
        self.driver('differential', [{'case': 'help', 'pass': True}], fail=0)
        self.assertFails(self.run_case('n5-cli'), 'qualification:nonempty')


if __name__ == '__main__':
    unittest.main()
