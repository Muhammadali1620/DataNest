/** The Kafka node of the `kafka` group (V13.23): one KRaft node, plain text, no sign-in. */
export const TEST_KAFKA = { host: '127.0.0.1', port: 7092 } as const;

/** The schema registry of the `kafka` group (V13.34): Apicurio, Confluent-compatible API. */
export const TEST_REGISTRY = { url: 'http://127.0.0.1:7081/apis/ccompat/v7' } as const;
