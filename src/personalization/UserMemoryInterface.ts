import { bindThis } from '@/decorators.js';
import {
  Memory,
  MemoryType,
  UserProfile,
  MemoryQuery,
  PersonalizationError,
  PersonalizationErrorCode
} from './types.js';
import HybridMemorySystem from './HybridMemorySystem.js';
import UserProfileManager from './UserProfileManager.js';

/**
 * User Memory Interface
 * Provides user control over their personal data and memories
 */
export default class UserMemoryInterface {
  // Command patterns
  private readonly COMMANDS = {
    SHOW_MEMORIES: /^\/memories?\s*(.*)$/i,
    FORGET: /^\/forget\s+(.+)$/i,
    UPDATE_INFO: /^\/update_info\s+(.+)$/i,
    SHOW_PROFILE: /^\/profile$/i,
    EXPORT_DATA: /^\/export_data$/i,
    DELETE_ALL: /^\/delete_all_data$/i,
    HELP: /^\/help$/i
  };

  constructor(
    private memorySystem: HybridMemorySystem,
    private profileManager: UserProfileManager
  ) {}

  /**
   * Process user command
   */
  @bindThis
  public async processCommand(
    userId: string,
    command: string
  ): Promise<{ success: boolean; message: string; data?: any }> {
    // Check for memory-related commands
    for (const [cmdName, pattern] of Object.entries(this.COMMANDS)) {
      const match = command.match(pattern);
      if (match) {
        switch (cmdName) {
          case 'SHOW_MEMORIES':
            return await this.showMemories(userId, match[1]);
          
          case 'FORGET':
            return await this.forgetMemory(userId, match[1]);
          
          case 'UPDATE_INFO':
            return await this.updateInfo(userId, match[1]);
          
          case 'SHOW_PROFILE':
            return await this.showProfile(userId);
          
          case 'EXPORT_DATA':
            return await this.exportUserData(userId);
          
          case 'DELETE_ALL':
            return await this.deleteAllData(userId);
          
          case 'HELP':
            return this.showHelp();
          
          default:
            break;
        }
      }
    }
    
    return {
      success: false,
      message: 'Command not recognized. Type /help for available commands.'
    };
  }

  /**
   * Show user's memories
   */
  @bindThis
  private async showMemories(
    userId: string,
    filterString: string
  ): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      // Parse filters from string
      const filters = this.parseMemoryFilters(filterString);
      
      const query: MemoryQuery = {
        userId,
        filters,
        limit: 10
      };
      
      const memories = await this.memorySystem.queryMemories(query);
      const stats = await this.memorySystem.getMemoryStats(userId);
      
      if (memories.length === 0) {
        return {
          success: true,
          message: 'No memories found matching your criteria.'
        };
      }
      
      // Format memories for display
      const formattedMemories = memories.map((memory, index) => 
        this.formatMemory(memory, index + 1)
      ).join('\n\n');
      
      const message = `📚 **Your Memories** (${memories.length} of ${stats.total} total)\n\n${formattedMemories}\n\n` +
        `📊 **Statistics**\n` +
        `- Total memories: ${stats.total}\n` +
        `- Episodic: ${stats.byType.episodic}\n` +
        `- Semantic: ${stats.byType.semantic}\n` +
        `- Average importance: ${(stats.averageImportance * 100).toFixed(1)}%`;
      
