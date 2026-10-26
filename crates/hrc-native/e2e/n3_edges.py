#!/usr/bin/env python3
"""Real HTTP subscriber-name identity and combined-error precedence edges."""
import argparse,json,sqlite3,subprocess
from pathlib import Path
from n3_scratch import Scratch

def exercise(s):
    out={};path='/v1/server/subscribers'
    for label,body in [('route-first',{'name':'cycle','route':'events'}),('route-second',{'name':'cycle','route':'broker-events'}),('route-third',{'name':'cycle','route':'events'}),('utf16-boundary',{'name':'😀'*64}),('utf16-overflow',{'name':'😀'*65})]:out[label]=s.http('POST',path,body)
    out['cycle-created-new']=out['route-first'][1]['subscriberId']!=out['route-third'][1]['subscriberId']
    for query in ('fromSeq=0&generation=-1','fromSeq=0&receipt=wrong','receipt=wrong&generation=-1','fromSeq=1&generation=-1'):out[query]=s.http('GET','/v1/events?'+query)
    return out

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();bun=s.up('bun','edges');expected=exercise(s)
        snapshot=s.root/'before-edges.sqlite'
        with sqlite3.connect(s.db_path) as source,sqlite3.connect(snapshot) as target:source.backup(target)
        s.down(bun)
        with sqlite3.connect(snapshot) as source,sqlite3.connect(s.db_path) as target:source.backup(target)
        s.up('native','edges');actual=exercise(s)
        for side,v in [('bun',expected),('native',actual)]:
            directory=a.artifacts/side;directory.mkdir(exist_ok=True);(directory/'edges.json').write_text(json.dumps(v,indent=2)+'\n')
        runner=Path(__file__).resolve().parents[3]/'conformance/hrc-parity/run.py'
        result=subprocess.run(['python3',str(runner),'compare','--suite','n3-edges','--baseline',str(a.artifacts/'bun'),'--candidate',str(a.artifacts/'native'),'--out',str(a.artifacts/'compare')],capture_output=True,text=True)
        (a.artifacts/'compare.stdout').write_text(result.stdout);(a.artifacts/'compare.stderr').write_text(result.stderr)
        assert result.returncode==0,(result.stdout,result.stderr)
        print(json.dumps({'pass':True,'cases':len(expected),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
