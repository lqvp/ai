/**
 * Conversation Engine - Manages conversation flow and response generation
 */

import { ResponseContext } from '../types/index.js';

export class ConversationEngine {
  private llmService: any;
  private promptTemplates: any;

  constructor(llmService: any, promptTemplates: any) {
    this.llmService = llmService;
    this.promptTemplates = promptTemplates;
  }

  async generateResponse(
    message: string,
    context: ResponseContext
  ): Promise<{
    content: string;
    style: any;
    confidence: number;
  }> {
    // Build the full prompt
    const prompt = this.buildPrompt(message, context);
    
    // Generate response using LLM
    const response = await this.llmService.generate(prompt, {
      temperature: context.constraints.creativity || 0.7,
      maxTokens: context.constraints.maxLength || 300
    });

    return {
      content: response,
      style: context.constraints.tone,
      confidence: 0.9
    };
  }

  private buildPrompt(message: string, context: ResponseContext): string {
    const parts: string[] = [];
    
    // System prompt
    parts.push(context.systemPrompt);
    
    // Relevant memories
    if (context.relevantMemories.length > 0) {
      parts.push('\nRelevant memories:');
      context.relevantMemories.forEach(memory => {
        parts.push(`- ${memory.content.summary || memory.content.raw}`);
      });
    }
    
    // Recent conversation
    const recentMessages = context.conversationState.workingMemory.recentMessages
      .slice(-5)
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');
    
    if (recentMessages) {
      parts.push('\nRecent conversation:');
      parts.push(recentMessages);
    }
    
    // Current message
    parts.push(`\nUser: ${message}`);
    parts.push('\nAssistant:');
    
    return parts.join('\n');
  }
}