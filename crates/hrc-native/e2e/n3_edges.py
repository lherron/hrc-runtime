#!/usr/bin/env python3
"""Real HTTP subscriber-name identity and combined-error precedence edges."""
import argparse,json
from pathlib import Path
from n3_scratch import Scratch

def exercise(s):
    out={};path='/v1/server/subscribers'
    for label,body in [('route-first',{'name':'cycle','route':'events'}),('route-second',{'name':'cycle','route':'broker-events'}),('route-third',{'name':'cycle','route':'events'}),('utf16-boundary',{'name':'😀'*64}),('utf16-overflow',{'name':'😀'*65})]:out[label]=s.http('POST',path,body)
    out['cycle-created-new']=out['route-first'][1]['subscriberId']!=out['route-third'][1]['subscriberId']
    for query in ('fromSeq=0&generation=-1','fromSeq=0&receipt=wrong','receipt=wrong&generation=-1','fromSeq=1&generation=-1'):out[query]=s.http('GET','/v1/events?'+query)
    return out

def field(v):
    return ((v[1] or {}).get('error') or {}).get('detail',{}).get('field') if isinstance(v[1],dict) else None

def main():
    p=argparse.ArgumentParser()
    for k in ('binary','installed-release','aspd-socket','scratch-root','artifacts'):p.add_argument('--'+k,type=Path,required=True)
    a=p.parse_args();s=Scratch(a.scratch_root,a.installed_release,a.aspd_socket,a.binary,a.artifacts,project_id='n3-t11839')
    try:
        s.init_substrate();s.up('native','edges');out=exercise(s)
        (a.artifacts/'edges.json').write_text(json.dumps(out,indent=2)+'\n')
        first,second,third=(out[k] for k in ('route-first','route-second','route-third'))
        assert first[0]==second[0]==third[0]==200,(first,second,third)
        # Same name on another route is a new admission; going back opens a third,
        # since a name resolves to its latest declaration only.
        assert len({first[1]['subscriberId'],second[1]['subscriberId'],third[1]['subscriberId']})==3,(first,second,third)
        assert out['cycle-created-new'] is True
        # The name cap counts UTF-16 code units: 64 astral emoji are 128, 65 are 130.
        assert out['utf16-boundary'][0]==200 and out['utf16-boundary'][1]['name']=='😀'*64,out['utf16-boundary']
        assert out['utf16-overflow'][0]==400 and field(out['utf16-overflow'])=='name',out['utf16-overflow']
        # Combined errors, in parse order: fromSeq, then receipt, then generation.
        judged={q:(out[q][0],field(out[q]) or out[q][1]['error']['message'].split(' ')[0]) for q in ('fromSeq=0&generation=-1','fromSeq=0&receipt=wrong','receipt=wrong&generation=-1','fromSeq=1&generation=-1')}
        assert judged=={'fromSeq=0&generation=-1':(400,'fromSeq'),'fromSeq=0&receipt=wrong':(400,'fromSeq'),'receipt=wrong&generation=-1':(400,'receipt'),'fromSeq=1&generation=-1':(400,'generation')},judged
        print(json.dumps({'pass':True,'cases':len(out),'artifacts':str(a.artifacts)}))
    finally:s.cleanup('agent:tabularasa:project:n3-t11839:task:')
if __name__=='__main__':main()
