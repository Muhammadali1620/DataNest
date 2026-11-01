/**
 * The InfluxDB 2.x server of the `influxdb` group (V13.20): plain HTTP, one organization
 * and one bucket, and the admin token the compose file gives it (test-only constants).
 */
export const TEST_INFLUXDB = {
  host: '127.0.0.1',
  port: 7186,
  org: 'datanest',
  bucket: 'metrics',
  token: 'datanest-test-token',
} as const;
