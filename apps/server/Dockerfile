FROM node:22-alpine
WORKDIR /app/apps/server
COPY apps/server/package*.json ./
RUN npm install
COPY apps/server ./
COPY data /app/data
RUN npm run build
EXPOSE 4000
CMD ["npm", "run", "start"]