      return {
        success: true,
        message,
        data: { memories, stats }
      };
    } catch (error) {
      return {
        success: false,
        message: `Error retrieving memories: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Forget specific memory
   */
  @bindThis
  private async forgetMemory(
    userId: string,
    searchTerm: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Search for memories containing the term
      const memories = await this.memorySystem.queryMemories({
        userId,
        filters: { search: searchTerm },
        limit: 50
      });
      
      if (memories.length === 0) {
        return {
          success: false,
          message: `No memories found containing "${searchTerm}"`
        };
      }
      
      // If multiple memories found, ask for confirmation
      if (memories.length > 1) {
        const preview = memories.slice(0, 3).map((m, i) => 
          `${i + 1}. ${m.content.substring(0, 50)}...`
        ).join('\n');
        
        return {
          success: false,
          message: `Found ${memories.length} memories containing "${searchTerm}":\n${preview}\n\n` +
            `Please be more specific or use memory ID.`
        };
      }
      
      // Delete the memory
      await this.memorySystem.deleteMemories(userId, [memories[0].id]);
      
      return {
        success: true,
        message: `✅ Successfully forgot memory: "${memories[0].content.substring(0, 100)}..."`
      };
    } catch (error) {
      return {
        success: false,
        message: `Error forgetting memory: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Update user information
   */
  @bindThis
  private async updateInfo(
    userId: string,
    updateString: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Parse update string
      const updates = this.parseUpdateString(updateString);
      
      if (Object.keys(updates).length === 0) {
        return {
          success: false,
          message: 'Invalid update format. Use: /update_info name=John interests=coding,music'
        };
      }
      
      // Update profile
      await this.profileManager.addExplicitInfo(userId, updates);
      
      const updatedFields = Object.keys(updates).join(', ');
      return {
        success: true,
        message: `✅ Successfully updated: ${updatedFields}`
      };
    } catch (error) {
      return {
        success: false,
        message: `Error updating information: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Show user profile
   */
  @bindThis
  private async showProfile(userId: string): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      const profile = await this.profileManager.getOrCreateProfile(userId);
      
      const message = this.formatProfile(profile);
      
      return {
        success: true,
        message,
        data: profile
      };
    } catch (error) {
      return {
        success: false,
        message: `Error retrieving profile: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Export all user data
   */
  @bindThis
  private async exportUserData(userId: string): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      // Gather all user data
      const profile = await this.profileManager.exportProfile(userId);
      const memories = await this.memorySystem.queryMemories({ userId });
      const stats = await this.memorySystem.getMemoryStats(userId);
      
      const exportData = {
        exportDate: new Date().toISOString(),
        profile,
        memories,
        statistics: stats
      };
      
      return {
        success: true,
        message: '📦 Your data has been prepared for export. You can save this JSON data.',
        data: exportData
      };
    } catch (error) {
      return {
        success: false,
        message: `Error exporting data: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Delete all user data
   */
  @bindThis
  private async deleteAllData(userId: string): Promise<{ success: boolean; message: string }> {
    try {
      // Delete all memories
      const memories = await this.memorySystem.queryMemories({ userId });
      const memoryIds = memories.map(m => m.id);
      await this.memorySystem.deleteMemories(userId, memoryIds);
      
      // Delete profile
      await this.profileManager.deleteProfile(userId);
      
      return {
        success: true,
        message: '🗑️ All your personal data has been permanently deleted.'
      };
    } catch (error) {
      return {
        success: false,
        message: `Error deleting data: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Show help message
   */
  private showHelp(): { success: boolean; message: string } {
    const helpMessage = `
📖 **Memory Management Commands**

**View your data:**
• \`/memories [filter]\` - Show your stored memories
  - Examples: \`/memories\`, \`/memories recent\`, \`/memories important\`
• \`/profile\` - View your user profile
• \`/export_data\` - Export all your data as JSON

**Manage your data:**
• \`/forget <search term>\` - Delete specific memories
  - Example: \`/forget project deadline\`
• \`/update_info <field=value>\` - Update your information
  - Example: \`/update_info name=Alice interests=music,art\`
• \`/delete_all_data\` - Permanently delete all your data

**Available fields for update_info:**
• name, age, location, occupation
• interests (comma-separated)
• goals (comma-separated)
• preferences (key=value pairs)

**Privacy Notice:**
Your data is stored securely and you have full control over it. Use these commands to manage what I remember about you.
    `.trim();
    
    return {
      success: true,
      message: helpMessage
    };
  }

  // Helper methods

  private formatMemory(memory: Memory, index: number): string {
    const date = new Date(memory.timestamp).toLocaleDateString();
    const importance = `${(memory.importance * 100).toFixed(0)}%`;
    const type = memory.type.charAt(0).toUpperCase() + memory.type.slice(1);
    
    return `**${index}.** [${type}] ${date} (Importance: ${importance})\n` +
      `   ${memory.content.substring(0, 150)}${memory.content.length > 150 ? '...' : ''}\n` +
      `   Tags: ${memory.metadata.tags.join(', ') || 'none'}`;
  }

  private formatProfile(profile: UserProfile): string {
    const { explicit, implicit, relationship, meta } = profile;
    
    let message = '👤 **Your Profile**\n\n';
    
    // Explicit information
    message += '**Basic Information:**\n';
    if (explicit.name) message += `• Name: ${explicit.name}\n`;
    if (explicit.age) message += `• Age: ${explicit.age}\n`;
    if (explicit.location) message += `• Location: ${explicit.location}\n`;
    if (explicit.occupation) message += `• Occupation: ${explicit.occupation}\n`;
    if (explicit.interests.length > 0) message += `• Interests: ${explicit.interests.join(', ')}\n`;
    if (explicit.goals.length > 0) message += `• Goals: ${explicit.goals.join(', ')}\n`;
    
    // Relationship info
    message += '\n**Our Relationship:**\n';
    message += `• Level: ${this.formatRelationshipLevel(relationship.level)}\n`;
    message += `• Total interactions: ${relationship.totalInteractions}\n`;
    message += `• Trust score: ${(relationship.trustScore * 100).toFixed(0)}%\n`;
    message += `• First met: ${new Date(relationship.firstInteraction).toLocaleDateString()}\n`;
    
    // Inferred information (if high confidence)
    if (implicit.communicationStyle) {
      message += '\n**Communication Style:**\n';
      message += `• Preferred style: ${implicit.communicationStyle}\n`;
    }
    
    if (implicit.expertise.length > 0) {
      message += `• Expertise areas: ${implicit.expertise.join(', ')}\n`;
    }
    
    // Data quality
    message += `\n**Profile Quality:** ${this.formatDataQuality(meta.dataQuality)}`;
    
    return message;
  }

  private formatRelationshipLevel(level: string): string {
    const levelMap: Record<string, string> = {
      'new_user': '🆕 New User',
      'acquaintance': '👋 Acquaintance',
      'familiar': '🤝 Familiar',
      'friend': '😊 Friend',
      'collaborator': '🌟 Close Collaborator'
    };
    return levelMap[level] || level;
  }

  private formatDataQuality(quality: string): string {
    const qualityMap: Record<string, string> = {
      'low': '📊 Low (Add more information to improve)',
      'medium': '📊📊 Medium (Good foundation)',
      'high': '📊📊📊 High (Comprehensive profile)'
    };
    return qualityMap[quality] || quality;
  }

  private parseMemoryFilters(filterString: string): MemoryQuery['filters'] {
    const filters: MemoryQuery['filters'] = {};
    
    if (!filterString) return filters;
    
    // Parse common filter keywords
    if (filterString.includes('recent')) {
      filters.dateRange = {
        start: Date.now() - 7 * 24 * 60 * 60 * 1000, // Last 7 days
        end: Date.now()
      };
    }
    
    if (filterString.includes('important')) {
      filters.importance = { min: 0.7, max: 1.0 };
    }
    
    if (filterString.includes('episodic')) {
      filters.type = [MemoryType.EPISODIC];
    }
    
    if (filterString.includes('semantic')) {
      filters.type = [MemoryType.SEMANTIC];
    }
    
    // If no specific filters, treat as search term
    if (Object.keys(filters).length === 0 && filterString.trim()) {
      filters.search = filterString.trim();
    }
    
    return filters;
  }

  private parseUpdateString(updateString: string): Partial<UserProfile['explicit']> {
    const updates: Partial<UserProfile['explicit']> = {};
    
    // Parse key=value pairs
    const pairs = updateString.split(/\s+/);
    
    for (const pair of pairs) {
      const [key, value] = pair.split('=');
      if (!key || !value) continue;
      
      switch (key.toLowerCase()) {
        case 'name':
          updates.name = value;
          break;
        case 'age':
          updates.age = parseInt(value);
          break;
        case 'location':
          updates.location = value;
          break;
        case 'occupation':
          updates.occupation = value;
          break;
        case 'interests':
          updates.interests = value.split(',').map(i => i.trim());
          break;
        case 'goals':
          updates.goals = value.split(',').map(g => g.trim());
          break;
        default:
          // Store in preferences
          if (!updates.preferences) updates.preferences = {};
          updates.preferences[key] = value;
      }
    }
    
    return updates;
  }
}