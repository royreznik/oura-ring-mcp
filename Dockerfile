# Builds the stdio server from source. MCP directories such as Glama use this to
# start the server and list its tools. For everyday use, prefer
# `npx -y @royreznik/oura-ring-mcp` (see README).
#
# Tokens are never baked into the image. To use your account, run `oura-ring-mcp auth`
# on the host, then mount the token directory:
#   docker run -i --rm -v ~/.config/oura-ring-mcp:/home/node/.config/oura-ring-mcp oura-ring-mcp
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]
