FROM node:20-alpine AS build

WORKDIR /app

ARG VITE_API_URL=http://localhost:4000
ARG VITE_RECAPTCHA_SITE_KEY=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_RECAPTCHA_SITE_KEY=$VITE_RECAPTCHA_SITE_KEY

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

RUN chown -R nginx:nginx /var/cache/nginx /var/run /var/log/nginx /usr/share/nginx/html /etc/nginx/conf.d

EXPOSE 8080

USER nginx

CMD ["nginx", "-g", "daemon off;"]
