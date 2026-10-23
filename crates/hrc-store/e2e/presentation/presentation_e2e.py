#!/usr/bin/env python3
"""Stored presentation source-native qualification, actual unchanged Bun oracle."""
import argparse, copy, hashlib, importlib.util, json, os, shutil, sqlite3, subprocess, tempfile
from pathlib import Path
from checks import same, discriminate, controls
ROOT=Path(__file__).resolve().parents[4]
HERE=Path(__file__).resolve().parent

def write(p,value):
    p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value,indent=2,ensure_ascii=True)+'\n')
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def logical(p):
    with sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True) as db:
        db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
        return list(db.iterdump())
def backup(src,dst):
    with sqlite3.connect('file:'+str(src)+'?mode=ro',uri=True) as a:
        with sqlite3.connect(dst) as b:a.backup(b)
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--identity',required=True);ap.add_argument('--artifacts',required=True);args=ap.parse_args()
    pin=Path(args.identity).resolve();identity=json.loads(pin.read_text());binary=identity['native']['path'];release=identity['bun']['release']
    assert digest(binary)==identity['native']['sha256']
    out=Path(args.artifacts).resolve();out.mkdir(parents=True,exist_ok=False)
    recorder_path=ROOT/'conformance/hrc-parity/native_capture.py'
    spec=importlib.util.spec_from_file_location('presentation_capture',recorder_path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    sources=[Path(__file__).resolve(),HERE/'checks.py',HERE/'oracle.ts',HERE/'README.md',ROOT/'crates/hrc-store/src/presentation.rs',ROOT/'crates/hrc-domain/src/store/presentation.rs',ROOT/'crates/hrc-store/src/qualification_presentation.rs',recorder_path]
    hashes={str(p.relative_to(ROOT)):digest(p) for p in sources}
    write(out/'sources-before.json',hashes)
    for source in sources:
        dest=out/'source'/source.relative_to(ROOT);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,dest)
    write(out/'identity-input.json',identity);identity=copy.deepcopy(identity);identity['sources']={'presentation':digest(Path(__file__))};identity['controls']={k:v for k,v in hashes.items() if k!='crates/hrc-store/e2e/presentation/presentation_e2e.py'};write(out/'identity.json',identity);(out/'build').mkdir()
    for source in pin.parent.glob('*.json'):shutil.copyfile(source,out/'build'/source.name)
    for name in ['compiler-dependencies-before.d','compiler-dependencies-after.d']:
        source=pin.parent/name
        assert source.is_file(),('missing frozen compiler dependencies',str(source))
        shutil.copyfile(source,out/'build'/name)
    if (pin.parent/'source').exists():shutil.copytree(pin.parent/'source',out/'build/source')
    shutil.copyfile(Path(release)/'praesidium-release.json',out/'bun-release.json')
    summary={'scope':'SOURCE_NATIVE_PRESENTATION_ONLY','complete':False,'gaps':['Parent evidence-family reconstruction and independent grade','Canonical installed-native acceptance and full P1 remain parent scope']}
    write(out/'summary.json',summary);anchors=[]
    try:
        with module.ProcessRecorder(out,'presentation',identity) as recorder:
            with tempfile.TemporaryDirectory(prefix='hrcp1-presentation-',dir='/tmp') as tmp:
                root=Path(tmp);db=root/'state.sqlite'
                def command(label,argv,passive=True,target=db):
                    before=logical(target) if target.exists() else None;write(out/(label+'-before.json'),before)
                    p=subprocess.run(argv,text=True,capture_output=True,timeout=60,env={**os.environ,'HRC_SOCKET_PATH':str(root/'absent.sock')})
                    receipt={'argv':argv,'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr,'capture':recorder.legs[-1].get('receipt') if recorder.legs else None}
                    write(out/(label+'.json'),receipt)
                    after=logical(target) if target.exists() else None;write(out/(label+'-after.json'),after)
                    assert p.returncode==0,(label,p.stderr,p.stdout)
                    if passive:same(before,after,label+'/passivity')
                    raw=json.loads(p.stdout)
                    # Explicit producer shapes: native is direct, Bun observe/chunks wraps result.
                    if argv[0]=='bun' and argv[-1] in ('observe','chunks'):
                        assert set(raw)=={'result'},(label,'Bun wrapper missing',raw.keys())
                        value=raw['result']
                    else:value=raw
                    if argv[0]==binary:
                        expected={'inputs','value'} if argv[1]=='presentation-chunks-contract' else {'full','empty','runtimeOnly','alias','missing','projected','invalid'}
                        assert set(raw)==expected,(label,'native direct shape changed',raw.keys())
                    return value,before,after
                bun=lambda mode,where=root:['bun',str(HERE/'oracle.ts'),release,str(where),mode]
                native=lambda command_name:[binary,command_name,'--db',str(db)]
                command('seed',bun('seed'),False);backup(db,out/'fixture.sqlite')
                initial=None
                for phase in ['initial','context-null','hosting-malformed','activity-recency','metadata-cleared','latest-absent']:
                    if phase!='initial':
                        with sqlite3.connect(db) as writer:
                            if phase=='context-null':
                                writer.execute("UPDATE runtimes SET runtime_state_json=json_set(runtime_state_json,'$.contextReading',json('null')) WHERE runtime_id='present-quiet'")
                            elif phase=='hosting-malformed':
                                writer.execute("UPDATE runtimes SET runtime_state_json=json_set(runtime_state_json,'$.broker.presentation.tuiWindow',json('{}')) WHERE runtime_id='present-quiet'")
                            elif phase=='activity-recency':
                                writer.execute("UPDATE runtimes SET last_activity_at='2026-10-22T00:00:00.000Z' WHERE runtime_id='present-outside'")
                            elif phase=='metadata-cleared':
                                writer.execute("DELETE FROM session_metadata WHERE scope_ref='agent:present:project:hrc-runtime:task:quiet'")
                            elif phase=='latest-absent':
                                writer.execute("DELETE FROM hrc_events WHERE host_session_id='present-quiet-1' AND generation=1")
                    b,_,_=command(phase+'-bun',bun('observe'));n,_,_=command(phase+'-native',native('presentation-contract'));same(b,n,phase)
                    if phase=='initial':
                        discriminate(n);initial=n
                        chunk_b,_,_=command('chunks-bun',bun('chunks'));chunk_n,_,_=command('chunks-native',native('presentation-chunks-contract'))
                        same(chunk_b,chunk_n,'chunks');same(n['full']['value'],chunk_n['value'],'bounded-calls')
                        assert len(chunk_n['inputs'])==4
                        assert all(len(x['sessionRefs'])+len(x['runtimeIds'])<=128 for x in chunk_n['inputs'])
                        write(out/'semantic-negative-controls.json',controls(n))
                    elif phase=='context-null':assert next(x for x in n['projected'] if x['runtimeId']=='present-quiet')['contextReading'] is None
                    elif phase=='hosting-malformed':assert 'tmux' not in next(x for x in n['projected'] if x['runtimeId']=='present-quiet')
                    elif phase=='activity-recency':assert 'present-outside-1' in [x['hostSessionId'] for x in n['full']['value']['sessions']]
                    elif phase=='metadata-cleared':assert 'title' not in next(x for x in n['projected'] if x['runtimeId']=='present-quiet')
                    elif phase=='latest-absent':assert 'present-quiet-1' not in [x['hostSessionId'] for x in n['full']['value']['events']]
                    anchors.append({'id':'presentation/'+phase,'input':'source/crates/hrc-store/e2e/presentation/oracle.ts','bun':{'receipt':phase+'-bun.json','stdoutJsonPointer':'/result'},'native':{'receipt':phase+'-native.json','stdoutJsonPointer':''},'snapshots':[phase+'-'+side+suffix+'.json' for side in ['bun','native'] for suffix in ['-before','-after']]})
                # The identical logical-state checker must detect a real canonical updateActivity.
                _,before,after=command('updateActivity-control',bun('mutate'),False)
                try:same(before,after,'mutation-control')
                except AssertionError as e:write(out/'mutation-detected.json',{'error':repr(e)})
                else:raise AssertionError('real updateActivity escaped passivity checker')
                backup(db,out/'final.sqlite');write(out/'assertion-anchors.json',anchors)
                summary.update(complete=True,observations=anchors,negativeControls=11,boundedInputs={'receipt':'chunks-native.json','stdoutJsonPointer':'/inputs'})
    finally:
        final_hashes={str(p.relative_to(ROOT)):digest(p) for p in sources};write(out/'sources-after.json',final_hashes)
        identity['legs']=recorder.legs if 'recorder' in locals() else [];write(out/'identity.json',identity)
        summary['sourceUnchanged']=hashes==final_hashes;summary['binaryUnchanged']=digest(binary)==identity['native']['sha256'];write(out/'summary.json',summary)
        manifest={str(p.relative_to(out)):digest(p) for p in out.rglob('*') if p.is_file() and p.name!='SHA256SUMS'}
        (out/'SHA256SUMS').write_text(''.join(f'{sha}  {name}\n' for name,sha in sorted(manifest.items())))
    assert summary['sourceUnchanged'] and summary['binaryUnchanged']
if __name__=='__main__':main()
