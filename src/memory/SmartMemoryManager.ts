import loki from 'lokijs';
import { v4 as uuid } from 'uuid';
import type 藍 from '@/ai.js';
import { similarity } from '@/utils/similarity.js';
import got from 'got';
import config from '@/config.js';
import { cosineSimilarity } from '@/utils/cosine.js';

export type MemoryItem = {
  id: string;
  userId: string;
  content: string;
  importance: number; // 0.0 - 1.0
  createdAt: number;
  lastAccessed: number;
  meta?: any;
  vector?: number[] | null;
};

/**
 * SmartMemoryManager
 * -------------------
 * Very light-weight helper that stores per-user memories in LokiJS and
 * provides primitive semantic retrieval based on a simple token overlap
 * similarity metric.  It is intentionally simple so that it works out of the
 * box without additional native dependencies or external vector DBs, while
 * still leaving a clear extension point for swapping in a proper embedding
 * search when desired.
 */
export default class SmartMemoryManager {
  private ai: 藍;
  private memories: loki.Collection<MemoryItem>;

  // Gemini embed endpoint
  private readonly embedEndpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent';

  constructor(ai: 藍) {
    this.ai = ai;
    // Ensure collection exists and has an index on userId for fast lookup
    this.memories = ai.getCollection<MemoryItem>('memories', {
      indices: ['userId'],
    });
  }

  /**
   * Store a new memory arising from user interaction.
   * Very naive importance scoring for now – callers can pass their own weight.
   */
  public storeUserMessage(
    userId: string,
    content: string,
    importance: number = 0.5,
    meta?: any
  ): void {
    const text = content?.trim();
    if (!text) return;

    // Fire-and-forget async embedding fetch
    (async () => {
      let vector: number[] | null = null;
      if (config.gemini?.apiKey) {
        try {
          const res: any = await got
            .post(this.embedEndpoint, {
              searchParams: { key: config.gemini.apiKey },
              json: {
                content: {
                  parts: [{ text }],
                },
              },
              responseType: 'json',
            })
            .json();

          if (res?.embedding?.values) {
            vector = res.embedding.values as number[];
          }
        } catch (e) {
          // silently ignore embedding errors
        }
      }

      const item: MemoryItem = {
        id: uuid(),
        userId,
        content: text,
        importance: Math.min(Math.max(importance, 0), 1),
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        meta,
        vector,
      };

      this.memories.insertOne(item);
    })();
  }

  /**
   * Fetch the memories that are most relevant to the given query.
   * A very small Jaccard-style similarity is used.  Importance acts as a
   * multiplier so that LLM-flagged important memories float to the top.
   */
  public async getRelevantMemories(
    userId: string,
    query: string,
    limit = 5
  ): Promise<MemoryItem[]> {
    const userMemories = this.memories.find({ userId });
    if (userMemories.length === 0) return [];

    // Obtain query embedding (if possible)
    let queryVector: number[] | null = null;
    if (config.gemini?.apiKey) {
      try {
        const res: any = await got
          .post(this.embedEndpoint, {
            searchParams: { key: config.gemini.apiKey },
            json: {
              content: {
                parts: [{ text: query }],
              },
            },
            responseType: 'json',
          })
          .json();
        if (res?.embedding?.values) {
          queryVector = res.embedding.values as number[];
        }
      } catch (_) {
        // ignore embedding errors
      }
    }

    const scored = userMemories
      .map((m) => {
        let baseScore = similarity(query, m.content);
        if (queryVector && m.vector) {
          const cos = cosineSimilarity(queryVector, m.vector);
          baseScore = Math.max(baseScore, cos); // choose higher
        }
        const score = baseScore * (0.5 + m.importance);
        return { ...m, _score: score } as MemoryItem & { _score: number };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);

    // Touch lastAccessed so we can later purge long-unused items.
    scored.forEach((m) => {
      m.lastAccessed = Date.now();
      this.memories.update(m);
    });

    return scored;
  }

  /**
   * Optionally call this periodically to keep the DB small.
   */
  public maintainMemory(maxPerUser = 200): void {
    const users = new Set(this.memories.chain().data().map((m) => m.userId));
    users.forEach((uid) => {
      const data = this.memories
        .find({ userId: uid })
        .sort((a, b) => b.createdAt - a.createdAt);
      if (data.length > maxPerUser) {
        data.slice(maxPerUser).forEach((old) => this.memories.remove(old));
      }
    });
  }
}