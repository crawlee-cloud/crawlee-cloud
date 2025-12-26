# Crawlee Cloud Roadmap

This document outlines planned features and improvements for Crawlee Cloud.

## Current Version: v0.1.0 ✅

- Apify-compatible REST API
- Docker-based Actor execution
- Dashboard for monitoring
- CLI for deployment
- Datasets, Key-Value Stores, Request Queues

---

## v0.2.0 - User Management & Security

- [ ] **Invite-only user registration** - Admin invites users via email
- [ ] **Role-based access control** - Admin, Developer, Viewer roles
- [ ] **API key scopes** - Fine-grained permissions per key
- [ ] **Audit logging** - Track user actions
- [ ] **Password reset flow**

## v0.3.0 - Scheduling & Webhooks

- [ ] **Cron scheduling** - Schedule Actor runs with cron expressions
- [ ] **Webhooks** - HTTP callbacks on run completion
- [ ] **Retry policies** - Automatic retries with backoff
- [ ] **Run timeout configuration**
- [ ] **Email notifications**

## v0.4.0 - Scaling & Performance

- [ ] **Multi-worker support** - Horizontal scaling of runners
- [ ] **Resource quotas** - Limit CPU/memory per user
- [ ] **Priority queues** - High-priority Actor runs
- [ ] **Run history retention policies**
- [ ] **Metrics & monitoring** - Prometheus/Grafana integration

## v0.5.0 - Developer Experience

- [ ] **Actor templates** - Quick-start boilerplate code
- [ ] **Web IDE** - Edit Actors directly in dashboard
- [ ] **Live log streaming** - WebSocket-based real-time logs
- [ ] **Input schema validation** - JSON Schema for Actor inputs
- [ ] **Actor versioning** - Deploy specific versions

## v1.0.0 - Production Ready

- [ ] **High availability** - Multi-region deployment support
- [ ] **Backup & restore** - Automated database backups
- [ ] **SSL/TLS** - Built-in certificate management
- [ ] **Helm chart** - Easy Kubernetes deployment
- [ ] **Documentation site** - Comprehensive docs portal

---

## Future Ideas 💡

- **Proxy management** - Built-in proxy rotation
- **Fingerprint browser actors** - Anti-detection support
- **Actor marketplace** - Share and discover community Actors
- **Plugin system** - Extend platform functionality
- **GraphQL API** - Alternative to REST endpoints

---

## Contributing

Have ideas? Open an issue or discussion on GitHub!

We prioritize features based on community feedback.
