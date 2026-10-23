"""Exact value comparison plus independent identity/selection discriminators."""
import copy

def same(a,b,path=''):
    assert type(a) is type(b),(path,type(a).__name__,type(b).__name__)
    if isinstance(a,dict):
        assert a.keys()==b.keys(),(path,a.keys(),b.keys())
        for k in a:same(a[k],b[k],path+'/'+k)
    elif isinstance(a,list):
        assert len(a)==len(b),(path,len(a),len(b))
        for i,(x,y) in enumerate(zip(a,b)):same(x,y,path+'/'+str(i))
    else:assert a==b,(path,a,b)

def discriminate(v):
    full=v['full']['value']
    expected=['present-bulk'+str(i)+'-1' for i in range(270)]+['present-quiet-1','present-recent-1','present-boundary-1','present-fallback-3','present-active-1','present-alternate-1']
    assert [s['hostSessionId'] for s in full['sessions']]==expected
    assert [r['runtimeId'] for r in full['runtimes']]==['present-bulk0','present-quiet','present-quiet-second','present-fallback','present-fallback-second','present-alternate']
    assert [(e['hostSessionId'],e['generation']) for e in full['events']]==[('present-quiet-1',1),('present-recent-1',1)]
    assert [e['hrcSeq'] for e in full['events']]==[4,7] # metadata facts precede lifecycle fixture rows
    for name in ['empty','missing']:assert v[name]['value']=={'sessions':[],'runtimes':[],'events':[]}
    assert [s['hostSessionId'] for s in v['runtimeOnly']['value']['sessions']]==['present-quiet-1','present-alternate-1','present-recent-1']
    assert [s['hostSessionId'] for s in v['alias']['value']['sessions']]==['present-alternate-1']
    p={r['runtimeId']:r for r in v['projected']}
    q=p['present-quiet'];assert q['title']=='api-title' and q['metadata']['title']=='api-title'
    assert q['identity']['taskId']=='quiet'
    assert q['tmux']=={'socketPath':'/override/socket','attachTarget':'override:view'}
    assert q['contextReading']=={'malformedButStored':True,'units':'\ud800'}
    assert q['presentation']=={'mode':'stored','extra':None}
    assert q['operatorSurfaces']==[{'surfaceId':'a','clientTty':''},{'surfaceId':'z','clientTty':'/dev/tty1'}]
    q=p['present-quiet-second'];assert q['presentation'] is None and 'tmux' not in q and 'contextReading' not in q
    for field in ['identity','presentation','title','contextReading','tmux']:assert field not in p['present-bulk0']
    assert p['present-alternate']['laneRef']=='lane:alt'
    assert p['present-alternate']['tmux']=={'socketPath':'/flat/socket','attachTarget':'hrc-present-alte'}
    assert [x['error']['code'] for x in v['invalid']]==['malformed_request']*6
    assert v['invalid'][3]['error']['message']=='sessionRef must use "<scopeRef>/lane:<laneRef>" format'

def controls(v):
    discriminate(v)
    recipes={
      'truncate-256':lambda x:x['full']['value']['sessions'].__setitem__(slice(256,None),[]),
      'drop-session':lambda x:x['full']['value']['sessions'].pop(),
      'drop-runtime':lambda x:x['full']['value']['runtimes'].pop(),
      'drop-event':lambda x:x['full']['value']['events'].pop(),
      'wrong-order':lambda x:x['full']['value']['sessions'].reverse(),
      'wrong-generation':lambda x:x['full']['value']['sessions'][-3].__setitem__('hostSessionId','present-fallback-2'),
      'wrong-lane':lambda x:x['projected'][1].__setitem__('laneRef','alt'),
      'missing-context':lambda x:next(r for r in x['projected'] if r['runtimeId']=='present-quiet').pop('contextReading'),
      'missing-identity':lambda x:next(r for r in x['projected'] if r['runtimeId']=='present-quiet').pop('identity'),
      'absence-null':lambda x:next(r for r in x['projected'] if r['runtimeId']=='present-bulk0').__setitem__('presentation',None),
      'both-empty':lambda x:x.__setitem__('full',{'value':{'sessions':[],'runtimes':[],'events':[]}}),
    }
    records=[]
    for name,mutate in recipes.items():
        altered=copy.deepcopy(v);mutate(altered)
        errors=[]
        for checker in (lambda: same(v,altered), lambda:discriminate(altered)):
            try:checker()
            except (AssertionError,KeyError,IndexError) as e:errors.append(repr(e))
        assert len(errors)==2,(name,errors)
        records.append({'name':name,'failures':errors,'altered':altered})
    return records
