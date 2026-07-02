## 🌐 Web3 Social Messaging with Built-in Payments & Community Funding

A decentralized, chat-first platform that combines **real-time messaging, token payments, and community-driven funding** into a single seamless experience.

This project reimagines how people coordinate, transact, and build together online by embedding financial actions directly into conversations. Users can send tokens as easily as messages, contribute to shared group treasuries, and fund ideas through lightweight, on-chain proposals—all without leaving the chat interface.

Built on blockchain infrastructure and modern messaging protocols, the platform bridges the gap between Web2 usability and Web3 ownership.

---

## ✨ Core Capabilities

- 💬 Real-time wallet-to-wallet messaging
- 💸 Send and receive tokens directly in chat
- 👥 Group treasuries for shared funds
- 🧾 Proposal creation and community funding
- 🗳️ Lightweight DAO-style voting
- 🤖 AI-powered insights (fraud detection, proposal analysis, smart assistants)

---

## 🎯 Vision

To create a **financial coordination layer for communities**, where communication, value exchange, and decision-making happen in one place—securely, transparently, and intelligently.

---

# 🧱 Tech Stack

## 🖥️ Frontend

- Next.js (React + TypeScript)
- TailwindCSS

---

## ⚙️ Backend

- Node.js (Express)
- WebSockets (Socket.IO)
- PostgreSQL (persistent storage)
- Redis (pub/sub, caching)

---

## 🔗 Blockchain

- Smart Contracts (Soroban)
- stellar-sdk (interaction layer)
- Event listeners for syncing on-chain activity

---

## 🤖 AI Layer

- Python (FastAPI)
- LLM APIs
- Vector DB (Weaviate)

---

## 💬 Messaging Infrastructure

- XMTP (or similar Web3 messaging protocol)
- Optional WebRTC for peer-to-peer communication

---

## 🧰 Dev Tools

- Turborepo (monorepo management)
- Docker (containerization)
- ESLint + Prettier (code quality)
- Jest / Vitest (testing)

---

# ⚙️ Getting Started

## 📦 Prerequisites

Make sure you have installed:

- Node.js (>= 18)
- pnpm
- uv (Python Package Manager)
- Stellar CLI (for Soroban Smart Contracts)
- Docker (optional but recommended)

---

## 🔧 Installation

```bash
git clone https://github.com/codebestia/clicked.git
cd clicked
pnpm install
```

---

## 🔑 Environment Setup

Create a `.env` file in the root:

```bash
cp .env.example .env
```

---

## ▶️ Running the Project

### Start all services

First, start the local database and redis container:

```bash
docker compose -f infra/docker-compose.yml up -d
```

Then, run the node apps (Web and Backend):

```bash
pnpm run dev
```

---

### Run individual apps

```bash
# Frontend
pnpm --filter web dev

# Backend API
pnpm --filter backend dev

# AI Service (FastAPI)
cd apps/ai_agent && uv run fastapi dev main.py
```

---

## 🧪 Running Tests

```bash
pnpm test
```

---

# 🤝 Contributing

We welcome contributions from developers, designers, and researchers.

---

## 📌 How to Contribute

1. Fork the repository
2. Create a new branch

   ```bash
   git checkout -b feature/your-feature-name
   ```

3. Make your changes
4. Commit your changes

   ```bash
   git commit -m "feat: add new feature"
   ```

5. Push to your fork

   ```bash
   git push origin feature/your-feature-name
   ```

6. Open a Pull Request

---

## 🧭 Contribution Guidelines

- Follow existing code style and structure
- Write clear and concise commit messages
- Add tests where necessary
- Keep PRs small and focused
- Document new features or changes

---

## 💡 Areas to Contribute

- Smart contract development
- Frontend UX improvements
- AI agent development
- Security enhancements
- Performance optimization

---

# 📜 License

MIT License

---

# 🚀 Final Note

This project is an evolving experiment in combining **messaging, finance, and governance** into a single system.

If you’re excited about the future of Web3, DAOs, and AI-powered coordination—feel free to contribute, fork, or build on top of it.
