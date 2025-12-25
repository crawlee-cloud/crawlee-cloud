<div align="center">
  <!-- Place Logo Here -->
  <img src="./logo.svg" width="450" alt="Crawlee Cloud Logo" />

  **The Open Source execution layer for the Apify ecosystem.**

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![Discord](https://img.shields.io/discord/1234567890?color=5865F2&label=discord)](https://discord.gg/your-invite)

</div>

---

### 🚀 What is Crawlee Cloud?

Crawlee Cloud is a self-hosted platform that lets you run **Apify Actors** on your own infrastructure. We provide an open-source implementation of the Apify API, meaning you can point the official [Apify SDK](https://sdk.apify.com) at your own servers and everything just works.

- **💸 Zero Platform Fees:** You pay only for your infrastructure (AWS, DigitalOcean, Hetzner, or bare metal).
- **🔒 Private by Design:** Your data never leaves your VPC.
- **⚡ Drop-in Compatible:** Works with existing Actors and Scrapers without code changes.

### 🛠️ Core Projects

| Project | Description |
| :--- | :--- |
| **[crawlee-cloud](https://github.com/crawlee-cloud/crawlee-cloud)** | The monorepo containing the API Server, Runner, CLI, and Dashboard. |
| **[crawlee-python](https://github.com/crawlee-cloud/crawlee-python)** | (Coming Soon) Python client compatibility layer. |

### 🌟 Getting Started

1. **Deploy the platform:**
   ```bash
   git clone https://github.com/crawlee-cloud/crawlee-cloud.git
   docker compose up -d
   ```

2. **Point your scraper:**
   ```bash
   export APIFY_API_BASE_URL="http://localhost:3000/v2"
   node main.js
   ```

### 🤝 Join the Community

We are building the future of open-source scraping infrastructure.

- [🐛 Report a Bug](https://github.com/crawlee-cloud/crawlee-cloud/issues)
- [💬 Discussions](https://github.com/crawlee-cloud/crawlee-cloud/discussions)
- [📦 Roadmap](https://github.com/orgs/crawlee-cloud/projects)

---

<div align="center">
  <sub>Built with ❤️ by the Crawlee Cloud Community</sub>
</div>