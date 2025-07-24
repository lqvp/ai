# Personalization System Deployment Guide

## Prerequisites

### Required Services

1. **Redis** (v7.0+) - For working memory
2. **ChromaDB** (v0.4+) - For vector embeddings
3. **PostgreSQL** (v14+) - For user profiles
4. **Elasticsearch** (v8.0+) - For analytics (optional)

### Environment Setup

```bash
# Using Docker Compose
docker-compose -f docker-compose.personalization.yml up -d

# Or install individually
docker run -d --name redis -p 6379:6379 redis:7-alpine
docker run -d --name chromadb -p 8000:8000 chromadb/chroma
docker run -d --name postgres -p 5432:5432 -e POSTGRES_PASSWORD=password postgres:14
docker run -d --name elasticsearch -p 9200:9200 -e "discovery.type=single-node" elasticsearch:8.11.0
```

## Configuration

### 1. Update `example.config.toml`

```toml
[personalization]
enabled = true
redisUrl = "redis://localhost:6379"
chromaUrl = "http://localhost:8000"
postgresUrl = "postgresql://user:password@localhost/aichat"
elasticsearchUrl = "http://localhost:9200"

# Memory settings
maxMemoriesPerUser = 1000
consolidationThreshold = 100
decayRate = 0.01

# Profile settings
inferenceConfidenceThreshold = 0.7
relationshipProgressionThresholds.familiar = 10
relationshipProgressionThresholds.friend = 30
relationshipProgressionThresholds.collaborator = 100

# Conversation settings
contextWindowSize = 50
workingMemoryDuration = 86400000  # 24 hours in ms
topicSimilarityThreshold = 0.8
emotionDetectionSensitivity = 0.6
```

### 2. Install Dependencies

```bash
# Add to package.json
pnpm add ioredis chromadb pg @elastic/elasticsearch uuid

# Install
pnpm install
```

### 3. Database Initialization

```sql
-- PostgreSQL setup
CREATE DATABASE aichat;

-- The system will auto-create tables on first run
```

## Docker Compose Configuration

Create `docker-compose.personalization.yml`:

```yaml
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    restart: unless-stopped

  chromadb:
    image: chromadb/chroma:latest
    ports:
      - "8000:8000"
    volumes:
      - chroma_data:/chroma/chroma
    environment:
      - IS_PERSISTENT=TRUE
      - PERSIST_DIRECTORY=/chroma/chroma
    restart: unless-stopped

  postgres:
    image: postgres:14
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_USER=aichat
      - POSTGRES_PASSWORD=secure_password
      - POSTGRES_DB=aichat
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped

  elasticsearch:
    image: elasticsearch:8.11.0
    ports:
      - "9200:9200"
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
    volumes:
      - elasticsearch_data:/usr/share/elasticsearch/data
    restart: unless-stopped

volumes:
  redis_data:
  chroma_data:
  postgres_data:
  elasticsearch_data:
```

## Production Deployment

### 1. Environment Variables

```bash
# .env.production
REDIS_URL=redis://redis.example.com:6379
CHROMA_URL=http://chroma.example.com:8000
POSTGRES_URL=postgresql://user:pass@db.example.com/aichat
ELASTICSEARCH_URL=http://elastic.example.com:9200
GEMINI_API_KEY=your_production_key
```

### 2. Scaling Considerations

#### Redis Cluster
```yaml
# For high availability
redis-cluster:
  image: redis:7-alpine
  command: redis-server --cluster-enabled yes
  deploy:
    replicas: 6
```

#### PostgreSQL Replication
```yaml
# Primary-replica setup
postgres-primary:
  image: postgres:14
  environment:
    - POSTGRES_REPLICATION_MODE=master
    - POSTGRES_REPLICATION_USER=replicator
    - POSTGRES_REPLICATION_PASSWORD=repl_password

postgres-replica:
  image: postgres:14
  environment:
    - POSTGRES_REPLICATION_MODE=slave
    - POSTGRES_MASTER_HOST=postgres-primary
```

#### ChromaDB Scaling
```yaml
# Use external vector DB for production
# Consider Pinecone, Weaviate, or Qdrant for managed solutions
```

### 3. Monitoring

```yaml
# Add monitoring stack
prometheus:
  image: prom/prometheus
  volumes:
    - ./prometheus.yml:/etc/prometheus/prometheus.yml
  ports:
    - "9090:9090"

grafana:
  image: grafana/grafana
  ports:
    - "3000:3000"
  environment:
    - GF_SECURITY_ADMIN_PASSWORD=admin
```

