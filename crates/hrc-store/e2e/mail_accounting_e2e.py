#!/usr/bin/env python3
"""Real repository stop/refusal accounting; empty decision is a read, evaluation writes."""
import argparse,json,pathlib,subprocess,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--release',required=True);p.add_argument('--artifacts',required=True);a=p.parse_args();out=pathlib.Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hrcp1-mail-count-',dir='/tmp') as root:
    oracle=['bun',str(pathlib.Path(__file__).with_name('oracle.ts')),a.release,root]
    seed=subprocess.run(oracle+['seed'],capture_output=True,text=True);assert seed.returncode==0,seed.stderr
    n=subprocess.run([a.binary,'mail-accounting-contract','--db',str(pathlib.Path(root)/'state.sqlite')],capture_output=True,text=True,env={**os.environ,'PATH':'/usr/bin:/bin','HRC_SOCKET_PATH':str(pathlib.Path(root)/'absent.sock')})
    (out/'native.json').write_text(json.dumps({'exit':n.returncode,'stdout':n.stdout,'stderr':n.stderr},indent=2));assert n.returncode==0,n.stdout+n.stderr
    result=json.loads(n.stdout);assert [r['decision']for r in result['firstThree']]==['block','block','allow'];assert result['firstThree'][2]['reason']=='refusal_cap'
    assert result['older']['refusalCount']==3 and result['newer']['refusalCount']==1
    assert result['hard']['reason']=='hard_cap' and result['hard']['totalRefusalCount']==50
    assert result['empty']['reason']=='clear' and result['emptyRecordUnchanged'] is True
    assert result['strikes']==[1,2,1,0] and result['windows']==['first','first','next']
    assert result['resolved']==[True,False] and result['noticeInserted']==[True,False]
    assert result['undelivered']==[] and len(result['notices'])==1
    bun=subprocess.run(oracle+['mail-accounting-read'],capture_output=True,text=True);(out/'unchanged-bun.json').write_text(json.dumps({'exit':bun.returncode,'stdout':bun.stdout,'stderr':bun.stderr},indent=2));assert bun.returncode==0,bun.stderr
    observed=json.loads(bun.stdout);assert observed['record']==result['record'] and observed['notices']==result['notices'] and observed['birth']==result['birth']
