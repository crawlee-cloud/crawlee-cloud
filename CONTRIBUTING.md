# Contributing to Crawlee Cloud

Thank you for your interest in contributing! We welcome contributions from everyone.

## Getting Started

1. **Fork the repository** and clone your fork
2. **Install dependencies**: `npm install`
3. **Start development**: `npm run docker:dev && npm run dev`

## Development Workflow

```bash
# Run tests
npm test

# Type checking
npm run typecheck

# Linting
npm run lint

# Build all packages
npm run build
```

## Project Structure

```
crawlee-cloud/
├── packages/
│   ├── api/        # Fastify REST API server
│   ├── runner/     # Docker-based Actor executor
│   ├── dashboard/  # Next.js web interface
│   └── cli/        # Command-line tool
├── docker/         # Docker configurations
└── docs/           # Documentation
```

## Submitting Changes

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes with clear, descriptive commits
3. Run tests and linting: `npm test && npm run lint`
4. Push and open a Pull Request

## Code Style

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Add tests for new functionality
- Update documentation as needed

## Reporting Issues

- Check existing issues before creating a new one
- Provide clear reproduction steps
- Include relevant logs and environment details

## Community

Be respectful and inclusive. We're all here to build something great together.

---

Questions? Open an issue or start a discussion. We're happy to help!
