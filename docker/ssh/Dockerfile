# A small OpenSSH server for the SSH tunnel integration tests (ARCHITECTURE.md D17).
# Test-only credentials: user `datanest`, password `datanest`, or the key in
# test/fixtures/ssh/id_ed25519 (passphrase `datanest-key`).
FROM alpine:3.20

RUN apk add --no-cache openssh-server \
  && adduser -D -s /bin/sh datanest \
  && echo 'datanest:datanest' | chpasswd \
  && ssh-keygen -A \
  && mkdir -p /home/datanest/.ssh

COPY sshd_config /etc/ssh/sshd_config
COPY authorized_keys /home/datanest/.ssh/authorized_keys

RUN chown -R datanest:datanest /home/datanest/.ssh \
  && chmod 700 /home/datanest/.ssh \
  && chmod 600 /home/datanest/.ssh/authorized_keys

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
