FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/proofpay.db
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src/ml/model.json ./src/ml/model.json
COPY public ./public
COPY apimatic ./apimatic
VOLUME /data
EXPOSE 8080
CMD ["npm", "start"]
