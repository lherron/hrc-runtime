#!/usr/bin/env python3
"""CLI fixture adapter: add turn identity to the existing substrate broker.

The original broker is copied unchanged beside this adapter. Its process,
lease and event handling remain the substrate helper's; only protocol identity
and the probe of the currently emitted turn are supplied here.
"""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('substrate_broker', Path(__file__).with_name('base_broker.py'))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
original_emit, original_handle = broker.emit, broker.handle
current = {'input': None, 'turn': None}


def emit(kind, payload, input_id=None, turn_id=None):
    identity = turn_id or ('cli-turn-' + input_id if input_id else None)
    with broker.lock:
        if kind == 'turn.started':
            current.update(input=input_id, turn=identity)
        result = original_emit(kind, payload, input_id, identity)
        if kind in ('turn.completed', 'turn.interrupted', 'turn.failed'):
            current.update(input=None, turn=None)
        return result


def handle(conn, method, params):
    if method == 'seat.probe':
        with broker.lock:
            seat = {'state': 'turn-active', 'turnId': current['turn']} if current['turn'] else {'state': 'idle'}
            return {'invocationId': broker.state['invocation'], 'seat': seat}
    if method == 'turn.manifest':
        with broker.lock:
            return {'turnId': params.get('turnId'), 'submissionIds': [current['input']] if current['turn'] and params.get('turnId') == current['turn'] else []}
    return original_handle(conn, method, params)


broker.emit, broker.handle = emit, handle
broker.main()
