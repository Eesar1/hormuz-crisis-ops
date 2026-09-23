FROM node:22-alpine
WORKDIR /app
COPY apps/web/package*.json ./
RUN npm install
COPY apps/web ./
ARG NEXT_PUBLIC_SERVER_URL=http://localhost:4000
ENV NEXT_PUBLIC_SERVER_URL=$NEXT_PUBLIC_SERVER_URL
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "start"]
