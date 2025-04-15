# Dockerfile

# Use an official Node.js runtime as a parent image (Alpine for smaller size)
FROM node:20-alpine AS base

# Set the working directory in the container
WORKDIR /usr/src/app

# Install base dependencies if needed (alpine specific)
# RUN apk add --no-cache <needed-packages>

# Create a non-root user and group for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy package.json and package-lock.json (or yarn.lock) first
# This leverages Docker cache layers
COPY package*.json ./

# Install app dependencies
# Using 'ci' is generally recommended for reproducible builds if you have package-lock.json
# RUN npm ci --only=production
# Or use install if you don't commit lock files or need devDeps sometimes
RUN npm install

# Copy the rest of the application source code
COPY ./src ./src

# Change ownership of app files to the non-root user
RUN chown -R appuser:appgroup .

# Switch to the non-root user
USER appuser

# Expose the port the app runs on (from config, default 3000)
EXPOSE 3000

# Define the command to run the application using the start script
CMD [ "npm", "start" ]
