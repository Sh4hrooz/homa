FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data
ENV NODE_ENV=production PORT=3000 HOMA_DB_PATH=/app/data/homa.sqlite
EXPOSE 3000
CMD ["npm","start"]
