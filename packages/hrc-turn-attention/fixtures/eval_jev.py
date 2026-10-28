"""Score jev against the sonnet gold set for turn-end operator asks.

Usage: TYPESAFE_API_KEY=... python3 -I eval_jev.py <scratch-dir>
Writes jev_results.jsonl and prints a confusion matrix + latency/cost.
"""
import json, os, sys, time, urllib.request, concurrent.futures as cf

DIR = sys.argv[1]
KEY = os.environ['TYPESAFE_API_KEY']
MODEL = os.environ.get('JEV_MODEL', 'jev-latest')

QUESTIONS = {
    'ask': {
        'type': 'choice',
        'instructions': 'At the end of this turn, is the agent asking Lance (the human operator) for something? '
                        'Judge only `final_text`; `turn_user` says who prompted the turn.',
        'criteria': {
            'blocking': 'The agent stopped and cannot continue until Lance decides, approves, answers, or does a human-only action '
                        '(e.g. "still waiting on you", "decisions needed", "your call", "should I commit?").',
            'decision': 'The agent finished or proceeded, but explicitly leaves a ruling or choice open for Lance.',
            'offer': 'A polite optional follow-up after completed work ("want me to also...?", "let me know if...").',
            'none': 'No ask of Lance: a status report, acknowledgement, idle "awaiting instructions", or a wait on another agent or process.',
        },
    },
    'to_lance': {
        'type': 'noul',
        'instructions': 'final_text is written to the human operator Lance, not to another agent.',
    },
    'waiting_on_other': {
        'type': 'noul',
        'instructions': 'final_text says the agent is waiting on another agent, a CI run, or a background process.',
    },
    'kind': {
        'type': 'choice',
        'instructions': 'If the agent asks Lance for something, what kind of ask is it?',
        'criteria': {
            'decision': 'Choose between options or rule on a direction.',
            'approval': 'Grant a go-ahead or authority for an action.',
            'information': 'Supply a fact the agent lacks.',
            'human_action': 'Do something only a human can: log in, provide a key, press a key, look at hardware.',
            'review': 'Look at or review a result.',
            'none': 'No ask.',
        },
    },
}

if os.environ.get('PROMPT') == 'v2':
    QUESTIONS['ask']['criteria'] = {
        'blocking': 'Something is waiting on Lance right now: a decision, approval, answer, or a human-only action such as '
                    'a /login, a relaunch, or a key. Counts even when stated in passing at the end of a status report '
                    '("still waiting on you", "hrcdev is still waiting on your /login", "needs Lance to relaunch", "should I commit?").',
        'decision': 'The agent finished or proceeded, but explicitly leaves a ruling or choice open for Lance '
                    '("your two calls still stand", "decision for you").',
        'offer': 'A polite optional follow-up after completed work ("want me to also...?", "let me know if...", "say if you want").',
        'none': 'No ask of Lance: a status report, acknowledgement, idle "awaiting instructions" with no pending work, a wait on '
                'another agent or process, or a status line noting that a recommendation was sent to Lance earlier.',
    }

if os.environ.get('PROMPT') == 'v3':
    QUESTIONS['ask']['criteria'] = {
        'blocking': 'Something is waiting on Lance right now: a decision, approval, answer, or a human-only action such as '
                    'a /login, a relaunch, or a key. Counts even when stated in passing at the end of a status report '
                    '("still waiting on you", "hrcdev is still waiting on your /login", "needs Lance to relaunch", "say go and I will...").',
        'decision': 'A direct question to Lance about the next action on work the agent has in hand ("Should I file it?", '
                    '"Should I implement T-123 now?", "Want me to dispatch it?"), or a ruling explicitly left open for Lance '
                    '("your two calls still stand", "decision for you").',
        'offer': 'A conditional, optional follow-up after completed work that needs no answer ("if you want, I can...", '
                 '"let me know if...", "say so if you want it back up").',
        'none': 'No ask of Lance: a status report, acknowledgement, a wait on another agent or process, a status line noting a '
                'recommendation was sent to Lance earlier, or an idle seat with no work in hand asking what to do next '
                '("What do you want to tackle?", "Tell me what to pick up next", "Send a task when you want me to start").',
    }

def state_of(turn):
    tail = turn['final_text'][-2500:]
    user = turn.get('user_text_tail', '')[-400:]
    return {'agent': turn['agent'], 'project': turn['project'], 'seat': turn['seat'],
            'turn_user': user, 'final_text': tail}

def call(turn):
    body = json.dumps({'model': MODEL, 'state': state_of(turn), 'questions': QUESTIONS}).encode()
    req = urllib.request.Request('https://api.typesafe.ai/v1/systemone', data=body, method='POST',
        headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'})
    t = time.time()
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)
    return turn['id'], out, (time.time() - t) * 1000

turns = {}
for i in range(6):
    for line in open(f'{DIR}/shard{i}.jsonl'):
        o = json.loads(line); turns[o['id']] = o
gold = {}
for i in range(6):
    p = f'{DIR}/labels{i}.jsonl'
    if os.path.exists(p):
        for line in open(p):
            o = json.loads(line); gold[o['id']] = o

RECODE = {**{k: 'none' for k in (32264, 33946, 39314, 41975, 42603, 42686)},
          **{k: 'decision' for k in (47255, 41435, 38438, 41633, 31757)}, 36647: 'offer'}
GOLD_MAP = {'blocking': 'blocking', 'nonblocking_decision': 'decision', 'soft_offer': 'offer', 'none': 'none'}
results, lat, tokens = [], [], 0
with cf.ThreadPoolExecutor(8) as ex:
    for tid, out, ms in ex.map(call, [turns[k] for k in gold]):
        a = out['answers']
        results.append({'id': tid, 'gold': RECODE.get(tid, GOLD_MAP[gold[tid]['needs_lance']]), 'jev': a['ask']['choice'],
                        'p': a['ask']['probabilities'], 'conf': a['ask']['confidence'],
                        'to_lance': a['to_lance']['noul'], 'waiting_on_other': a['waiting_on_other']['noul'],
                        'kind': a['kind']['choice'], 'ms': ms})
        lat.append(ms); tokens += out.get('usage', {}).get('input_tokens', 0)

with open(f'{DIR}/jev_results.jsonl', 'w') as f:
    for r in results: f.write(json.dumps(r) + '\n')

labels = ['blocking', 'decision', 'offer', 'none']
print('gold\\jev ' + ' '.join(f'{l:>9}' for l in labels))
for g in labels:
    print(f'{g:>9} ' + ' '.join(f'{sum(1 for r in results if r["gold"]==g and r["jev"]==j):>9}' for j in labels))
# The product signal: blocking|decision lights the row.
def lit(r, th):
    return r['p']['blocking'] + r['p']['decision'] >= th
for th in (0.3, 0.5, 0.7):
    tp = sum(1 for r in results if lit(r, th) and r['gold'] in ('blocking', 'decision'))
    fp = sum(1 for r in results if lit(r, th) and r['gold'] not in ('blocking', 'decision'))
    fn = sum(1 for r in results if not lit(r, th) and r['gold'] in ('blocking', 'decision'))
    print(f'attention@{th}: precision {tp/max(1,tp+fp):.2f} recall {tp/max(1,tp+fn):.2f} (tp {tp} fp {fp} fn {fn})')
lat.sort()
print(f'latency ms p50 {lat[len(lat)//2]:.0f} p95 {lat[int(len(lat)*.95)]:.0f}; input tokens {tokens} '
      f'(${tokens*0.042/1e6:.4f}); {len(results)} turns')
