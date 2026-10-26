"""Session index comparison; only live peer check timestamps can differ."""
import datetime
import json
from pathlib import Path

CASES = ('placement-bindings','placement-bindings-missing','placement-bindings-wrong-state','placement-bindings-untrimmed','index-page','index-page-all','index-page-filter','index-page-empty',
         'index-page-lossy','index-page-lane','index-page-limit','index-page-limit-fraction',
         'index-page-limit-overflow','index-page-status','index-page-mode',
         'index-page-nodes','index-page-nodes-order','index-page-duplicate-limit','index-cursor-number','index-page-cursor','index-facets','index-facets-filter',
         'index-facets-agent','index-facets-effective','index-facets-execution','index-facets-project','index-facets-status','index-facets-mode',
         'index-facets-limit','index-facets-cursor','index-next','index-cursor-mismatch')


def compare(args, checks):
    subjects = {}
    for kind, directory in [('bun', args.baseline), ('native', args.candidate)]:
        rows = json.loads((Path(directory) / 'observations.json').read_text())
        by_name = {r['case']: r for r in rows}
        checks.append({'id': kind+':required', 'pass': len(by_name)==len(rows) and set(CASES)==set(by_name), 'reason':'all index cases must be present exactly once','failureCode':1})
        for row in rows:
            body = row['response']['body']
            if isinstance(body, dict):
                if 'items' in body:
                    highwater=body.get('eventHighWater',{})
                    # Startup lifecycle rows are N4. Independently validate
                    # the pointer against each owner's actual local ledger.
                    valid=len(highwater)==1 and all(value==row['databaseMaxHrcSeq'] for value in highwater.values())
                    checks.append({'id':kind+':'+row['case']+':highwater','pass':valid,'reason':'page high-water must be the actual database head','failureCode':1})
                    if valid:body['eventHighWater']={node:'database-head' for node in highwater}

                for node, status in body.get('peerStatus', {}).items():
                    stamp = datetime.datetime.fromisoformat(status['checkedAt'].replace('Z','+00:00')).timestamp()
                    checks.append({'id':kind+':'+row['case']+':'+node+':timestamp','pass':row['before']-.01<=stamp<=row['after']+.01,'reason':'peer check must occur within the request','failureCode':1})
                    status['checkedAt'] = 'request-time'
        if set(CASES)<=set(by_name):
            full=by_name['index-page-all']['response']['body']
            facets=by_name['index-facets']['response']['body']
            next_page=by_name['index-next']['response']['body']
            positive=(len(full.get('items',[]))==2 and any(i.get('title')=='N1 index title' for i in full['items']) and facets.get('total')==2 and len(next_page.get('items',[]))==1 and 'nextCursor' not in next_page)
            positive=positive and by_name['index-facets-agent']['response']['body'].get('byAgentId')=={'tabularasa':2} and by_name['index-facets-effective']['response']['body'].get('byEffectiveStatus')=={'inactive':2} and by_name['index-facets-execution']['response']['body'].get('byExecutionMode')=={'nonInteractive':2}
            binding=by_name['placement-bindings']['response']['body']
            positive=positive and len(binding.get('bindings',[]))==2 and all(row['state']=='active' and row['homeNodeId']==binding['localNodeId'] and row['scopeRef'].endswith(('-local-a','-local-b')) for row in binding['bindings'])
            checks.append({'id':kind+':positive-controls','pass':positive,'reason':'nonempty pages, title, cursor termination and excluded-dimension facets must be exercised','failureCode':1})
        subjects[kind] = by_name
    cases = []
    for name in CASES:
        a,b = subjects['bun'].get(name),subjects['native'].get(name)
        passed = a is not None and b is not None and all(a[k]==b[k] for k in ('method','path','request','response','metadataEvents'))
        check = {'id':name,'pass':passed,'reason':'full response, pagination cursor, highwater, filters and facet counts must agree','failureCode':1}
        checks.append(check);cases.append({'id':name,'pass':passed})
    return {'suite':'n1-index','cases':cases,'behaviorQualified':bool(checks) and all(c['pass'] for c in checks)}
