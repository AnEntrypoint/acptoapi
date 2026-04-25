export interface TextBlock { type: 'text'; text: string }
export interface ImageBlockBase64 { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
export interface ImageBlockUrl { type: 'image'; source: { type: 'url'; url: string; media_type?: string } }
export interface ImageBlockInline { inlineData: { mimeType: string; data: string } }
export interface ImageBlockFile { fileData: { mimeType: string; fileUri: string } }
export type ImageBlock = ImageBlockBase64 | ImageBlockUrl | ImageBlockInline | ImageBlockFile;
export interface ToolUseBlock { type: 'tool_use'; name: string; input: Record<string, unknown> }
export interface ToolResultBlock { type: 'tool_result'; name: string; content: string | Record<string, unknown> }
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;
export interface Message { role: 'user' | 'assistant'; content: string | ContentBlock[] }
export interface ToolDefinition {
  description?: string;
  parameters?: Record<string, unknown>;
  execute?: (args: Record<string, unknown>, ctx?: { toolCallId: string }) => Promise<unknown>;
}
export type Tools = Record<string, ToolDefinition>;
export interface SafetySetting { category: string; threshold: string }
export interface GenerationParams {
  model?: string | { modelId?: string; id?: string };
  system?: string;
  messages: Message[];
  tools?: Tools;
  apiKey?: string;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  safetySettings?: SafetySetting[];
  configPath?: string;
  taskType?: 'background' | 'think' | 'webSearch' | 'image';
}
export interface StartStepEvent { type: 'start-step' }
export interface TextDeltaEvent { type: 'text-delta'; textDelta: string }
export interface ToolCallEvent { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
export interface ToolResultEvent { type: 'tool-result'; toolCallId: string; toolName: string; args: Record<string, unknown>; result: unknown }
export interface FinishStepEvent { type: 'finish-step'; finishReason: 'stop' | 'tool-calls' | 'error' }
export interface ErrorEvent { type: 'error'; error: Error }
export type StreamEvent = StartStepEvent | TextDeltaEvent | ToolCallEvent | ToolResultEvent | FinishStepEvent | ErrorEvent;
export interface StreamResult { fullStream: AsyncIterable<StreamEvent>; warnings: Promise<unknown[]> }
export interface StreamParams extends GenerationParams { onStepFinish?: () => Promise<void> | void; streamGuard?: StreamGuardOptions }
export function streamGemini(params: StreamParams): StreamResult;
export interface GenerateResult { text: string; parts: unknown[]; response: unknown }
export function generateGemini(params: GenerationParams): Promise<GenerateResult>;

export type TransformerEntry = string | [string, Record<string, unknown>];
export interface TransformerConfig {
  use?: TransformerEntry[];
  [modelName: string]: { use?: TransformerEntry[] } | TransformerEntry[] | undefined;
}
export interface ProviderConfig {
  name: string;
  api_base_url: string;
  api_key: string;
  models?: string[];
  transformer?: TransformerConfig;
  capabilities?: Partial<CapabilitySet>;
}
export interface RouterConfig {
  default?: string;
  background?: string;
  think?: string;
  longContext?: string;
  longContextThreshold?: number;
  webSearch?: string;
  image?: string;
}
export interface RouterConfiguration {
  Providers?: ProviderConfig[];
  providers?: ProviderConfig[];
  Router?: RouterConfig;
  customRouter?: (params: GenerationParams, config: RouterConfig) => Promise<string | null>;
  configPath?: string;
  circuitBreaker?: CircuitBreakerOptions;
}
export interface RouterInstance {
  breaker: { isOpen(name: string): boolean; recordFailure(name: string): void; recordSuccess(name: string): void };
  stream(params: StreamParams): StreamResult;
  generate(params: GenerationParams): Promise<GenerateResult | { text: string; response: unknown }>;
}
export function createRouter(config: RouterConfiguration): RouterInstance;
export function streamRouter(params: StreamParams & RouterConfiguration): StreamResult;
export function generateRouter(params: GenerationParams & RouterConfiguration): Promise<GenerateResult | { text: string; response: unknown }>;

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}
export interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }
export function convertMessages(messages: Message[]): GeminiContent[];
export function convertTools(tools: Tools): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
export function cleanSchema(schema: unknown): unknown;
export interface StreamGuardOptions {
  chunkTimeoutMs?: number;
  maxRepeats?: number;
}
export interface CapabilitySet {
  streaming: boolean;
  toolUse: boolean;
  vision: boolean;
  systemMessage: boolean;
  jsonMode: boolean;
}
export interface CircuitBreakerOptions {
  maxFailures?: number;
  cooldownMs?: number;
}
export class BridgeError extends Error {
  name: string;
  status?: number;
  code?: string | number;
  retryable: boolean;
  provider?: string;
  constructor(message: string, options?: { status?: number; code?: string | number; retryable?: boolean; provider?: string; headers?: unknown });
}
export class AuthError extends BridgeError {}
export class RateLimitError extends BridgeError {}
export class TimeoutError extends BridgeError {}
export class ContextWindowError extends BridgeError {}
export class ContentPolicyError extends BridgeError {}
export class ProviderError extends BridgeError {}
export const GeminiError: typeof BridgeError;
export function classifyError(status: number, message: string, provider?: string): BridgeError;
export function redactKeys(str: string): string;

export type FallbackReason = 'error' | 'timeout' | 'rate_limit' | 'empty' | 'content_policy';
export interface ChainLink {
  model: string;
  timeout?: number;
  fallbackOn?: FallbackReason[];
  temperature?: number;
  max_tokens?: number;
  system?: string;
  tools?: unknown;
  [k: string]: unknown;
}
export interface ChainOptions {
  fallbackOn?: FallbackReason[];
  timeout?: number;
  onFallback?: (info: { from: string; to?: string; reason: FallbackReason; error: Error }) => void;
  [k: string]: unknown;
}
export interface ChainHandle {
  models: string[];
  links: ChainLink[];
  chat(opts: { messages: unknown[]; [k: string]: unknown }): Promise<unknown>;
  stream(opts: { messages: unknown[]; [k: string]: unknown }): AsyncIterable<unknown>;
}
export interface FallbackBuilder {
  then(link: string | ChainLink): FallbackBuilder;
  onFallback(fn: ChainOptions['onFallback']): FallbackBuilder;
  fallbackOn(reasons: FallbackReason[]): FallbackBuilder;
  timeout(ms: number): FallbackBuilder;
  build(): ChainHandle;
  chat(opts: { messages: unknown[] }): Promise<unknown>;
  stream(opts: { messages: unknown[] }): AsyncIterable<unknown>;
  readonly models: string[];
  readonly links: ChainLink[];
}
export function chain(linksOrName: string | (string | ChainLink)[], defaults?: ChainOptions): ChainHandle;
export function fallback(first: string | ChainLink, defaults?: ChainOptions): FallbackBuilder;
export function listNamedChains(): string[];
export function getRunHistory(): Array<{ startedAt: number; state: string; history: unknown[]; servedBy: string | null; finishedAt: number | null }>;
