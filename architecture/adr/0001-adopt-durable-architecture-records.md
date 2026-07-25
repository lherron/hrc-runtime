# ADR 0001: Adopt durable architecture records

Status: accepted

HRC owns runtime lifecycle and operator-visible runtime truth. Those boundaries
must survive task cleanup and implementation turnover, so this repository keeps
active architectural laws as small machine-checked YAML records.

The records are the normative source. Generated Markdown and JSONL projections
make them easy for humans and tools to discover. The landing gate rejects
missing baseline records, stale projections, missing cited files, duplicate
identifiers, and malformed record structure.

Task specifications and code still provide detailed authority and evidence.
Records preserve only the durable predicate, its scope, verification seam, and
reopen trigger; they do not replace task history or design documents.
