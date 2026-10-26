"""Discriminators for the additional wire-order gate; values keep their own gate."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from key_order import differences, response_body, load_source, compare_records, cli_orders


class KeyOrderControls(unittest.TestCase):
    def test_top_level_and_nested_and_positional_arrays(self):
        self.assertTrue(differences({'hostSessionId': 'a', 'scopeRef': 'b'},
                                    {'scopeRef': 'b', 'hostSessionId': 'a'}))
        self.assertTrue(differences({'rows': [{'z': 1, 'a': 2}]},
                                    {'rows': [{'a': 2, 'z': 1}]}))
        self.assertTrue(differences([{'z': 1}, {'a': 2}], [{'a': 2}, {'z': 1}]))

    def test_values_are_left_to_the_existing_value_gate(self):
        self.assertEqual(differences({'id': 'minted-a', 'status': 'ready'},
                                     {'id': 'minted-b', 'status': 'failed'}), [])

    def test_sorted_summary_cannot_launder_raw_order(self):
        a = {'raw': '{"z":1,"nested":{"b":2,"a":3}}', 'body': {'z': 1, 'nested': {'b': 2, 'a': 3}}}
        b = {'raw': '{"nested":{"a":3,"b":2},"z":1}', 'body': a['body']}
        a, b = [json.loads(json.dumps(v, sort_keys=True)) for v in (a, b)]
        self.assertTrue(differences(response_body(a), response_body(b)))

    def test_sorted_only_observation_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'observations.json'
            path.write_text(json.dumps([{'case': 'read', 'response': {'status': 200, 'body': {'z': 1, 'a': 2}}}], sort_keys=True))
            with self.assertRaises(ValueError):
                load_source(path)

    def test_missing_empty_and_duplicate_cases_fail(self):
        for a, b in (([], []), ([('one', '/', {})], []),
                     ([('one', '/', {}), ('one', '/', {})], [('one', '/', {})])):
            with self.assertRaises(ValueError):
                compare_records('n1-routes', a, b)

    def test_named_exclusion_is_reported_and_scoped(self):
        bun = {'invocations': [{'runId': 'r', 'context': {'turnId': 't', 'usedTokens': 1}}]}
        native = {'invocations': [{'runId': 'r', 'context': {'usedTokens': 1}}]}
        report = compare_records('n2-turns', [('inspect', 'POST /v1/runtimes/broker/inspect', bun)],
                                 [('inspect', 'POST /v1/runtimes/broker/inspect', native)])
        self.assertEqual(report['failedCases'], 0)
        self.assertEqual([e['object path'] for e in report['excluded']], ['$.invocations[0].context'])
        # Same shape elsewhere in the suite, or the same path in another suite, still fails.
        moved = {'invocations': [{'context': {'turnId': 't', 'usedTokens': 1}, 'runId': 'r'}]}
        self.assertEqual(compare_records('n2-turns', [('inspect', '/', bun)], [('inspect', '/', moved)])['failedCases'], 1)
        self.assertEqual(compare_records('n2-routes', [('inspect', '/', bun)], [('inspect', '/', native)])['failedCases'], 1)
        nearby = ({'invocations': [{'contextReading': {'b': 1, 'a': 2}}]}, {'invocations': [{'contextReading': {'a': 2, 'b': 1}}]})
        self.assertEqual(compare_records('n2-turns', [('x', '/', nearby[0])], [('x', '/', nearby[1])])['failedCases'], 1)

    def test_case_scoped_exclusion_covers_only_its_case(self):
        bun, native = {'runtimeId': 'r', 'source': 's'}, {'runtimeId': 'r', 'retainedEvidence': [], 'source': 's'}
        report = compare_records('n2-routes', [('broker-inspect:terminated', '/', bun)],
                                 [('broker-inspect:terminated', '/', native)])
        self.assertEqual((report['failedCases'], len(report['excluded'])), (0, 1))
        self.assertEqual(compare_records('n2-routes', [('broker-inspect:live', '/', bun)],
                                         [('broker-inspect:live', '/', native)])['failedCases'], 1)

    def test_cli_json_order_and_text(self):
        self.assertFalse(cli_orders({'stdout': '{"z":1,"a":2}', 'stderr': ''},
                                    {'stdout': '{"a":2,"z":1}', 'stderr': ''})['pass'])
        self.assertTrue(cli_orders({'stdout': 'text', 'stderr': ''},
                                   {'stdout': 'text', 'stderr': ''})['pass'])


if __name__ == '__main__':
    unittest.main()
