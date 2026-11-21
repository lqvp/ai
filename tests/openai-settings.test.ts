import { describe, expect, it } from 'vitest';
import {
  buildChatCompletionsUrl,
  type OpenaiProviderConfig,
  resolveOpenaiSettings,
} from '../src/modules/aichat/openai-settings.js';

describe('buildChatCompletionsUrl', () => {
  it('appends /v1/chat/completions to a bare host', () => {
    expect(buildChatCompletionsUrl('https://api.openai.com')).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
  });

  it('accepts a baseUrl that already ends with /v1', () => {
    expect(buildChatCompletionsUrl('http://100.76.187.83:30000/v1')).toBe(
      'http://100.76.187.83:30000/v1/chat/completions'
    );
  });

  it('strips trailing slashes', () => {
    expect(buildChatCompletionsUrl('https://example.com//')).toBe(
      'https://example.com/v1/chat/completions'
    );
    expect(buildChatCompletionsUrl('https://example.com/v1/')).toBe(
      'https://example.com/v1/chat/completions'
    );
  });
});

describe('resolveOpenaiSettings', () => {
  it('fills defaults when no config is given', () => {
    const settings = resolveOpenaiSettings({});
    expect(settings.model).toBe('gpt-4o-mini');
    expect(settings.apiUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(settings.apiKey).toBeUndefined();
    expect(settings.timeoutMs).toBe(120_000);
  });

  it('uses the given model, url and key', () => {
    const raw: OpenaiProviderConfig = {
      apiKey: 'sk-test',
      baseUrl: 'http://100.76.187.83:30000/v1',
      model: 'moonmath-glm53-uncensored',
      temperature: 0.5,
      maxTokens: 1024,
      timeoutMs: 30_000,
    };
    const settings = resolveOpenaiSettings(raw);
    expect(settings.model).toBe('moonmath-glm53-uncensored');
    expect(settings.apiUrl).toBe(
      'http://100.76.187.83:30000/v1/chat/completions'
    );
    expect(settings.apiKey).toBe('sk-test');
    expect(settings.temperature).toBe(0.5);
    expect(settings.maxTokens).toBe(1024);
    expect(settings.timeoutMs).toBe(30_000);
  });

  it('keeps apiKey optional for key-less endpoints', () => {
    const settings = resolveOpenaiSettings({
      baseUrl: 'http://localhost:8000',
    });
    expect(settings.apiKey).toBeUndefined();
    expect(settings.apiUrl).toBe('http://localhost:8000/v1/chat/completions');
  });
});
