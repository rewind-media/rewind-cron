FROM node
WORKDIR /rewind/cron
COPY . .
RUN rm node_modules -rf
RUN npm run clean
RUN npm install
RUN npm run build
CMD ["npm", "run", "start"]