FROM eclipse-temurin:21-jre AS java

FROM node:22-slim

# Copy Java runtime from the temurin image
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY server.js ./

EXPOSE 8080
CMD ["node", "server.js"]
