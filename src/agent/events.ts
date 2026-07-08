/**
 * Agent loop event types — what the agent loop yields during execution.
 *
 * Ported from Kovix_2.0 src/vs/platform/construct/common/agent/agentLoop.ts
 * (interface only — the implementation is in agentLoop.ts below).
 */

import type { IMilestone } from './milestoneStateMachine.js';

export type AgentLoopEvent =
    | { type: 'thinking'; text: string }
    | { type: 'token'; text: string }
    | { type: 'tool_start'; toolId: string; toolName: string; toolInput?: unknown }
    | { type: 'tool_executing'; toolId: string; toolName: string; detail?: string }
    | { type: 'tool_result'; toolId: string; toolName: string; result: string; success: boolean }
    | { type: 'file_written'; filePath: string }
    | { type: 'complete'; summary: string }
    | { type: 'error'; text: string; recoverable: boolean }
    | { type: 'milestone_reached'; milestone: IMilestone }
    | { type: 'milestone_paused'; milestone: IMilestone }
    | { type: 'milestone_resumed'; milestone: IMilestone }
    | { type: 'milestone_skipped'; milestone: IMilestone }
    | { type: 'milestone_completed'; milestone: IMilestone }
    | { type: 'verification_start'; command: string }
    | { type: 'verification_result'; passed: boolean; output: string; unverified?: boolean }
    | { type: 'plan_ready'; plan: { steps: Array<{ action: string; target: string; description: string }>; summary: string } }
    | { type: 'approval_request'; filePath: string; proposedContent: string; existingContent: string | null }
    | { type: 'stage_clear' };
