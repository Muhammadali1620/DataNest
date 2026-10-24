// English UI strings of the webviews; the source of keys for every other language.
export const en = {
  'ping.title': 'DataNest connection check',
  'ping.input': 'Message',
  'ping.send': 'Ping',
  'ping.waiting': 'Waiting for the extension host…',
  'ping.connected': 'Connected',
  'ping.reply': 'Reply #{0}: {1}',
  'ping.error': 'Error: {0}',
} as const;

export type MessageKey = keyof typeof en;
