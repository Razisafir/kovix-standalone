/**
 * Public API for the agent core.
 */

export { AgentLoop, type AgentLoopConfig } from './agentLoop.js';
export { CloudProvider, type CloudProviderConfig, type LLMProvider } from './llm/cloudProvider.js';
export type {
    IConstructAIProvider,
    IChatMessage,
    IToolCall,
    IToolDefinition,
    AIStreamEvent,
    IChatOptions,
    IModelInfo,
    AIProviderType,
    ProviderStatus,
    ConstructAuthError,
    ConstructRateLimitError,
    ConstructOverloadedError,
} from './llm/types.js';
export {
    ExecutionState,
    type IMilestone,
    type ISelectablePlanStep,
    type IApprovedPlan,
    type IPlanStep,
    type IPlanResult,
} from './milestoneStateMachine.js';
export { executeMilestonesWithPauses } from './milestoneExecutor.js';
export type { AgentLoopEvent } from './events.js';
export { PendingChanges, type StagedFile } from './staging/pendingChanges.js';
export {
    TOOL_DEFINITIONS,
    executeTool,
    type ToolContext,
    type ToolResult,
} from './tools/index.js';
export {
    PromptSanitiser,
    sanitise,
    redactSecrets,
    assertWithinWorkspace,
    TerminalRateLimiter,
    isBlockedCommand,
    isInterpreterCommand,
    sanitiseForAuditLog,
} from './security/index.js';
