# Hono Authentication Gateway Dockerfile
# Multi-stage build for production deployment

# Build stage
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Build the application
RUN npm run build

# Production stage
FROM node:18-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S hono -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy any additional config files
COPY config/ ./config/

# Change ownership to app user
RUN chown -R hono:nodejs /app
USER hono

# Expose port
EXPOSE 8787

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "
    const http = require('http');
    const options = {
      host: 'localhost',
      port: 8787,
      path: '/health',
      timeout: 5000,
    };
    const request = http.request(options, (res) => {
      console.log('Health check status:', res.statusCode);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
    request.on('error', (err) => {
      console.error('Health check failed:', err);
      process.exit(1);
    });
    request.end();
  "

# Set environment
ENV NODE_ENV=production
ENV PORT=8787

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/index.js"]

# Development stage (for local development)
FROM node:18-alpine AS development

WORKDIR /app

# Install all dependencies (including dev dependencies)
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Expose port
EXPOSE 8787

# Development command
CMD ["npm", "run", "dev"]

# Multi-architecture build metadata
LABEL org.opencontainers.image.title="Hono Authentication Gateway"
LABEL org.opencontainers.image.description="Authentication gateway and proxy service for Convex backend"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.vendor="Your Organization"
LABEL org.opencontainers.image.source="https://github.com/yourusername/hono-auth-gateway"
LABEL org.opencontainers.image.documentation="https://github.com/yourusername/hono-auth-gateway/blob/main/README.md"