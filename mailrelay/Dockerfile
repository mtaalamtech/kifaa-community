FROM alpine:3.19

RUN apk add --no-cache postfix ca-certificates libsasl \
    && newaliases

COPY main.cf /etc/postfix/main.cf
COPY master.cf /etc/postfix/master.cf

# Postfix needs /var/spool/postfix owned correctly
RUN postfix check || true

EXPOSE 25

CMD ["/bin/sh", "-c", "postfix start-fg"]
