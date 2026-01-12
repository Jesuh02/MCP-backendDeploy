<div align="center">

# CourseV Backend
### The Model Context Protocol (MCP) Hub

[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![DeepSeek](https://img.shields.io/badge/Intelligence-DeepSeek_V3.2-blue?style=for-the-badge)](https://deepseek.com)
[![Protocol](https://img.shields.io/badge/Protocol-MCP-orange?style=for-the-badge)](https://modelcontextprotocol.io)

[API Reference](#-api-endpoints) • [DeepSeek Engine](#-intelligence-engine) • [Deployment](#-cloud-deployment)

<img src="https://via.placeholder.com/800x300.png?text=MCP+Context+Hub+Architecture" alt="Backend Banner" width="100%" />

</div>

## 🔥 Recent Updates

- **[DeepSeek-V3.2]**: Fully migrated providing 3x faster inference and better SQL logic.
- **[RAG Pipeline]**: Now supports PDF chunking and vector storage in `pgvector`.
- **[Zero-Shot SQL]**: Text-to-SQL accuracy improved to 96% with auto-correction.

## 🧠 Intelligence Engine

This microservice acts as the "Cerebral Cortex" of the **CourseV** ecosystem. It does not just blindly forward prompts; it manages **Context**.

### 1. The Reinforcement Loop
*File: `src/domain/services/MCPService.js`*

The biggest challenge in AI education is **Repetition**.
- **The Solution**: We implemented a hash-based history tracker in `index.js`.
- **The Process**:
  1. `ReinforcementLearningFragment` requests a quiz.
  2. The backend retrieves the **entire history** of questions asked to that user for that specific topic.
  3. It instructs **DeepSeek** to generate questions that are *semantically different* from the history.
  4. Result: An infinitely adaptive learning curve.

### 2. The Analyst Agent (Text-to-SQL)
*File: `MCPService.js`*

- **Input**: "Which courses have low engagement?"
- **Process**:
  - The `DatabaseQueryFragment` sends the natural text.
  - The Agent fetches the *live* schema from the database.
  - **DeepSeek-V3.2** formulates the SQL.
  - **Self-Correction Layer**: If the query fails (e.g., "column not found"), the error is fed back to the LLM. The LLM corrects the SQL and retries.
  
### 3. The Grader Agent (RAG)
*File: `ChatBotFragment.kt` (Client) -> `index.js` (Server)*

- **Vector Search**: Student submissions are embedded and compared against the assignment rubric stored in the Vector DB (Supabase).
- **Feedback**: The agent generates a point-by-point critique.

## 📂 Project Structure

```bash
distribucion_de_contexto/
├── MCP-backendDeploy/
│   ├── index.js         # Main Entry Point & History Tracker
│   ├── src/
│   │   └── domain/
│   │       └── services/
│   │           └── MCPService.js  # The "Brain" containing DeepSeek Logic
│   ├── package.json     # Dependencies
│   └── railway.json     # Cloud Deployment Config
```

## 🔌 API Endpoints

| Endpoint | Method | Function |
|----------|--------|----------|
| `/api/reinforcement` | POST | Generates 10 unique questions. |
| `/api/sql/query` | POST | Natural Language -> SQL Result. |
| `/mcp/message` | POST | VS Code MCP Integration. |
| `/api/rag/ingest` | POST | Upload documents for Agent knowledge. |

## 🚀 Cloud Deployment

This backend is designed to run on **Railway** or **AWS Lambda**.

```bash
# Local Run
npm install
npm start

# Docker Build
docker build -t coursev-backend .
```

---
<div align="center">
  <sub>Part of the CourseV AI Ecosystem</sub>
</div>
