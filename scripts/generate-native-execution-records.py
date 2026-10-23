#!/usr/bin/env python3
"""Typed runtime/run bindings to canonical selected columns (not arbitrary JSON rows)."""
import json,pathlib,re
root=pathlib.Path(__file__).resolve().parents[1]
tables={t['name']:t for t in json.loads((root/'contract/hrc-parity/store-schema.json').read_text())['tables']}
columns=(root/'packages/hrc-store-sqlite/src/repositories/columns.ts').read_text()+(root/'packages/hrc-store-sqlite/src/repositories/broker.ts').read_text()
domain=['//! Generated current selected-column runtime/run contracts.', 'use super::{Patch,SessionIdentity};', 'use serde::{Serialize,Deserialize};', 'use super::json::Value;', '']
code=['use hrc_domain::store::json as serde_json;', '// Generated typed mapping/patch plumbing; domain behavior remains in repositories.', 'use crate::{Result,StoreError,sessions::{identity,optional_json}};', 'use hrc_domain::store::{*,rows::*};','use rusqlite::{Connection,types::Value as SqlValue};', '']
for name,table,constant,prefix,pk in [('RuntimeRecord','runtimes','RUNTIME_COLUMNS','runtime','runtime_id'),('RunRecord','runs','RUN_COLUMNS','run','run_id'),('RuntimeOperation','runtime_operations','RUNTIME_OPERATION_COLUMNS','operation','operation_id'),('BrokerInvocation','broker_invocations','BROKER_INVOCATION_COLUMNS','invocation','invocation_id')]:
    patch_name=name[:-6]+'Patch' if name.endswith('Record') else name+'Patch'
    rowtype=''.join(x.capitalize() for x in table.split('_'))+'Row'
    selected=[c.strip() for c in re.search(r'export const '+constant+r' = `([^`]+)`',columns,re.S)[1].split(',')]
    schema={c['name']:c for c in tables[table]['columns']}
    attrs=[]
    for column in selected:
        c=schema[column];field='presentation' if column=='presentation_json' else column
        isjson=table=='runtimes' and column in ['tmux_json','runtime_state_json','presentation_json']
        base='Value' if isjson else 'bool' if column=='supports_inflight_input' else 'i64' if 'INT' in c['type'].upper() else 'String'
        optional=not c['notnull'] and not c['pk']
        if column=='status_changed_at': optional=False
        if column=='execution_format': optional=True
        attrs.append((column,field,base,optional,isjson))
    domain.extend(['#[derive(Debug,Clone,Default,Serialize,Deserialize,PartialEq)]','#[serde(rename_all="camelCase")]','pub struct '+name+' {'])
    for col,field,base,opt,isjson in attrs:
        if opt:domain.append('    #[serde(skip_serializing_if="Option::is_none")]')
        domain.append('    pub '+field+': '+('Option<'+base+'>' if opt else base)+',')
    if table=='runtimes':domain.extend(['    #[serde(skip_serializing_if="Option::is_none")]','    pub identity:Option<SessionIdentity>,'])
    domain.extend(['}','#[derive(Debug,Clone,Default)]','pub struct '+patch_name+' {'])
    for col,field,base,opt,isjson in attrs:
        if col!=pk and not (table in ['runtime_operations','broker_invocations'] and col=='created_at'):domain.append('    pub '+field+': Patch<'+base+'>,')
    domain.extend(['}',''])
    code.extend(['pub(crate) fn '+prefix+'_from_row(db:&Connection,r:'+rowtype+')->Result<'+name+'> {'])
    if table!='runtimes':code.append('    let _=db;')
    if table in ['runtimes','runs']:code.append('    crate::validation::'+('runtime' if table=='runtimes' else 'run')+'_status(&r.status)?;')
    code.append('    Ok('+name+' {')
    for col,field,base,opt,isjson in attrs:
        expr='optional_json(r.'+col+',"'+col+'")' if isjson else 'r.'+col+'!=0' if base=='bool' else 'r.'+col+'.unwrap_or_else(||"unknown".into())' if col=='status_changed_at' else '(r.'+col+'=="format2").then_some(r.'+col+')' if col=='execution_format' else 'r.'+col+'.filter(|s|matches!(s.as_str(),"human"|"agent"|"system"))' if col=='origin_kind' else 'r.'+col
        if table=='runtimes' and col in ['scope_ref','lane_ref']:expr+=' .clone()'
        code.append('        '+field+': '+expr+',')
    if table=='runtimes':code.append('        identity:identity(db,&r.scope_ref,&r.lane_ref)?,')
    code.extend(['    })','}'])
    code.extend(['pub(crate) fn '+prefix+'_to_row(r:&'+name+')->Result<'+rowtype+'> {','    Ok('+rowtype+' {'])
    for col,field,base,opt,isjson in attrs:
        expr='r.'+field+'.as_ref().map(serde_json::to_string).transpose()?' if isjson else 'i64::from(r.'+field+')' if base=='bool' else 'if r.'+field+'=="unknown"||r.'+field+'.is_empty(){None}else{Some(r.'+field+'.clone())}' if col=='status_changed_at' else 'r.'+field+'.clone().unwrap_or_else(||"format1".into())' if col=='execution_format' else 'r.'+field+('' if base=='i64' else '.clone()')
        code.append('        '+col+': '+expr+',')
    if set(schema)-set(selected):code.append('        ..Default::default()')
    code.extend(['    })','}'])
    code.extend(['pub(crate) fn '+prefix+'_patch_entries(p:&'+patch_name+')->Result<Vec<(&\'static str,SqlValue)>> {','    let mut values=Vec::new();'])
    for col,field,base,opt,isjson in attrs:
        if col==pk or (table in ['runtime_operations','broker_invocations'] and col=='created_at'):continue
        expr='serde_json::to_string(v)?.into()' if isjson else 'i64::from(*v).into()' if base=='bool' else '(*v).into()' if base=='i64' else 'v.clone().into()'
        code.append('    match &p.'+field+' {Patch::Unchanged=>{},Patch::Clear=>values.push(("'+col+'",SqlValue::Null)),Patch::Set(v)=>values.push(("'+col+'",'+expr+')),}')
    code.extend(['    Ok(values)','}',''])
(root/'crates/hrc-domain/src/store/execution.rs').write_text('\n'.join(domain))
(root/'crates/hrc-store/src/execution_mapping.rs').write_text('\n'.join(code).replace('Result,StoreError,','Result,'))
