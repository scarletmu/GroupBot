export type ChatRole = 'system' | 'user' | 'assistant';

export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
    };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  provider?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  provider: string;
  usage?: ChatUsage;
  finishReason?: string;
}

export interface ImageRequest {
  prompt: string;
  provider?: string;
  model?: string;
  size?: string;
  n?: number;
  signal?: AbortSignal;
}

export interface ImageItem {
  b64?: string;
  url?: string;
}

export interface ImageResponse {
  images: ImageItem[];
  model: string;
  provider: string;
}

export type LlmErrorCode =
  | 'NOT_CONFIGURED'
  | 'PROVIDER_NOT_FOUND'
  | 'NO_IMAGE_MODEL'
  | 'TIMEOUT'
  | 'HTTP'
  | 'PARSE'
  | 'NETWORK';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly httpStatus?: number;

  constructor(code: LlmErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
  image(req: ImageRequest): Promise<ImageResponse>;
}
