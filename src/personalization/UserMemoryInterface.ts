import { bindThis } from '@/decorators.js';
import {
  Memory,
  MemoryType,
  UserProfile,
  MemoryQuery,
  CommandResult,
  PersonalizationError,
  PersonalizationErrorCode
} from './types.js';
import HybridMemorySystem from './HybridMemorySystem.js';
import UserProfileManager from './UserProfileManager.js';

/**
 * ユーザー記憶インターフェース
 * ユーザーが個人データと記憶を制御できる機能を提供
 */
export default class UserMemoryInterface {
  // コマンドパターン（複数言語対応）
  private readonly COMMANDS = {
    SHOW_MEMORIES: /^(memories?|記憶|思い出)\s*(.*)$/i,
    FORGET: /^(forget|忘れる|忘却)\s+(.+)$/i,
    UPDATE_INFO: /^(update_info|情報更新|update)\s+(.+)$/i,
    SHOW_PROFILE: /^(profile|プロフィール|prof)$/i,
    EXPORT_DATA: /^(export_data|データエクスポート|export)$/i,
    DELETE_ALL: /^(delete_all_data|全データ削除|delete_all)$/i,
    HELP: /^(help|ヘルプ|h|\?)$/i
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
  ): Promise<CommandResult> {
    // Validate input
    if (!userId || !command) {
      return {
        success: false,
        message: '無効な入力です。'
      };
    }

    // Check for memory-related commands
    for (const [cmdName, pattern] of Object.entries(this.COMMANDS)) {
      const match = command.match(pattern);
      if (match) {
        try {
          switch (cmdName) {
            case 'SHOW_MEMORIES':
              return await this.showMemories(userId, match[2] || '');
            
            case 'FORGET':
              // Ensure there's an argument for forget command
              if (!match[2] || !match[2].trim()) {
                return {
                  success: false,
                  message: '忘れる対象を指定してください。'
                };
              }
              return await this.forgetMemory(userId, match[2].trim());
            
            case 'UPDATE_INFO':
              // Ensure there's an argument for update command
              if (!match[2] || !match[2].trim()) {
                return {
                  success: false,
                  message: '更新する情報を指定してください。'
                };
              }
              return await this.updateInfo(userId, match[2].trim());
            
            case 'SHOW_PROFILE':
              return await this.showProfile(userId);
            
            case 'EXPORT_DATA':
              return await this.exportUserData(userId);
            
            case 'DELETE_ALL':
              return await this.deleteAllData(userId);
            
            case 'HELP':
              return this.showHelp();
          }
        } catch (error) {
          console.error(`Error processing command ${cmdName}:`, error);
          return {
            success: false,
            message: 'コマンドの処理中にエラーが発生しました。'
          };
        }
      }
    }
    
          return {
        success: false,
        message: 'コマンドが認識されませんでした。help または ヘルプ で利用可能なコマンドを確認してください。'
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
          message: '条件に一致する記憶が見つかりませんでした。'
        };
      }
      
      // Format memories for display
      const formattedMemories = memories.map((memory, index) => 
        this.formatMemory(memory, index + 1)
      ).join('\n\n');
      
