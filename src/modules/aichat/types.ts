/**
 * aichat モジュールの型定義。
 */

export type ChatHistoryItem = {
  role: string;
  content: string;
};

export type Base64File = {
  type: string;
  base64: string;
  url?: string;
};

export type AiChat = {
  question: string;
  prompt: string;
  api: string;
  key: string;
  fromMention: boolean;
  friendName?: string;
  grounding?: boolean;
  history?: ChatHistoryItem[];
  timelineContext?: { before?: any[]; after?: any[] };
};

export type GeminiPart = {
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  text?: string;
};

export type GeminiParts = GeminiPart[];

export type GeminiSystemInstruction = {
  role: string;
  parts: [{ text: string }];
};

export type GeminiContents = {
  role: string;
  parts: GeminiParts;
};

export type GeminiOptions = {
  contents?: GeminiContents[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: Array<{
    url_context?: {};
    google_search?: {};
  }>;
  generationConfig?: {
    thinkingConfig?: {
      thinkingBudget?: number;
    };
  };
};

export type ApiErrorResponse = {
  error: true;
  errorCode: number | null;
  errorMessage: string | null;
};

export type GeminiApiResponse = string | ApiErrorResponse | null;

// OpenAI API互換の型定義
export type OpenaiContentPart = {
  type: string;
  text?: string;
  image_url?: { url: string };
};

export type OpenaiSystemOrUserMessage = {
  role: 'system' | 'user';
  content: string | OpenaiContentPart[];
};

export type OpenaiToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenaiAssistantMessage = {
  role: 'assistant';
  content: string | null | OpenaiContentPart[];
  tool_calls?: OpenaiToolCall[];
};

export type OpenaiToolMessage = {
  role: 'tool';
  tool_call_id: string;
  content: string;
};

export type OpenaiMessage =
  | OpenaiSystemOrUserMessage
  | OpenaiAssistantMessage
  | OpenaiToolMessage;

export type OpenaiFunctionParameters = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

export type OpenaiFunctionTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: OpenaiFunctionParameters;
  };
};

export type OpenaiToolChoice =
  | 'auto'
  | 'none'
  | { type: 'function'; function: { name: string } };

export type OpenaiOptions = {
  model: string;
  messages: OpenaiMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: OpenaiFunctionTool[];
  tool_choice?: OpenaiToolChoice;
};

export type AiProvider = 'gemini' | 'openai';

export type UrlPreview = {
  title: string;
  icon: string;
  description: string;
  thumbnail: string;
  player: {
    url: string;
    width: number;
    height: number;
    allow: [];
  };
  sitename: string;
  sensitive: boolean;
  activityPub: string;
  url: string;
};
