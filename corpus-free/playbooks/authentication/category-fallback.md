# Authentication category fallback

- Inventory all DIY auth modules (routes, middleware, utils, DB models)
- Choose a ranked safe alternative and vet with starlog_facts
- Run a parallel auth path behind a feature flag before cutover
- Migrate sessions/tokens; never reuse DIY signing keys
- Delete dead auth code and rotate exposed secrets
- Add integration tests for login, logout, refresh, and protected routes
