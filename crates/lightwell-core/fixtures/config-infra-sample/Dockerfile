FROM node:22 AS builder
WORKDIR /app
FROM nginx:alpine AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