      const message = `📚 **あなたの記憶** (全${stats.total}件中${memories.length}件)\n\n${formattedMemories}\n\n` +
        `📊 **統計**\n` +
        `- 総記憶数: ${stats.total}\n` +
        `- エピソード記憶: ${stats.byType.episodic}\n` +
        `- 意味記憶: ${stats.byType.semantic}\n` +
        `- 平均重要度: ${(stats.averageImportance * 100).toFixed(1)}%`;
      
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
          message: `"${searchTerm}"を含む記憶が見つかりませんでした`
        };
      }
      
      // If multiple memories found, ask for confirmation
      if (memories.length > 1) {
        const preview = memories.slice(0, 3).map((m, i) => 
          `${i + 1}. ${m.content.substring(0, 50)}...`
        ).join('\n');
        
        return {
          success: false,
          message: `"${searchTerm}"を含む記憶が${memories.length}件見つかりました:\n${preview}\n\n` +
            `より具体的に指定するか、記憶IDを使用してください。`
        };
      }
      
      // Delete the memory
      await this.memorySystem.deleteMemories(userId, [memories[0].id]);
      
      return {
        success: true,
        message: `✅ 記憶を忘れました: "${memories[0].content.substring(0, 100)}..."`
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
          message: '無効な更新形式です。使用例: update_info name=太郎 interests=プログラミング,音楽'
        };
      }
      
      // Update profile
      await this.profileManager.addExplicitInfo(userId, updates);
      
      const updatedFields = Object.keys(updates).join(', ');
      return {
        success: true,
        message: `✅ 更新しました: ${updatedFields}`
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
        message: '📦 データのエクスポート準備が完了しました。このJSONデータを保存できます。',
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
        message: '🗑️ すべての個人データが完全に削除されました。'
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
📖 **記憶管理コマンド**

**データの確認:**
• \`memories\` / \`記憶\` / \`思い出\` [フィルター] - 保存された記憶を表示
  - 例: \`memories\`, \`記憶 最近\`, \`memories recent\`
• \`profile\` / \`プロフィール\` / \`prof\` - ユーザープロフィールを表示
• \`export_data\` / \`データエクスポート\` / \`export\` - すべてのデータをJSON形式でエクスポート

**データの管理:**
• \`forget\` / \`忘れる\` / \`忘却\` <検索語> - 特定の記憶を削除
  - 例: \`forget password\`, \`忘れる プロジェクトの締切\`
• \`update_info\` / \`情報更新\` / \`update\` <フィールド=値> - 情報を更新
  - 例: \`update_info name=太郎 interests=音楽,アート\`
• \`delete_all_data\` / \`全データ削除\` / \`delete_all\` - すべてのデータを完全に削除

**情報更新で使用可能なフィールド:**
• name/名前, age/年齢, location/場所, occupation/職業
• interests/興味 (カンマ区切り)
• goals/目標 (カンマ区切り)
• preferences/設定 (キー=値のペア)

**プライバシーに関するお知らせ:**
あなたのデータは安全に保存され、完全に管理できます。これらのコマンドを使用して、私が覚えている内容を管理してください。
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
    
    return `**${index}.** [${type}] ${date} (重要度: ${importance})\n` +
      `   ${memory.content.substring(0, 150)}${memory.content.length > 150 ? '...' : ''}\n` +
      `   タグ: ${memory.metadata.tags.join(', ') || 'なし'}`;
  }

  private formatProfile(profile: UserProfile): string {
    const { explicit, implicit, relationship, meta } = profile;
    
    let message = '👤 **あなたのプロフィール**\n\n';
    
    // 明示的情報
    message += '**基本情報:**\n';
    if (explicit.name) message += `• 名前: ${explicit.name}\n`;
    if (explicit.age) message += `• 年齢: ${explicit.age}\n`;
    if (explicit.location) message += `• 場所: ${explicit.location}\n`;
    if (explicit.occupation) message += `• 職業: ${explicit.occupation}\n`;
    if (explicit.interests.length > 0) message += `• 興味: ${explicit.interests.join(', ')}\n`;
    if (explicit.goals.length > 0) message += `• 目標: ${explicit.goals.join(', ')}\n`;
    
    // 関係性情報
    message += '\n**私たちの関係:**\n';
    message += `• レベル: ${this.formatRelationshipLevel(relationship.level)}\n`;
    message += `• 総対話数: ${relationship.totalInteractions}\n`;
    message += `• 信頼スコア: ${(relationship.trustScore * 100).toFixed(0)}%\n`;
    message += `• 初回対話: ${new Date(relationship.firstInteraction).toLocaleDateString()}\n`;
    
    // 推論された情報（高い確信度の場合）
    if (implicit.communicationStyle) {
      message += '\n**コミュニケーションスタイル:**\n';
      message += `• 好みのスタイル: ${implicit.communicationStyle}\n`;
    }
    
    if (implicit.expertise.length > 0) {
      message += `• 専門分野: ${implicit.expertise.join(', ')}\n`;
    }
    
    // データ品質
    message += `\n**プロフィール品質:** ${this.formatDataQuality(meta.dataQuality)}`;
    
    return message;
  }

  private formatRelationshipLevel(level: string): string {
    const levelMap: Record<string, string> = {
      'new_user': '🆕 新規ユーザー',
      'acquaintance': '👋 知り合い',
      'familiar': '🤝 親しい',
      'friend': '😊 友人',
      'collaborator': '🌟 親密な協力者'
    };
    return levelMap[level] || level;
  }

  private formatDataQuality(quality: string): string {
    const qualityMap: Record<string, string> = {
      'low': '📊 低 (改善のために情報を追加してください)',
      'medium': '📊📊 中 (良い基盤)',
      'high': '📊📊📊 高 (包括的なプロフィール)'
    };
    return qualityMap[quality] || quality;
  }

  private parseMemoryFilters(filterString: string): MemoryQuery['filters'] {
    const filters: MemoryQuery['filters'] = {};
    
    if (!filterString) return filters;
    
          // 一般的なフィルターキーワードを解析
      if (filterString.includes('最近')) {
        filters.dateRange = {
          start: Date.now() - 7 * 24 * 60 * 60 * 1000, // 過去7日間
          end: Date.now()
        };
      }
      
      if (filterString.includes('重要')) {
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
        case '名前':
        case 'name':
          updates.name = value;
          break;
        case '年齢':
        case 'age':
          updates.age = parseInt(value);
          break;
        case '場所':
        case 'location':
          updates.location = value;
          break;
        case '職業':
        case 'occupation':
          updates.occupation = value;
          break;
        case '興味':
        case 'interests':
          updates.interests = value.split(',').map(i => i.trim());
          break;
        case '目標':
        case 'goals':
          updates.goals = value.split(',').map(g => g.trim());
          break;
        default:
          // 設定に保存
          if (!updates.preferences) updates.preferences = {};
          updates.preferences[key] = value;
      }
    }
    
    return updates;
  }
}