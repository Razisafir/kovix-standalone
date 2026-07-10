/**
 * Public API for the agent core.
 */

export { AgentLoop, type AgentLoopConfig } from './agentLoop.js';
export {
    type CloudProviderConfig,
} from './llm/cloudProvider.js';
export type { LLMProvider as LLMProviderName } from './llm/cloudProvider.js';
// Re-export the Phase 4 non-streaming LLMProvider interface + adapter. This
// intentionally shadows the LLMProvider *type alias* from cloudProvider.ts
// (a string union of provider names) -- per the Phase 4 spec, `LLMProvider`
// is now the non-streaming chat interface. The cloudProvider string union is
// re-exported above as `LLMProviderName` to preserve access for callers that
// need the discriminator.
export {
    type LLMProvider,
    type LLMMessage,
    type LLMResponse,
    type LLMToolCall,
    type LLMToolSchema,
    wrapProvider,
    toToolSchema,
} from './llmProviderAdapter.js';
export {
    MilestoneTaskRunner,
    MilestoneStatus,
    type Milestone,
    type MilestoneTaskRunnerConfig,
    type PlanReadyPayload,
    type MilestoneStartedPayload,
    type ToolCallPayload,
    type ToolResultPayload,
    type VerificationResultPayload,
    type MilestoneVerifiedPayload,
    type MilestoneFailedPayload,
    type CompletePayload,
    type ErrorPayload,
    parsePlannedMilestones,
} from './milestoneTaskRunner.js';
export { OllamaProvider, type OllamaProviderConfig } from './llm/ollamaProvider.js';
export {
    createProvider,
    listProviders,
    type ProviderName,
    type CreateProviderOptions,
} from './llm/providerFactory.js';
export type {
    IConstructAIProvider,
    IChatMessage,
    IToolCall,
    IToolDefinition,
    AIStreamEvent,
    IChatOptions,
    IModelInfo,
    AIProviderType,
} from './llm/types.js';
export {
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
export {
    RefinementService,
    type RefinementServiceConfig,
    type RefinementTurn,
    type RefinementSpec,
    type RefinementResult,
} from './refinement/index.js';
export {
    PlanningService,
    type PlanningServiceConfig,
    type PlanMilestone,
    type MilestoneType,
    type PlanResult,
} from './planning/index.js';
export {
    LeadAgentService,
    type LeadAgentConfig,
    type LeadAgentEvent,
    type WorkerReport,
} from './leadAgent/leadAgentService.js';
