#!/usr/bin/env python3
"""Capture actual external E2E subprocess boundaries without changing their argv."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def text(value):
    if value is None:
        return ''
    return value.decode('utf-8', 'surrogateescape') if isinstance(value, bytes) else value


class PipeCapture:
    def __init__(self, pipe):
        self.pipe = pipe
        self.parts = []

    def __getattr__(self, key):
        return getattr(self.pipe, key)

    def write(self, value):
        result=self.pipe.write(value)
        self.parts.append(value if result is None else value[:result])
        return result

    def read(self, *args):
        value = self.pipe.read(*args)
        self.parts.append(value)
        return value

    def readline(self, *args):
        value = self.pipe.readline(*args)
        self.parts.append(value)
        return value

    def readlines(self, *args):
        values = self.pipe.readlines(*args)
        self.parts.extend(values)
        return values

    def __iter__(self):
        return self

    def __next__(self):
        value = self.readline()
        if not value:
            raise StopIteration
        return value

    def captured(self):
        return ''.join(text(value) for value in self.parts)


class ProcessRecorder:
    """One Python test process; caller owns the frozen binary and expected identity."""
    def __init__(self, root, family, identity):
        self.root, self.family, self.identity = Path(root), family, identity
        self.processes = []
        self.legs = []
        self.original = subprocess.Popen

    def native(self):
        path = str(Path(self.identity['native']['path']).resolve())
        return {'path': path, 'sha256': digest(path)}

    def __enter__(self):
        observed = self.native()
        if observed != {key: self.identity['native'][key] for key in ('path', 'sha256')}:
            raise ValueError('native identity differs before any subprocess launch')
        recorder = self
        original = self.original

        class ObservedProcess(original):
            def __init__(self, args, *positional, **kwargs):
                self.capture_done = False
                self.capture_started = time.time()
                self.capture_native_before = recorder.native()
                if self.capture_native_before != {key:recorder.identity['native'][key] for key in ('path','sha256')}:
                    raise ValueError('native binary changed before subprocess launch')
                self.capture_input = None
                self.capture_command = [str(value) for value in args] if isinstance(args, (tuple, list)) else args
                self.capture_environment = {
                    key: value for key, value in (kwargs.get('env') or os.environ).items()
                    if key in ('PATH', 'HRC_SOCKET_PATH', 'HRC_DB_PATH', 'HRC_STATE_DIR')
                }
                self.capture_cwd = str(kwargs.get('cwd') or Path.cwd())
                self.capture_stdout = None
                self.capture_stderr = None
                self.capture_complete = False
                super().__init__(args, *positional, **kwargs)
                self.capture_input_pipe=PipeCapture(self.stdin) if self.stdin is not None else None
                if self.capture_input_pipe is not None:self.stdin=self.capture_input_pipe
                if self.stdout is not None:
                    self.stdout = PipeCapture(self.stdout)
                if self.stderr is not None:
                    self.stderr = PipeCapture(self.stderr)
                recorder.processes.append(self)

            def communicate(self, *args, **kwargs):
                out_before = self.stdout.captured() if isinstance(self.stdout, PipeCapture) else ''
                err_before = self.stderr.captured() if isinstance(self.stderr, PipeCapture) else ''
                input_value=args[0] if args else kwargs.get('input')
                prefix=self.capture_input_pipe.captured() if self.capture_input_pipe is not None else ''
                if input_value is not None:self.capture_input=prefix+text(input_value)
                elif prefix:self.capture_input=prefix
                result = super().communicate(*args, **kwargs)
                self.capture_stdout = out_before + text(result[0])
                self.capture_stderr = err_before + text(result[1])
                self.capture_complete = True
                self.capture_record()
                return result

            def capture_record(self):
                if self.capture_done or self.poll() is None:
                    return
                self.capture_done = True
                index = len(recorder.legs)
                relative = 'commands/' + str(index).zfill(5) + '.json'
                after = recorder.native()
                output = self.capture_stdout
                error = self.capture_stderr
                if output is None:
                    output = self.stdout.captured() if isinstance(self.stdout, PipeCapture) else ''
                if error is None:
                    error = self.stderr.captured() if isinstance(self.stderr, PipeCapture) else ''
                command = self.capture_command
                program = command[0] if isinstance(command, list) and command else command
                executable = shutil.which(program, path=self.capture_environment.get('PATH')) if isinstance(program, str) else None
                if executable is None and isinstance(program, str) and Path(program).is_file():
                    executable = program
                input_bytes=None if self.capture_input is None else self.capture_input.encode('utf-8','surrogatepass')
                receipt = {
                    'command': command, 'argv': command, 'pid': self.pid, 'exit': self.returncode,
                    'startedAt': self.capture_started, 'completedAt': time.time(),
                    'stdout': output, 'stderr': error, 'captureComplete': self.capture_complete,
                    'stdin': {'present':input_bytes is not None,'bytes':len(input_bytes or b''),'sha256':hashlib.sha256(input_bytes or b'').hexdigest(),'literalNewlineCount':(input_bytes or b'').count(b'\n')},
                    'cwd': self.capture_cwd, 'environment': self.capture_environment,
                    'nativeBefore': self.capture_native_before, 'nativeAfter': after,
                    'bun': recorder.identity['bun'],
                    'executable': {'path': str(Path(executable).resolve()), 'sha256': digest(executable)} if executable else None,
                }
                write(recorder.root / relative, receipt)
                recorder.legs.append({
                    key: receipt[key] for key in ('command', 'startedAt', 'completedAt', 'nativeBefore', 'nativeAfter', 'bun')
                } | {'family': recorder.family, 'receipt': relative})

        subprocess.Popen = ObservedProcess
        return self

    def __exit__(self, kind, value, traceback):
        try:
            for process in self.processes:
                process.capture_record()
            incomplete = [process.pid for process in self.processes if not process.capture_done]
            write(self.root / 'capture.json', {
                'identity': self.identity, 'legs': self.legs, 'incompletePids': incomplete,
                'complete': not incomplete and kind is None,
            })
        finally:
            subprocess.Popen = self.original


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--script', required=True)
    parser.add_argument('--artifacts', required=True)
    parser.add_argument('--identity', required=True)
    args = parser.parse_args()
    script = Path(args.script).resolve()
    if script.parent != ROOT / 'crates/hrc-store/e2e' or not script.name.endswith('_e2e.py'):
        raise ValueError('only a repository-owned fixed external E2E entry is admitted')
    identity = json.loads(Path(args.identity).read_text())
    output = Path(args.artifacts).resolve()
    output.mkdir(parents=True, exist_ok=False)
    command = [str(script), '--binary', identity['native']['path'], '--artifacts', str(output)]
    if script.stem != 'json_values_e2e':
        command.extend(['--release', identity['bun']['release']])
    source_paths=sorted([path for path in script.parent.iterdir() if path.is_file() and path.suffix in ('.py','.ts')]+list((script.parent/'fixtures').glob('*'))+[Path(__file__).resolve()])
    sources_before={str(path.relative_to(ROOT)):digest(path)for path in source_paths if path.is_file()}
    write(output / 'sources-before.json',sources_before)
    for path in source_paths:
        if path.is_file():
            target=output/'source'/path.relative_to(ROOT);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
    write(output / 'entry.json', {'command': [sys.executable, *command], 'scriptSha256': digest(script), 'identity': identity})
    sys.argv = command
    try:
        with ProcessRecorder(output, script.stem, identity):
            runpy.run_path(str(script), run_name='__main__')
    finally:
        sources_after={str(path.relative_to(ROOT)):digest(path)for path in source_paths if path.is_file()}
        write(output/'sources-after.json',sources_after)
    if sources_before!=sources_after:raise ValueError('external E2E source changed during family')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
