FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Asia/Jakarta

EXPOSE 3000

CMD ["npm", "start"]
