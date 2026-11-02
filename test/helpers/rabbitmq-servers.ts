/**
 * The RabbitMQ node of the `rabbitmq` group (V13.26): the management plugin's HTTP API,
 * with a user of the tests' own because `guest` may only sign in from the machine itself.
 * The credentials are test-only constants, like those of the other groups.
 */
export const TEST_RABBITMQ = {
  host: '127.0.0.1',
  port: 7156,
  /** The AMQP port, published for the helper that plays a client (V13.28). */
  amqpPort: 7158,
  user: 'datanest',
  password: 'datanest-test-password',
} as const;
