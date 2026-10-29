#!/usr/bin/env python3
"""Run ordered retirement parity through the real authenticated registry HTTP
listener, exercising the remote client as well as the local-store suite.
"""
import json
from pathlib import Path
import secrets
import sys
from n4_federation import Node,TAILNET,free_port
import retirement_parity as suite
from routes import main

node=None


def prepare(release,dbpath,scope,host,env):
    global node
    suite.prepare(release,dbpath,scope,host,env)
    artifacts=Path(sys.argv[sys.argv.index('--artifacts')+1])
    node=Node(dbpath.parent.parent/'r',release,dbpath.parent/'unused-aspd.sock',artifacts,'registry')
    token=secrets.token_hex(24)
    peer_port,registry_port=free_port(),free_port()
    node.write_config({'nodeId':'operator-registry','peers':{'operator-test':{'endpoint':f'http://{TAILNET}:{peer_port}','token':token}},'registry':{'bind':f'http://{TAILNET}:{registry_port}'},'gate':{'mode':'off','registryHost':'operator-registry'}})
    node.up('bun',None,'registry')
    Path(env['HRC_PEER_CONFIG_FILE']).write_text(json.dumps({'nodeId':'operator-test','peers':{'operator-registry':{'endpoint':f'http://{TAILNET}:{peer_port}','registryEndpoint':f'http://{TAILNET}:{registry_port}','token':token}},'gate':{'mode':'off','registryHost':'operator-registry'}}))
    suite.REGISTRY=node.root/'federation/binding-registry.sqlite'


if __name__=='__main__':
    try:main(prepare=prepare,case_factory=suite.cases,settle=suite.settle,observe=suite.observe,compare=suite.compare,suite='retirement-remote-parity')
    finally:
        if node:node.cleanup()
