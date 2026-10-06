# echo-scraper

Fixture actor for the MCP e2e harness (`tests/mcp-e2e`). It does no scraping.

Input:

- `query` (string, required): echoed into each item's title.
- `maxItems` (integer, default 3): number of items pushed to the default dataset.
- `sleepSecs` (integer, default 0): seconds to sleep after pushing items.

Output: `maxItems` dataset items `{ rank, title, price }` and an `OUTPUT` record
`{ query, itemCount }` in the default key-value store.
