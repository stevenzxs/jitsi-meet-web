FROM node:24-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
ARG VITE_JITSI_SERVER
ARG VITE_API_BASE_URL=
ARG VITE_API_PREFIX=/mapi
ARG VITE_PREJOIN_ENABLED=false
ARG VITE_DESKTOP_PROTOCOL=cloudmeet

ENV VITE_JITSI_SERVER=$VITE_JITSI_SERVER \
    VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_API_PREFIX=$VITE_API_PREFIX \
    VITE_PREJOIN_ENABLED=$VITE_PREJOIN_ENABLED \
    VITE_DESKTOP_PROTOCOL=$VITE_DESKTOP_PROTOCOL

# 小内存机器（2G）防 OOM：限制 vite 构建堆内存
ENV NODE_OPTIONS=--max-old-space-size=1024

RUN npm run build

FROM nginx:1.30.6-alpine@sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/cm/

EXPOSE 80
