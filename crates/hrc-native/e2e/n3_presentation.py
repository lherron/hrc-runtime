#!/usr/bin/env python3
"""Compare the two real kernel presentation routes on one real-born seat.

Failure modes: all-store enumeration for keyed updates, duplicate seat rows,
missing identity/title/context/surfaces, unavailable runtimes leaking into the
live projection, and malformed batch keys silently selecting the full store.
"""
import argparse,json,sqlite3,subprocess
from pathlib import Path
from n3_scratch import Scratch

def exercise(s,scope,runtime):
    path='/v1/presentation/seats/read';out={}
    out['runtimes']=s.http('GET','/v1/presentation/runtimes')
    for name,body in [('empty',{'sessionRefs':[],'runtimeIds':[]}),('session',{'sessionRefs':[scope+'/lane:main'],'runtimeIds':[]}),('runtime',{'sessionRefs':[],'runtimeIds':[runtime]}),('duplicate',{'sessionRefs':[scope+'/lane:main',scope+'/lane:main'],'runtimeIds':[runtime,runtime]}),('missing',{'sessionRefs':['agent:tabularasa:project:n3-t11839:task:missing/lane:main'],'runtimeIds':['missing']}),('fields',{}),('null',None),('nonarray',{'sessionRefs':'x','runtimeIds':[]}),('empty-key',{'sessionRefs':[''],'runtimeIds':[]}),('bad-key',{'sessionRefs':[],'runtimeIds':[1]}),('malformed-ref',{'sessionRefs':['invalid'],'runtimeIds':[]})]:out[name]=s.http('POST',path,body)
    return out

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();bun=s.up('bun','presentation')
        scope='agent:tabularasa:project:n3-t11839:task:presentation'
        start=s.command('birth',['hrc','start',scope,'--project-id',s.project_id,'--project-root',s.project,'--cwd',s.project,'--json','-p','Reply with exactly the word OK and nothing else. No tools.'])
        runtime=start['runtime']['runtimeId'];s.wait_completed(start['runtime']['runId'])
        # Seed continuity metadata through Bun's repository while no owner is
        # running; PATCH's federation-home discovery is outside this gate.
        s.down(bun)
        module=s.release/'packages/hrc-store-sqlite/src/database.ts'
        script='import {openHrcDatabase} from '+json.dumps(str(module))+';const db=openHrcDatabase(process.argv[1]);db.sessionMetadata.write({scopeRef:process.argv[2],laneRef:"main",source:"api",set:{title:"N3 presentation","appearance.color":"#aabbcc"},updatedBy:"agent:cody"});const r=db.runtimes.getByRuntimeId(process.argv[3]);for(const [id,at] of [["z","2026-01-02T00:00:00.000Z"],["a","2026-01-01T00:00:00.000Z"]])db.surfaceBindings.bind({surfaceKind:"ghostty",surfaceId:"n3-"+id,clientTty:"/dev/n3-"+id,hostSessionId:r.hostSessionId,runtimeId:r.runtimeId,generation:r.generation,boundAt:at});db.close()'
        s.command('metadata-fixture',['bun','-e',script,s.db_path,scope,runtime])
        bun=s.up('bun','presentation-metadata')
        expected=exercise(s,scope,runtime);snapshot=s.root/'history.sqlite'
        with sqlite3.connect(s.db_path) as source,sqlite3.connect(snapshot) as target:source.backup(target)
        s.down(bun)
        with sqlite3.connect(snapshot) as source,sqlite3.connect(s.db_path) as target:source.backup(target)
        s.up('native','presentation');actual=exercise(s,scope,runtime)
        for side,v in [('bun',expected),('native',actual)]:
            directory=a.artifacts/side;directory.mkdir(exist_ok=True);(directory/'presentation.json').write_text(json.dumps(v,indent=2)+'\n')
        s.assert_no_duplicate_turn_messages()
        cases={k:{'bun':v,'native':actual[k],'pass':v==actual[k]} for k,v in expected.items()};(a.artifacts/'presentation-compares.json').write_text(json.dumps(cases,indent=2)+'\n')
        runner=Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'
        result=subprocess.run(['python3',str(runner),'compare','--suite','n3-presentation','--baseline',str(a.artifacts/'bun'),'--candidate',str(a.artifacts/'native'),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
        (a.artifacts/'compare.stdout').write_text(result.stdout);(a.artifacts/'compare.stderr').write_text(result.stderr);assert result.returncode==0,(result.stdout,result.stderr)
        print(json.dumps({'pass':True,'compared':len(cases),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