## Maintenance

### 1. Automated Tasks

Create a cron job for maintenance:

```bash
# crontab -e
# Run maintenance every hour
0 * * * * /usr/bin/node /app/maintenance.js
```

`maintenance.js`:
```javascript
import { createPersonalizationEngine } from './src/modules/personalization/index.js';

async function runMaintenance() {
  const engine = createPersonalizationEngine({
    geminiApiKey: process.env.GEMINI_API_KEY
  });
  
  await engine.initialize();
  await engine.runMaintenance();
  await engine.disconnect();
}

runMaintenance().catch(console.error);
```

### 2. Backup Strategy

```bash
# PostgreSQL backup
pg_dump -h localhost -U aichat -d aichat > backup_$(date +%Y%m%d).sql

# Redis backup
redis-cli BGSAVE

# ChromaDB backup
# Copy the persist directory
tar -czf chroma_backup_$(date +%Y%m%d).tar.gz /path/to/chroma/data
```

### 3. Performance Tuning

#### Redis Configuration
```conf
# redis.conf
maxmemory 2gb
maxmemory-policy allkeys-lru
save 900 1
save 300 10
save 60 10000
```

#### PostgreSQL Tuning
```conf
# postgresql.conf
shared_buffers = 256MB
effective_cache_size = 1GB
maintenance_work_mem = 64MB
checkpoint_completion_target = 0.9
wal_buffers = 16MB
```

## Troubleshooting

### Common Issues

1. **Memory Limit Exceeded**
   ```bash
   # Increase Redis memory
   redis-cli CONFIG SET maxmemory 4gb
   ```

2. **Slow Vector Search**
   ```bash
   # Check ChromaDB index
   curl http://localhost:8000/api/v1/collections
   ```

3. **Profile Update Failures**
   ```sql
   -- Check PostgreSQL locks
   SELECT * FROM pg_locks WHERE NOT granted;
   ```

### Health Checks

```javascript
// healthcheck.js
async function checkHealth() {
  const checks = {
    redis: await checkRedis(),
    postgres: await checkPostgres(),
    chroma: await checkChroma(),
    elasticsearch: await checkElastic()
  };
  
  console.log('Health Status:', checks);
}
```

## Security

### 1. API Keys

```bash
# Generate secure keys
openssl rand -hex 32

# Store in environment
export PERSONALIZATION_API_KEY=your_generated_key
```

### 2. Network Security

```yaml
# docker-compose.yml
services:
  redis:
    networks:
      - internal
    expose:
      - "6379"
    # No ports mapping for internal services

networks:
  internal:
    driver: bridge
```

### 3. Data Encryption

```toml
# config.toml
[personalization.security]
encryptAtRest = true
encryptionKey = "${ENCRYPTION_KEY}"
```

## Migration from Old System

### 1. Data Migration Script

```javascript
// migrate.js
import { OldMemorySystem } from './old-system.js';
import { createPersonalizationEngine } from './src/modules/personalization/index.js';

async function migrate() {
  const oldSystem = new OldMemorySystem();
  const newEngine = createPersonalizationEngine({
    geminiApiKey: process.env.GEMINI_API_KEY
  });
  
  await newEngine.initialize();
  
  // Migrate user profiles
  const users = await oldSystem.getAllUsers();
  for (const user of users) {
    const oldProfile = await oldSystem.getUserData(user.id);
    // Transform and save to new system
    await newEngine.profileManager.updateProfile(user.id, transformProfile(oldProfile));
  }
  
  // Migrate memories
  // ... similar process
  
  await newEngine.disconnect();
}
```

### 2. Rollback Plan

```bash
# Keep old system running in parallel
# Use feature flags to switch between systems

# In config.toml
[features]
useNewPersonalization = false  # Switch to true when ready
```

## Performance Benchmarks

### Expected Performance

- Message processing: < 500ms (p95)
- Memory search: < 100ms
- Profile updates: < 50ms
- Concurrent users: 10,000+

### Load Testing

```bash
# Using k6
k6 run loadtest.js

# loadtest.js
import http from 'k6/http';
import { check } from 'k6';

export let options = {
  stages: [
    { duration: '5m', target: 100 },
    { duration: '10m', target: 100 },
    { duration: '5m', target: 0 },
  ],
};

export default function() {
  let response = http.post('http://localhost:3000/api/chat', {
    userId: 'test_user',
    message: 'Hello AI'
  });
  
  check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
}
```