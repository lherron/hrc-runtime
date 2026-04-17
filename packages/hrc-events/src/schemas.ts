/**
 * Zod validation schemas for hook-derived session events.
 *
 * These validate the normalized output of the hook normalizer,
 * not raw Claude Code hook input.
 */

import { z } from 'zod'

// ============================================================================
// Content / Message primitives
// ============================================================================

export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.string(),
    is_error: z.boolean().optional(),
  }),
])

export const ToolResultSchema = z.object({
  content: z.array(ContentBlockSchema),
  details: z.record(z.unknown()).optional(),
})

// ============================================================================
// Hook-derived event schemas
// ============================================================================

export const ToolExecutionStartEventSchema = z.object({
  type: z.literal('tool_execution_start'),
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.record(z.unknown()),
})

export const ToolExecutionUpdateEventSchema = z.object({
  type: z.literal('tool_execution_update'),
  toolUseId: z.string(),
  message: z.string().optional(),
  partialOutput: z.string().optional(),
})

export const ToolExecutionEndEventSchema = z.object({
  type: z.literal('tool_execution_end'),
  toolUseId: z.string(),
  toolName: z.string(),
  result: ToolResultSchema,
  isError: z.boolean().optional(),
})

export const NoticeEventSchema = z.object({
  type: z.literal('notice'),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  projectId: z.string().optional(),
  runId: z.string().optional(),
})

export const ContextCompactionEventSchema = z.object({
  type: z.literal('context_compaction'),
  trigger: z.string().optional(),
  customInstructions: z.string().optional(),
  details: z.record(z.unknown()).optional(),
})

export const SubagentStartEventSchema = z.object({
  type: z.literal('subagent_start'),
  agentId: z.string().optional(),
  agentType: z.string().optional(),
})

// ============================================================================
// Combined union
// ============================================================================

export const HookDerivedEventSchema = z.discriminatedUnion('type', [
  ToolExecutionStartEventSchema,
  ToolExecutionUpdateEventSchema,
  ToolExecutionEndEventSchema,
  NoticeEventSchema,
  ContextCompactionEventSchema,
  SubagentStartEventSchema,
])
