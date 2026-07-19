# Dockerfile — lets Glama (glama.ai/mcp/servers) build, start, and introspect the
# Starlog MCP server so it earns a quality score. awesome-mcp-servers now requires
# that Glama score before listing, so this file is the keystone of the directory
# launch. Glama's scorer only needs the container to start and answer an MCP
# handshake over stdio; `starlog mcp` does exactly that — verified locally:
#   echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | node dist/cli.js mcp
#   → {"result":{"serverInfo":{"name":"starlog","version":"0.7.1"},...}}
#
# Starlog runs fully locally — no account, no API key needed to start. Set
# STARLOG_API_KEY to unlock the hosted search/facts tier (optional).

# ---- builder: full toolchain, produce dist/ ----
# COPY . . before `npm ci` because the build bundles the local workspace package
# @starloghq/facts-schema (packages/*), whose own `prepare` (tsc) runs during
# install — so the workspace sources must be present. Mirrors the ci.yml order.
FROM node:20-slim AS builder
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
# Drop the dev toolchain (esbuild/tsx/vitest/typescript); the 5 runtime deps
# build.mjs keeps external stay. facts-schema is already bundled into dist/.
RUN npm prune --omit=dev --ignore-scripts

# ---- runtime: prod deps + built server + local corpus, nothing else ----
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/corpus-free ./corpus-free
# stdio MCP server. The `mcp` subcommand is the same entrypoint registries use.
ENTRYPOINT ["node", "dist/cli.js", "mcp"]
